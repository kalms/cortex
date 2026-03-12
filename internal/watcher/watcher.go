package watcher

import (
	"bytes"
	"context"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/DeusData/codebase-memory-mcp/internal/discover"
	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// watchStrategy determines how the watcher detects file changes for a project.
type watchStrategy int

const (
	strategyAuto     watchStrategy = iota // auto-detect at first poll
	strategyGit                           // git status + HEAD tracking
	strategyFSNotify                      // fsnotify event-driven
	strategyDirMtime                      // directory mtime polling (fallback)
)

func (s watchStrategy) String() string {
	switch s {
	case strategyGit:
		return "git"
	case strategyFSNotify:
		return "fsnotify"
	case strategyDirMtime:
		return "dirmtime"
	default:
		return "auto"
	}
}

const (
	baseInterval         = 5 * time.Second
	maxInterval          = 60 * time.Second
	fullSnapshotInterval = 5 // polls between forced full snapshots
	projectsCacheTTL     = 60 * time.Second
)

type fileSnapshot struct {
	modTime time.Time
	size    int64
}

type projectState struct {
	snapshot       map[string]fileSnapshot
	pollsSinceFull int
	interval       time.Duration
	nextPoll       time.Time

	// Strategy (set during baseline, may downgrade at runtime).
	strategy watchStrategy

	// Git strategy state.
	lastGitHead string

	// FSNotify strategy state.
	fsWatcher *fsnotify.Watcher
	fsChanged atomic.Bool
	fsCancel  context.CancelFunc
	fsDone    chan struct{} // closed when drainFSEvents exits

	// Dir-mtime strategy state.
	dirMtimes map[string]time.Time
}

// close releases per-project resources (fsnotify watcher, goroutines).
func (ps *projectState) close() {
	if ps.fsCancel != nil {
		ps.fsCancel()
	}
	if ps.fsWatcher != nil {
		ps.fsWatcher.Close()
	}
	if ps.fsDone != nil {
		<-ps.fsDone // wait for drain goroutine to exit
	}
	ps.fsCancel = nil
	ps.fsWatcher = nil
	ps.fsDone = nil
}

// IndexFunc is the callback signature for triggering a re-index.
type IndexFunc func(ctx context.Context, projectName, rootPath string) error

// Watcher polls indexed projects for file changes and triggers re-indexing.
// Change detection uses a 3-tier strategy per project:
//
//  1. Git — git status + HEAD tracking (for git repos)
//  2. FSNotify — event-driven via OS file notifications (for non-git dirs)
//  3. Dir-mtime — directory mtime polling (fallback if fsnotify setup fails)
type Watcher struct {
	router            *store.StoreRouter
	indexFn           IndexFunc
	projects          map[string]*projectState
	ctx               context.Context
	cachedProjects    []*store.ProjectInfo
	projectsCacheTime time.Time

	// testStrategy overrides auto-detection when non-zero (for tests).
	testStrategy watchStrategy
}

// New creates a Watcher. indexFn is called when file changes are detected.
func New(r *store.StoreRouter, indexFn IndexFunc) *Watcher {
	w := &Watcher{
		router:   r,
		indexFn:  indexFn,
		projects: make(map[string]*projectState),
		ctx:      context.Background(),
	}
	// Wire invalidation: when a project is deleted, clear the cache immediately.
	r.OnDelete(func(_ string) { w.InvalidateProjectsCache() })
	return w
}

// InvalidateProjectsCache forces the next pollAll to re-query ListProjects.
func (w *Watcher) InvalidateProjectsCache() {
	w.projectsCacheTime = time.Time{}
}

// Run blocks until ctx is cancelled. Ticks at baseInterval, polling each
// project only when its adaptive interval has elapsed.
func (w *Watcher) Run(ctx context.Context) {
	w.ctx = ctx
	ticker := time.NewTicker(baseInterval)
	defer ticker.Stop()
	defer w.closeAll()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.pollAll()
		}
	}
}

// closeAll releases resources for all tracked projects.
func (w *Watcher) closeAll() {
	for _, state := range w.projects {
		state.close()
	}
}

// pollAll lists all indexed projects and polls each that is due.
// Prunes watcher state for projects that no longer exist.
func (w *Watcher) pollAll() {
	// Cache ListProjects to avoid repeated ReadDir+SQLite queries.
	if time.Since(w.projectsCacheTime) > projectsCacheTTL {
		infos, err := w.router.ListProjects()
		if err != nil {
			slog.Warn("watcher.list_projects", "err", err)
			return
		}
		w.cachedProjects = infos
		w.projectsCacheTime = time.Now()
	}
	projectInfos := w.cachedProjects

	// Prune stale entries.
	activeNames := make(map[string]struct{}, len(projectInfos))
	for _, info := range projectInfos {
		activeNames[info.Name] = struct{}{}
	}
	for name, state := range w.projects {
		if _, ok := activeNames[name]; !ok {
			slog.Info("watcher.prune", "project", name)
			state.close()
			delete(w.projects, name)
		}
	}

	now := time.Now()
	for _, info := range projectInfos {
		state, exists := w.projects[info.Name]
		if exists && now.Before(state.nextPoll) {
			continue // not due yet
		}

		// AcquireStore increments refs so the evictor can't close mid-query.
		st, release, stErr := w.router.AcquireStore(info.Name)
		if stErr != nil {
			continue
		}
		proj, projErr := st.GetProject(info.Name)
		release()
		if projErr != nil || proj == nil {
			continue
		}

		if !exists {
			state = &projectState{}
			w.projects[info.Name] = state
		}

		w.pollProject(proj, state)
	}
}

// --- Strategy probing ---

// probeStrategy determines the best change detection strategy for a project.
// Order: git → fsnotify → dirmtime.
func (w *Watcher) probeStrategy(ctx context.Context, rootPath string) watchStrategy {
	if w.testStrategy != strategyAuto {
		return w.testStrategy
	}
	if isGitRepo(ctx, rootPath) {
		return strategyGit
	}
	// FSNotify is the intent; actual setup may fail → falls back in initBaseline.
	return strategyFSNotify
}

// --- Core poll logic ---

func (w *Watcher) pollProject(proj *store.Project, state *projectState) {
	if _, err := os.Stat(proj.RootPath); err != nil {
		slog.Warn("watcher.root_gone", "project", proj.Name, "path", proj.RootPath)
		state.nextPoll = time.Now().Add(maxInterval)
		return
	}

	// First poll — capture baseline and select strategy.
	if state.snapshot == nil {
		w.initBaseline(proj, state)
		return
	}

	state.pollsSinceFull++

	// Check sentinel based on strategy.
	changed, strategyFailed := w.checkSentinel(proj, state)

	if strategyFailed {
		w.downgradeStrategy(proj, state)
		changed, _ = w.checkSentinel(proj, state)
	}

	// Git sentinel catches everything — no forced full snapshot needed.
	// FSNotify + dir-mtime may miss in-place edits, so force periodically.
	forceFull := state.strategy != strategyGit && state.pollsSinceFull >= fullSnapshotInterval

	if !changed && !forceFull {
		state.nextPoll = time.Now().Add(state.interval)
		return
	}

	w.fullSnapshotAndIndex(proj, state)
}

func (w *Watcher) initBaseline(proj *store.Project, state *projectState) {
	snap, err := captureSnapshot(w.ctx, proj.RootPath)
	if err != nil {
		slog.Warn("watcher.snapshot", "project", proj.Name, "err", err)
		state.nextPoll = time.Now().Add(baseInterval)
		return
	}

	state.snapshot = snap
	state.pollsSinceFull = 0
	state.interval = pollInterval(len(snap))
	state.nextPoll = time.Now().Add(state.interval)

	// Select and initialize strategy.
	state.strategy = w.probeStrategy(w.ctx, proj.RootPath)

	switch state.strategy {
	case strategyGit:
		head, _ := gitHead(w.ctx, proj.RootPath)
		state.lastGitHead = head
		slog.Debug("watcher.baseline", "project", proj.Name, "strategy", "git", "files", len(snap))

	case strategyFSNotify:
		if err := w.initFSNotify(state, proj.RootPath); err != nil {
			slog.Debug("watcher.fsnotify.fallback", "project", proj.Name, "err", err)
			state.strategy = strategyDirMtime
			state.dirMtimes, _ = checkDirMtimes(w.ctx, proj.RootPath)
			slog.Debug("watcher.baseline", "project", proj.Name, "strategy", "dirmtime", "files", len(snap), "dirs", len(state.dirMtimes))
		} else {
			slog.Debug("watcher.baseline", "project", proj.Name, "strategy", "fsnotify", "files", len(snap))
		}

	case strategyDirMtime:
		state.dirMtimes, _ = checkDirMtimes(w.ctx, proj.RootPath)
		slog.Debug("watcher.baseline", "project", proj.Name, "strategy", "dirmtime", "files", len(snap), "dirs", len(state.dirMtimes))
	}
}

// checkSentinel returns (changed, strategyFailed).
func (w *Watcher) checkSentinel(proj *store.Project, state *projectState) (changed, strategyFailed bool) {
	switch state.strategy {
	case strategyGit:
		changed, newHead, err := gitSentinel(w.ctx, proj.RootPath, state.lastGitHead)
		if err != nil {
			slog.Warn("watcher.git.err", "project", proj.Name, "err", err)
			return false, true
		}
		state.lastGitHead = newHead
		return changed, false

	case strategyFSNotify:
		return state.fsChanged.CompareAndSwap(true, false), false

	case strategyDirMtime:
		dirMtimes, _ := checkDirMtimes(w.ctx, proj.RootPath)
		changed := !dirMtimesEqual(state.dirMtimes, dirMtimes)
		state.dirMtimes = dirMtimes
		return changed, false

	default:
		return false, true
	}
}

// downgradeStrategy moves to the next fallback tier.
func (w *Watcher) downgradeStrategy(proj *store.Project, state *projectState) {
	old := state.strategy
	switch old {
	case strategyGit:
		// Try fsnotify, then dir-mtime.
		state.strategy = strategyFSNotify
		if err := w.initFSNotify(state, proj.RootPath); err != nil {
			state.strategy = strategyDirMtime
			state.dirMtimes, _ = checkDirMtimes(w.ctx, proj.RootPath)
		}
	case strategyFSNotify:
		state.close()
		state.strategy = strategyDirMtime
		state.dirMtimes, _ = checkDirMtimes(w.ctx, proj.RootPath)
	default:
		return // already at bottom tier
	}
	slog.Info("watcher.strategy.downgrade", "project", proj.Name, "from", old.String(), "to", state.strategy.String())
}

func (w *Watcher) fullSnapshotAndIndex(proj *store.Project, state *projectState) {
	snap, err := captureSnapshot(w.ctx, proj.RootPath)
	if err != nil {
		slog.Warn("watcher.snapshot", "project", proj.Name, "err", err)
		state.nextPoll = time.Now().Add(state.interval)
		return
	}

	interval := pollInterval(len(snap))
	state.pollsSinceFull = 0

	if snapshotsEqual(state.snapshot, snap) {
		state.interval = interval
		state.nextPoll = time.Now().Add(interval)
		return
	}

	slog.Info("watcher.changed", "project", proj.Name, "strategy", state.strategy.String(), "files", len(snap))
	if err := w.indexFn(w.ctx, proj.Name, proj.RootPath); err != nil {
		slog.Warn("watcher.index", "project", proj.Name, "err", err)
		state.nextPoll = time.Now().Add(interval)
		return
	}

	state.snapshot = snap
	state.interval = pollInterval(len(snap))
	state.nextPoll = time.Now().Add(state.interval)

	// Update git HEAD after successful index.
	if state.strategy == strategyGit {
		if head, err := gitHead(w.ctx, proj.RootPath); err == nil {
			state.lastGitHead = head
		}
	}
}

// --- Git sentinel ---

// isGitRepo checks if rootPath is inside a git repository.
func isGitRepo(ctx context.Context, rootPath string) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", rootPath, "rev-parse", "--git-dir")
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run() == nil
}

// gitHead returns the current HEAD commit hash.
func gitHead(ctx context.Context, rootPath string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", rootPath, "rev-parse", "HEAD")
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// gitSentinel checks for working tree changes or HEAD movement since lastHead.
func gitSentinel(ctx context.Context, rootPath, lastHead string) (changed bool, newHead string, err error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	head, err := gitHead(ctx, rootPath)
	if err != nil {
		return false, "", err
	}
	if lastHead != "" && head != lastHead {
		return true, head, nil // HEAD moved (commit, checkout, pull)
	}

	// Check working tree.
	cmd := exec.CommandContext(ctx, "git", "--no-optional-locks", "-C", rootPath,
		"status", "--porcelain", "--untracked-files=normal")
	out, err := cmd.Output()
	if err != nil {
		return false, head, err
	}
	return len(bytes.TrimSpace(out)) > 0, head, nil
}

// --- FSNotify sentinel ---

// initFSNotify sets up an fsnotify watcher for all directories under rootPath.
// Starts a drain goroutine that sets state.fsChanged on events.
func (w *Watcher) initFSNotify(state *projectState, rootPath string) error {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}

	walkErr := filepath.WalkDir(rootPath, func(path string, d fs.DirEntry, walkDirErr error) error {
		if walkDirErr != nil {
			return walkDirErr
		}
		if !d.IsDir() {
			return nil
		}
		name := d.Name()
		if name == ".git" || name == "node_modules" || name == "__pycache__" || name == ".venv" || name == "vendor" {
			return filepath.SkipDir
		}
		if addErr := fsw.Add(path); addErr != nil {
			return addErr // FD limit or other OS error → fall back
		}
		return nil
	})
	if walkErr != nil {
		fsw.Close()
		return walkErr
	}

	ctx, cancel := context.WithCancel(w.ctx)
	done := make(chan struct{})
	state.fsWatcher = fsw
	state.fsCancel = cancel
	state.fsDone = done
	go drainFSEvents(ctx, fsw, &state.fsChanged, done)
	return nil
}

// drainFSEvents reads fsnotify events and sets the changed flag.
// Exits when ctx is cancelled or the watcher is closed.
func drainFSEvents(ctx context.Context, fsw *fsnotify.Watcher, changed *atomic.Bool, done chan struct{}) {
	defer close(done)
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-fsw.Events:
			if !ok {
				return
			}
			changed.Store(true)
			// Watch newly created directories for future events.
			if ev.Has(fsnotify.Create) {
				if info, err := os.Stat(ev.Name); err == nil && info.IsDir() {
					_ = fsw.Add(ev.Name)
				}
			}
		case _, ok := <-fsw.Errors:
			if !ok {
				return
			}
		}
	}
}

// --- Dir-mtime sentinel ---

// checkDirMtimes walks only directories under rootPath and records their mtimes.
// Cost: ~200 syscalls for a project with 200 dirs (vs 10K+ for full file walk).
func checkDirMtimes(ctx context.Context, rootPath string) (map[string]time.Time, error) {
	mtimes := make(map[string]time.Time, 256)
	err := filepath.WalkDir(rootPath, func(path string, d fs.DirEntry, walkDirErr error) error {
		if walkDirErr != nil {
			return walkDirErr
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if !d.IsDir() {
			return nil
		}
		name := d.Name()
		if name == ".git" || name == "node_modules" || name == "__pycache__" || name == ".venv" || name == "vendor" {
			return filepath.SkipDir
		}
		info, statErr := d.Info()
		if statErr != nil {
			return statErr
		}
		mtimes[path] = info.ModTime()
		return nil
	})
	return mtimes, err
}

// dirMtimesEqual returns true if two dir mtime maps are identical.
func dirMtimesEqual(a, b map[string]time.Time) bool {
	if len(a) != len(b) {
		return false
	}
	for path, aTime := range a {
		if bTime, ok := b[path]; !ok || !aTime.Equal(bTime) {
			return false
		}
	}
	return true
}

// --- Snapshot functions ---

// captureSnapshot walks the file tree using discover.Discover and captures
// mtime+size for each file.
func captureSnapshot(ctx context.Context, rootPath string) (map[string]fileSnapshot, error) {
	files, err := discover.Discover(ctx, rootPath, nil)
	if err != nil {
		return nil, err
	}
	snap := make(map[string]fileSnapshot, len(files))
	for _, f := range files {
		info, statErr := os.Stat(f.Path)
		if statErr != nil {
			continue
		}
		snap[f.RelPath] = fileSnapshot{
			modTime: info.ModTime(),
			size:    info.Size(),
		}
	}
	return snap, nil
}

// snapshotsEqual returns true if two snapshots have identical files with same mtime+size.
func snapshotsEqual(a, b map[string]fileSnapshot) bool {
	if len(a) != len(b) {
		return false
	}
	for path, aSnap := range a {
		bSnap, ok := b[path]
		if !ok {
			return false
		}
		if !aSnap.modTime.Equal(bSnap.modTime) || aSnap.size != bSnap.size {
			return false
		}
	}
	return true
}

// pollInterval computes the adaptive interval from file count.
// 5s base + 1s per 500 files, capped at 60s.
func pollInterval(fileCount int) time.Duration {
	ms := 5000 + (fileCount/500)*1000
	if ms > 60000 {
		ms = 60000
	}
	return time.Duration(ms) * time.Millisecond
}

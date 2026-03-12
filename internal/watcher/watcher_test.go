package watcher

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/DeusData/codebase-memory-mcp/internal/store"
)

// --- Test helpers ---

// mustWriteFile is a test helper that writes a file and fails the test on error.
func mustWriteFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// mustMkdirAll is a test helper that creates directories and fails the test on error.
func mustMkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

// newTestRouter creates a StoreRouter backed by a temp directory with a project registered.
func newTestRouter(t *testing.T, projectName, rootPath string) *store.StoreRouter {
	t.Helper()
	dbDir := t.TempDir()
	r, err := store.NewRouterWithDir(dbDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.CloseAll)
	if projectName != "" {
		st, err := r.ForProject(projectName)
		if err != nil {
			t.Fatal(err)
		}
		if err := st.UpsertProject(projectName, rootPath); err != nil {
			t.Fatal(err)
		}
	}
	return r
}

func gitAvailable() bool {
	_, err := exec.LookPath("git")
	return err == nil
}

// initGitRepo initializes a git repo in dir with an initial commit.
func initGitRepo(t *testing.T, dir string) {
	t.Helper()
	gitRun(t, dir, "init")
	gitRun(t, dir, "config", "user.email", "test@test.com")
	gitRun(t, dir, "config", "user.name", "test")
}

// gitCommitAll stages all files and commits.
func gitCommitAll(t *testing.T, dir, msg string) {
	t.Helper()
	gitRun(t, dir, "add", "-A")
	gitRun(t, dir, "commit", "-m", msg)
}

func gitRun(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.CommandContext(context.Background(), "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=test",
		"GIT_AUTHOR_EMAIL=test@test.com",
		"GIT_COMMITTER_NAME=test",
		"GIT_COMMITTER_EMAIL=test@test.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func newWatcherWithStrategy(r *store.StoreRouter, indexFn IndexFunc, strategy watchStrategy) *Watcher {
	w := New(r, indexFn)
	w.testStrategy = strategy
	return w
}

// resetPollTimers allows immediate re-polling.
func resetPollTimers(w *Watcher) {
	for _, state := range w.projects {
		state.nextPoll = time.Time{}
	}
}

// --- Snapshot unit tests ---

func TestSnapshotsEqual(t *testing.T) {
	now := time.Now()

	a := map[string]fileSnapshot{
		"main.go": {modTime: now, size: 100},
		"util.go": {modTime: now, size: 200},
	}
	b := map[string]fileSnapshot{
		"main.go": {modTime: now, size: 100},
		"util.go": {modTime: now, size: 200},
	}
	if !snapshotsEqual(a, b) {
		t.Error("identical snapshots should be equal")
	}

	// Different size
	c := map[string]fileSnapshot{
		"main.go": {modTime: now, size: 101},
		"util.go": {modTime: now, size: 200},
	}
	if snapshotsEqual(a, c) {
		t.Error("different size should not be equal")
	}

	// Different mtime
	d := map[string]fileSnapshot{
		"main.go": {modTime: now.Add(time.Second), size: 100},
		"util.go": {modTime: now, size: 200},
	}
	if snapshotsEqual(a, d) {
		t.Error("different mtime should not be equal")
	}

	// Missing file
	e := map[string]fileSnapshot{
		"main.go": {modTime: now, size: 100},
	}
	if snapshotsEqual(a, e) {
		t.Error("different file count should not be equal")
	}

	// Extra file
	f := map[string]fileSnapshot{
		"main.go": {modTime: now, size: 100},
		"util.go": {modTime: now, size: 200},
		"new.go":  {modTime: now, size: 50},
	}
	if snapshotsEqual(a, f) {
		t.Error("extra file should not be equal")
	}

	// Both empty
	if !snapshotsEqual(map[string]fileSnapshot{}, map[string]fileSnapshot{}) {
		t.Error("both empty should be equal")
	}
}

func TestPollInterval(t *testing.T) {
	tests := []struct {
		files    int
		expected time.Duration
	}{
		{0, 5 * time.Second},
		{70, 5 * time.Second},
		{499, 5 * time.Second},
		{500, 6 * time.Second},
		{2000, 9 * time.Second},
		{5000, 15 * time.Second},
		{10000, 25 * time.Second},
		{50000, 60 * time.Second},
		{100000, 60 * time.Second},
	}
	for _, tt := range tests {
		got := pollInterval(tt.files)
		if got != tt.expected {
			t.Errorf("pollInterval(%d) = %v, want %v", tt.files, got, tt.expected)
		}
	}
}

func TestCaptureSnapshot(t *testing.T) {
	tmpDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(tmpDir, "main.go"), []byte("package main\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	snap, err := captureSnapshot(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}

	if len(snap) != 1 {
		t.Fatalf("expected 1 file, got %d", len(snap))
	}

	s, ok := snap["main.go"]
	if !ok {
		t.Fatal("expected main.go in snapshot")
	}
	if s.size == 0 {
		t.Error("expected non-zero size")
	}
	if s.modTime.IsZero() {
		t.Error("expected non-zero modtime")
	}
}

func TestCaptureSnapshotDetectsChanges(t *testing.T) {
	tmpDir := t.TempDir()
	goFile := filepath.Join(tmpDir, "main.go")
	if err := os.WriteFile(goFile, []byte("package main\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	snap1, err := captureSnapshot(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}

	// Ensure mtime advances (some filesystems have 1s granularity)
	time.Sleep(10 * time.Millisecond)
	now := time.Now().Add(time.Second)
	if err := os.Chtimes(goFile, now, now); err != nil {
		t.Fatal(err)
	}

	snap2, err := captureSnapshot(context.Background(), tmpDir)
	if err != nil {
		t.Fatal(err)
	}

	if snapshotsEqual(snap1, snap2) {
		t.Error("snapshots should differ after mtime change")
	}
}

// --- Strategy selection tests ---

func TestStrategyString(t *testing.T) {
	tests := []struct {
		s    watchStrategy
		want string
	}{
		{strategyAuto, "auto"},
		{strategyGit, "git"},
		{strategyFSNotify, "fsnotify"},
		{strategyDirMtime, "dirmtime"},
	}
	for _, tt := range tests {
		if got := tt.s.String(); got != tt.want {
			t.Errorf("%d.String() = %q, want %q", tt.s, got, tt.want)
		}
	}
}

func TestProbeStrategyGit(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}
	tmpDir := t.TempDir()
	initGitRepo(t, tmpDir)

	w := &Watcher{ctx: context.Background()}
	got := w.probeStrategy(context.Background(), tmpDir)
	if got != strategyGit {
		t.Errorf("expected strategyGit for git repo, got %v", got)
	}
}

func TestProbeStrategyNonGit(t *testing.T) {
	tmpDir := t.TempDir()

	w := &Watcher{ctx: context.Background()}
	got := w.probeStrategy(context.Background(), tmpDir)
	// Non-git dir should probe fsnotify (intent — actual setup may fail).
	if got != strategyFSNotify {
		t.Errorf("expected strategyFSNotify for non-git dir, got %v", got)
	}
}

func TestProbeStrategyOverride(t *testing.T) {
	tmpDir := t.TempDir()

	w := &Watcher{ctx: context.Background(), testStrategy: strategyDirMtime}
	got := w.probeStrategy(context.Background(), tmpDir)
	if got != strategyDirMtime {
		t.Errorf("expected strategyDirMtime with override, got %v", got)
	}
}

// --- Git sentinel unit tests ---

func TestIsGitRepo(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}

	t.Run("git_repo", func(t *testing.T) {
		dir := t.TempDir()
		initGitRepo(t, dir)
		if !isGitRepo(context.Background(), dir) {
			t.Error("expected true for git repo")
		}
	})

	t.Run("non_git", func(t *testing.T) {
		dir := t.TempDir()
		if isGitRepo(context.Background(), dir) {
			t.Error("expected false for non-git dir")
		}
	})
}

func TestGitSentinelClean(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	initGitRepo(t, dir)
	mustWriteFile(t, filepath.Join(dir, "main.go"), []byte("package main\n"))
	gitCommitAll(t, dir, "init")

	head, err := gitHead(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}

	changed, newHead, err := gitSentinel(context.Background(), dir, head)
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("clean repo should not report changes")
	}
	if newHead != head {
		t.Error("HEAD should not change on clean repo")
	}
}

func TestGitSentinelDetectsEdit(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	initGitRepo(t, dir)
	goFile := filepath.Join(dir, "main.go")
	mustWriteFile(t, goFile, []byte("package main\n"))
	gitCommitAll(t, dir, "init")

	head, _ := gitHead(context.Background(), dir)

	// Modify tracked file.
	mustWriteFile(t, goFile, []byte("package main\n\nfunc main() {}\n"))

	changed, _, err := gitSentinel(context.Background(), dir, head)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("modified tracked file should be detected")
	}
}

func TestGitSentinelDetectsNewFile(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	initGitRepo(t, dir)
	mustWriteFile(t, filepath.Join(dir, "main.go"), []byte("package main\n"))
	gitCommitAll(t, dir, "init")

	head, _ := gitHead(context.Background(), dir)

	// Add untracked file.
	mustWriteFile(t, filepath.Join(dir, "util.go"), []byte("package main\n"))

	changed, _, err := gitSentinel(context.Background(), dir, head)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("new untracked file should be detected")
	}
}

func TestGitSentinelDetectsCommit(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}
	dir := t.TempDir()
	initGitRepo(t, dir)
	mustWriteFile(t, filepath.Join(dir, "main.go"), []byte("package main\n"))
	gitCommitAll(t, dir, "init")

	headBefore, _ := gitHead(context.Background(), dir)

	// Make a commit.
	mustWriteFile(t, filepath.Join(dir, "main.go"), []byte("package main\n\nfunc main() {}\n"))
	gitCommitAll(t, dir, "add main")

	changed, newHead, err := gitSentinel(context.Background(), dir, headBefore)
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Error("commit should be detected via HEAD change")
	}
	if newHead == headBefore {
		t.Error("HEAD should differ after commit")
	}
}

// --- FSNotify sentinel tests ---

func TestFSNotifyDetectsFileCreate(t *testing.T) {
	tmpDir := t.TempDir()
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n"))

	state := &projectState{}
	w := &Watcher{ctx: context.Background()}

	if err := w.initFSNotify(state, tmpDir); err != nil {
		t.Skipf("fsnotify not available: %v", err)
	}
	t.Cleanup(state.close)

	// Create a new file — should trigger an event.
	mustWriteFile(t, filepath.Join(tmpDir, "new.go"), []byte("package main\n"))

	// Wait for the event with timeout.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state.fsChanged.Load() {
			return // success
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("fsnotify did not detect file creation within 2s")
}

func TestFSNotifyDetectsFileDelete(t *testing.T) {
	tmpDir := t.TempDir()
	delFile := filepath.Join(tmpDir, "todelete.go")
	mustWriteFile(t, delFile, []byte("package main\n"))

	state := &projectState{}
	w := &Watcher{ctx: context.Background()}

	if err := w.initFSNotify(state, tmpDir); err != nil {
		t.Skipf("fsnotify not available: %v", err)
	}
	t.Cleanup(state.close)

	os.Remove(delFile)

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state.fsChanged.Load() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("fsnotify did not detect file deletion within 2s")
}

func TestFSNotifyWatchesNewSubdir(t *testing.T) {
	tmpDir := t.TempDir()
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n"))

	state := &projectState{}
	w := &Watcher{ctx: context.Background()}

	if err := w.initFSNotify(state, tmpDir); err != nil {
		t.Skipf("fsnotify not available: %v", err)
	}
	t.Cleanup(state.close)

	// Create a new subdirectory — drain goroutine should auto-add a watch for it.
	subDir := filepath.Join(tmpDir, "pkg")
	mustMkdirAll(t, subDir)

	// Wait for the dir creation event.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state.fsChanged.Load() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	// Reset flag and create a file in the new subdir.
	state.fsChanged.Store(false)
	time.Sleep(50 * time.Millisecond) // let the Add() complete
	mustWriteFile(t, filepath.Join(subDir, "lib.go"), []byte("package pkg\n"))

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state.fsChanged.Load() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("fsnotify did not detect file creation in new subdirectory within 2s")
}

func TestFSNotifyCleanup(t *testing.T) {
	tmpDir := t.TempDir()

	state := &projectState{}
	w := &Watcher{ctx: context.Background()}

	if err := w.initFSNotify(state, tmpDir); err != nil {
		t.Skipf("fsnotify not available: %v", err)
	}

	// Verify resources exist.
	if state.fsWatcher == nil || state.fsDone == nil || state.fsCancel == nil {
		t.Fatal("fsnotify resources not initialized")
	}

	// Close and verify goroutine exits.
	state.close()

	if state.fsWatcher != nil || state.fsDone != nil || state.fsCancel != nil {
		t.Error("close() did not nil out resources")
	}
}

func TestFSNotifyNoEventMeansNoChange(t *testing.T) {
	tmpDir := t.TempDir()
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n"))

	state := &projectState{}
	w := &Watcher{ctx: context.Background()}

	if err := w.initFSNotify(state, tmpDir); err != nil {
		t.Skipf("fsnotify not available: %v", err)
	}
	t.Cleanup(state.close)

	// No file changes — flag should remain false.
	time.Sleep(50 * time.Millisecond)
	if state.fsChanged.Load() {
		t.Error("expected no change without file operations")
	}
}

// --- Dir-mtime sentinel tests ---

func TestDirMtimesEqual(t *testing.T) {
	now := time.Now()
	a := map[string]time.Time{"/a": now, "/b": now}
	b := map[string]time.Time{"/a": now, "/b": now}
	if !dirMtimesEqual(a, b) {
		t.Error("identical maps should be equal")
	}

	c := map[string]time.Time{"/a": now.Add(time.Second), "/b": now}
	if dirMtimesEqual(a, c) {
		t.Error("different mtime should not be equal")
	}

	d := map[string]time.Time{"/a": now}
	if dirMtimesEqual(a, d) {
		t.Error("different size should not be equal")
	}
}

// --- Full watcher flow tests (dir-mtime strategy) ---

func TestWatcherTriggersOnChange(t *testing.T) {
	tmpDir := t.TempDir()
	goFile := filepath.Join(tmpDir, "main.go")
	if err := os.WriteFile(goFile, []byte("package main\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	var indexCount atomic.Int32
	indexFn := func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	}

	w := newWatcherWithStrategy(r, indexFn, strategyDirMtime)
	t.Cleanup(w.closeAll)

	// First poll — baseline capture, no index
	w.pollAll()
	if indexCount.Load() != 0 {
		t.Errorf("first poll should not trigger index, got %d", indexCount.Load())
	}

	// Poll again without changes — no index
	resetPollTimers(w)
	w.pollAll()
	if indexCount.Load() != 0 {
		t.Errorf("no-change poll should not trigger index, got %d", indexCount.Load())
	}

	// Modify the file
	futureTime := time.Now().Add(time.Second)
	if err := os.Chtimes(goFile, futureTime, futureTime); err != nil {
		t.Fatal(err)
	}

	// Force full snapshot (file mtime change doesn't affect dir mtime)
	for _, state := range w.projects {
		state.nextPoll = time.Time{}
		state.pollsSinceFull = fullSnapshotInterval
	}
	w.pollAll()
	if indexCount.Load() != 1 {
		t.Errorf("changed file should trigger index, got %d", indexCount.Load())
	}
}

func TestWatcherNewFileTriggersIndex_DirMtime(t *testing.T) {
	tmpDir := t.TempDir()
	goFile := filepath.Join(tmpDir, "main.go")
	if err := os.WriteFile(goFile, []byte("package main\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	var indexCount atomic.Int32
	w := newWatcherWithStrategy(r, func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	}, strategyDirMtime)
	t.Cleanup(w.closeAll)

	// Baseline
	w.pollAll()

	// Add a new file (changes parent dir mtime)
	if err := os.WriteFile(filepath.Join(tmpDir, "util.go"), []byte("package main\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	resetPollTimers(w)
	w.pollAll()
	if indexCount.Load() != 1 {
		t.Errorf("new file should trigger index, got %d", indexCount.Load())
	}
}

// --- Full watcher flow tests (git strategy) ---

func TestWatcherGitDetectsEdit(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}

	tmpDir := t.TempDir()
	goFile := filepath.Join(tmpDir, "main.go")
	mustWriteFile(t, goFile, []byte("package main\n"))
	initGitRepo(t, tmpDir)
	gitCommitAll(t, tmpDir, "init")

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	var indexCount atomic.Int32
	w := newWatcherWithStrategy(r, func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	}, strategyGit)
	t.Cleanup(w.closeAll)

	// Baseline
	w.pollAll()
	if indexCount.Load() != 0 {
		t.Fatalf("baseline should not trigger index, got %d", indexCount.Load())
	}

	// Modify tracked file.
	mustWriteFile(t, goFile, []byte("package main\n\nfunc main() {}\n"))

	resetPollTimers(w)
	w.pollAll()
	if indexCount.Load() != 1 {
		t.Errorf("git strategy should detect edit, got index_count=%d", indexCount.Load())
	}
}

func TestWatcherGitDetectsCommit(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}

	tmpDir := t.TempDir()
	goFile := filepath.Join(tmpDir, "main.go")
	mustWriteFile(t, goFile, []byte("package main\n"))
	initGitRepo(t, tmpDir)
	gitCommitAll(t, tmpDir, "init")

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	var indexCount atomic.Int32
	w := newWatcherWithStrategy(r, func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	}, strategyGit)
	t.Cleanup(w.closeAll)

	// Baseline
	w.pollAll()

	// Make a commit (modifies HEAD but working tree is clean after).
	mustWriteFile(t, goFile, []byte("package main\n\nfunc main() {}\n"))
	gitCommitAll(t, tmpDir, "add main func")

	resetPollTimers(w)
	w.pollAll()
	if indexCount.Load() != 1 {
		t.Errorf("git strategy should detect commit via HEAD change, got %d", indexCount.Load())
	}
}

func TestWatcherGitNoChanges(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}

	tmpDir := t.TempDir()
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n"))
	initGitRepo(t, tmpDir)
	gitCommitAll(t, tmpDir, "init")

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	var indexCount atomic.Int32
	w := newWatcherWithStrategy(r, func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	}, strategyGit)
	t.Cleanup(w.closeAll)

	// Baseline
	w.pollAll()

	// Poll again without changes — no index. Git strategy does NOT force full snapshot.
	resetPollTimers(w)
	w.pollAll()
	if indexCount.Load() != 0 {
		t.Errorf("clean git repo should not trigger index, got %d", indexCount.Load())
	}

	// Even after many polls, no forced full snapshot (git is authoritative).
	for i := 0; i < fullSnapshotInterval+2; i++ {
		resetPollTimers(w)
		w.pollAll()
	}
	if indexCount.Load() != 0 {
		t.Errorf("git strategy should never force full snapshot, got %d", indexCount.Load())
	}
}

// --- Full watcher flow tests (fsnotify strategy) ---

func TestWatcherFSNotifyDetectsNewFile(t *testing.T) {
	tmpDir := t.TempDir()
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n"))

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	var indexCount atomic.Int32
	w := newWatcherWithStrategy(r, func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	}, strategyFSNotify)
	t.Cleanup(w.closeAll)

	// Baseline (sets up fsnotify watcher).
	w.pollAll()
	projName := filepath.Base(tmpDir)
	state := w.projects[projName]
	if state == nil {
		t.Fatal("project state not created")
	}
	if state.strategy != strategyFSNotify && state.strategy != strategyDirMtime {
		t.Fatalf("unexpected strategy: %v", state.strategy)
	}
	if state.strategy == strategyDirMtime {
		t.Skip("fsnotify not available, fell back to dirmtime")
	}

	// Create a new file.
	mustWriteFile(t, filepath.Join(tmpDir, "util.go"), []byte("package main\n"))

	// Wait for fsnotify event.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if state.fsChanged.Load() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	resetPollTimers(w)
	w.pollAll()
	if indexCount.Load() != 1 {
		t.Errorf("fsnotify strategy should detect new file, got %d", indexCount.Load())
	}
}

// --- Fallback / degradation tests ---

func TestStrategyDowngradeGitToDirMtime(t *testing.T) {
	if !gitAvailable() {
		t.Skip("git not available")
	}

	tmpDir := t.TempDir()
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n"))
	initGitRepo(t, tmpDir)
	gitCommitAll(t, tmpDir, "init")

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	var indexCount atomic.Int32
	w := New(r, func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	})
	t.Cleanup(w.closeAll)

	// Baseline — should auto-detect git strategy.
	w.pollAll()
	projName := filepath.Base(tmpDir)
	state := w.projects[projName]
	if state == nil {
		t.Fatal("project state not created")
	}
	if state.strategy != strategyGit {
		t.Fatalf("expected strategyGit, got %v", state.strategy)
	}

	// Remove .git directory — git commands will fail.
	os.RemoveAll(filepath.Join(tmpDir, ".git"))

	// Modify a file so the full snapshot comparison triggers.
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n\nfunc main() {}\n"))

	resetPollTimers(w)
	w.pollAll()

	// Strategy should have downgraded (git failed → fsnotify or dirmtime).
	if state.strategy == strategyGit {
		t.Error("strategy should have downgraded from git after .git removal")
	}
}

func TestFSNotifyFallbackToDirMtime(t *testing.T) {
	// When fsnotify is the selected strategy but initFSNotify fails,
	// baseline should fall back to dirmtime.
	tmpDir := t.TempDir()
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n"))

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	var indexCount atomic.Int32
	w := newWatcherWithStrategy(r, func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	}, strategyFSNotify)
	t.Cleanup(w.closeAll)

	// initBaseline will try fsnotify. Even if it succeeds, verify the flow works.
	// If fsnotify fails on this platform, it falls back to dirmtime.
	w.pollAll()

	projName := filepath.Base(tmpDir)
	state := w.projects[projName]
	if state == nil {
		t.Fatal("project state not created")
	}

	// Either fsnotify or dirmtime is acceptable.
	if state.strategy != strategyFSNotify && state.strategy != strategyDirMtime {
		t.Errorf("expected fsnotify or dirmtime, got %v", state.strategy)
	}

	// Regardless of strategy, adding a file and forcing full snapshot should work.
	mustWriteFile(t, filepath.Join(tmpDir, "new.go"), []byte("package main\n"))
	for _, s := range w.projects {
		s.nextPoll = time.Time{}
		s.pollsSinceFull = fullSnapshotInterval
	}
	w.pollAll()
	if indexCount.Load() != 1 {
		t.Errorf("should detect change with fallback strategy, got %d", indexCount.Load())
	}
}

// --- Lifecycle tests ---

func TestWatcherCancellation(t *testing.T) {
	dbDir := t.TempDir()
	r, err := store.NewRouterWithDir(dbDir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.CloseAll()

	w := New(r, func(_ context.Context, _, _ string) error { return nil })

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()

	cancel()

	select {
	case <-done:
		// OK — goroutine exited cleanly
	case <-time.After(3 * time.Second):
		t.Fatal("watcher did not stop after context cancellation")
	}
}

func TestWatcherSkipsMissingRoot(t *testing.T) {
	r := newTestRouter(t, "ghost", "/nonexistent/path")

	var indexCount atomic.Int32
	w := New(r, func(_ context.Context, _, _ string) error {
		indexCount.Add(1)
		return nil
	})
	t.Cleanup(w.closeAll)

	w.pollAll()
	if indexCount.Load() != 0 {
		t.Errorf("should not index missing root, got %d", indexCount.Load())
	}
}

func TestWatcherPrunesDeletedProjects(t *testing.T) {
	tmpDir := t.TempDir()
	mustWriteFile(t, filepath.Join(tmpDir, "main.go"), []byte("package main\n"))

	r := newTestRouter(t, filepath.Base(tmpDir), tmpDir)

	w := newWatcherWithStrategy(r, func(_ context.Context, _, _ string) error {
		return nil
	}, strategyDirMtime)
	t.Cleanup(w.closeAll)

	// Baseline
	w.pollAll()
	projName := filepath.Base(tmpDir)
	if _, ok := w.projects[projName]; !ok {
		t.Fatal("project should exist after baseline")
	}

	// Delete the project.
	if err := r.DeleteProject(projName); err != nil {
		t.Fatal(err)
	}

	// Invalidate cache so next pollAll sees the deletion.
	w.InvalidateProjectsCache()
	w.pollAll()

	if _, ok := w.projects[projName]; ok {
		t.Error("pruned project should not exist in watcher state")
	}
}

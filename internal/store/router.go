package store

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ProjectInfo holds metadata about a discovered project database.
type ProjectInfo struct {
	Name     string
	DBPath   string
	RootPath string
}

// storeEntry wraps a Store with idle-tracking and reference counting.
type storeEntry struct {
	store    *Store
	lastUsed time.Time
	refs     atomic.Int32 // eviction blocked while >0
}

// ReleaseFunc must be called when the caller is done with the store.
type ReleaseFunc func()

// StoreRouter manages per-project SQLite databases.
// Each project gets its own .db file in the cache directory.
// Idle stores are evicted after idleTimeout (configurable) to free memory.
type StoreRouter struct {
	dir         string                 // ~/.cache/codebase-memory-mcp/
	entries     map[string]*storeEntry // project name → entry (lazy)
	mu          sync.Mutex
	idleTimeout time.Duration
	onDelete    func(name string) // optional callback on project deletion
}

const defaultIdleTimeout = 30 * time.Second

// NewRouter creates a StoreRouter, ensuring the cache directory exists.
// Runs migration from single-DB layout if needed.
func NewRouter() (*StoreRouter, error) {
	dir, err := cacheDir()
	if err != nil {
		return nil, err
	}

	r := &StoreRouter{
		dir:         dir,
		entries:     make(map[string]*storeEntry),
		idleTimeout: defaultIdleTimeout,
	}

	// Run one-time migration from single DB to per-project DBs
	if err := r.migrate(); err != nil {
		slog.Warn("router.migrate.err", "err", err)
	}

	return r, nil
}

// NewRouterWithDir creates a StoreRouter using a custom directory (for testing).
// No migration is run.
func NewRouterWithDir(dir string) (*StoreRouter, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}
	return &StoreRouter{
		dir:         dir,
		entries:     make(map[string]*storeEntry),
		idleTimeout: defaultIdleTimeout,
	}, nil
}

// OnDelete registers a callback invoked after a project is deleted.
func (r *StoreRouter) OnDelete(fn func(name string)) {
	r.onDelete = fn
}

// ForProject returns the Store for the given project, opening it lazily.
// Updates lastUsed and increments the ref count. Callers SHOULD use
// UseStore or AcquireStore instead for automatic ref management.
func (r *StoreRouter) ForProject(name string) (*Store, error) {
	if name == "*" || name == "all" {
		return nil, fmt.Errorf("invalid project name: %q", name)
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.getOrOpenLocked(name)
}

// getOrOpenLocked returns the store, opening it if needed. Must hold r.mu.
func (r *StoreRouter) getOrOpenLocked(name string) (*Store, error) {
	if e, ok := r.entries[name]; ok {
		e.lastUsed = time.Now()
		return e.store, nil
	}

	s, err := OpenInDir(r.dir, name)
	if err != nil {
		return nil, fmt.Errorf("open store %q: %w", name, err)
	}
	r.entries[name] = &storeEntry{
		store:    s,
		lastUsed: time.Now(),
	}
	return s, nil
}

// UseStore opens the store for project, calls fn, then releases. Handles ref counting.
func (r *StoreRouter) UseStore(project string, fn func(*Store) error) error {
	st, release, err := r.AcquireStore(project)
	if err != nil {
		return err
	}
	defer release()
	return fn(st)
}

// AcquireStore returns a store with an incremented ref count plus a release function.
// The evictor will not close the store while refs > 0.
func (r *StoreRouter) AcquireStore(project string) (*Store, ReleaseFunc, error) {
	if project == "*" || project == "all" {
		return nil, nil, fmt.Errorf("invalid project name: %q", project)
	}
	r.mu.Lock()
	defer r.mu.Unlock()

	st, err := r.getOrOpenLocked(project)
	if err != nil {
		return nil, nil, err
	}

	e := r.entries[project]
	e.refs.Add(1)

	released := false
	return st, func() {
		if !released {
			released = true
			e.refs.Add(-1)
		}
	}, nil
}

// AllStores opens all .db files in the cache dir and returns a name→Store map.
func (r *StoreRouter) AllStores() map[string]*Store {
	r.mu.Lock()
	defer r.mu.Unlock()

	entries, err := os.ReadDir(r.dir)
	if err != nil {
		slog.Warn("router.all_stores.readdir", "err", err)
		result := make(map[string]*Store, len(r.entries))
		for k, v := range r.entries {
			result[k] = v.store
		}
		return result
	}

	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".db") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".db")
		if name == "codebase-memory" {
			continue // skip legacy single DB
		}
		if _, ok := r.entries[name]; ok {
			continue
		}
		s, err := OpenInDir(r.dir, name)
		if err != nil {
			slog.Warn("router.all_stores.open", "project", name, "err", err)
			continue
		}
		r.entries[name] = &storeEntry{
			store:    s,
			lastUsed: time.Now(),
		}
	}

	result := make(map[string]*Store, len(r.entries))
	for k, v := range r.entries {
		result[k] = v.store
	}
	return result
}

// ListProjects scans .db files and queries each for metadata.
// Uses AcquireStore to prevent the evictor from closing stores mid-query.
// Individual DB failures are logged and skipped (never block the full list).
func (r *StoreRouter) ListProjects() ([]*ProjectInfo, error) {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return nil, fmt.Errorf("readdir: %w", err)
	}

	result := make([]*ProjectInfo, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".db") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".db")
		if name == "codebase-memory" {
			continue // skip legacy single DB
		}
		info := &ProjectInfo{
			Name:   name,
			DBPath: filepath.Join(r.dir, e.Name()),
		}

		// Try to get root_path from the projects table.
		// AcquireStore increments refs so the evictor can't close mid-query.
		s, release, acqErr := r.AcquireStore(name)
		if acqErr == nil {
			projects, listErr := s.ListProjects()
			release()
			if listErr == nil && len(projects) > 0 {
				info.RootPath = projects[0].RootPath
			}
		}

		result = append(result, info)
	}
	return result, nil
}

// DeleteProject closes the Store connection and removes the .db + WAL/SHM files.
func (r *StoreRouter) DeleteProject(name string) error {
	r.mu.Lock()
	if e, ok := r.entries[name]; ok {
		e.store.Close()
		delete(r.entries, name)
	}
	r.mu.Unlock()

	dbPath := filepath.Join(r.dir, name+".db")
	for _, suffix := range []string{"", "-wal", "-shm"} {
		p := dbPath + suffix
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", p, err)
		}
	}
	slog.Info("router.delete", "project", name)

	if r.onDelete != nil {
		r.onDelete(name)
	}
	return nil
}

// HasProject checks if a .db file exists for the given project (without opening it).
func (r *StoreRouter) HasProject(name string) bool {
	dbPath := filepath.Join(r.dir, name+".db")
	_, err := os.Stat(dbPath)
	return err == nil
}

// Dir returns the cache directory path.
func (r *StoreRouter) Dir() string {
	return r.dir
}

// CloseAll closes all open Store connections.
func (r *StoreRouter) CloseAll() {
	r.mu.Lock()
	defer r.mu.Unlock()

	for name, e := range r.entries {
		if err := e.store.Close(); err != nil {
			slog.Warn("router.close", "project", name, "err", err)
		}
	}
	r.entries = make(map[string]*storeEntry)
}

// StartEvictor runs a background goroutine that closes idle stores.
// Ticks every 5 seconds. Evicts stores idle for > idleTimeout with refs == 0.
// Exits when ctx is cancelled.
func (r *StoreRouter) StartEvictor(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				r.evictIdle()
			}
		}
	}()
}

// evictIdle closes stores that have been idle longer than idleTimeout and have no refs.
func (r *StoreRouter) evictIdle() {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	for name, e := range r.entries {
		idle := now.Sub(e.lastUsed)
		if idle <= r.idleTimeout {
			continue
		}
		if e.refs.Load() > 0 {
			continue // in use — skip
		}
		e.store.Checkpoint(context.Background())
		if err := e.store.Close(); err != nil {
			slog.Warn("store.evict.close", "project", name, "err", err)
		}
		delete(r.entries, name)
		slog.Info("store.evict", "project", name, "idle_s", int(idle.Seconds()))
	}
}

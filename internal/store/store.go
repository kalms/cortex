package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// Querier abstracts *sql.DB and *sql.Tx so store methods work in both contexts.
type Querier interface {
	Exec(query string, args ...any) (sql.Result, error)
	Query(query string, args ...any) (*sql.Rows, error)
	QueryRow(query string, args ...any) *sql.Row
}

// Store wraps a SQLite connection for graph storage.
type Store struct {
	db     *sql.DB
	q      Querier // active querier: db or tx
	dbPath string
}

// Node represents a graph node stored in SQLite.
type Node struct {
	ID            int64
	Project       string
	Label         string
	Name          string
	QualifiedName string
	FilePath      string
	StartLine     int
	EndLine       int
	Properties    map[string]any
}

// Edge represents a graph edge stored in SQLite.
type Edge struct {
	ID         int64
	Project    string
	SourceID   int64
	TargetID   int64
	Type       string
	Properties map[string]any
}

// cacheDir returns the default cache directory for databases.
func cacheDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("home dir: %w", err)
	}
	dir := filepath.Join(home, ".cache", "codebase-memory-mcp")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return "", fmt.Errorf("mkdir cache: %w", err)
	}
	return dir, nil
}

// Open opens or creates a SQLite database for the given project in the default cache dir.
func Open(project string) (*Store, error) {
	dir, err := cacheDir()
	if err != nil {
		return nil, err
	}
	dbPath := filepath.Join(dir, project+".db")
	return OpenPath(dbPath)
}

// OpenInDir opens or creates a SQLite database for the given project in a specific directory.
func OpenInDir(dir, project string) (*Store, error) {
	dbPath := filepath.Join(dir, project+".db")
	return OpenPath(dbPath)
}

// OpenPath opens a SQLite database at the given path.
func OpenPath(dbPath string) (*Store, error) {
	// Recover from stale SHM left by SIGKILL: if WAL is empty/missing but SHM exists,
	// the SHM has stale lock state that can deadlock new connections. Safe to remove.
	recoverStaleSHM(dbPath)

	dsn := dbPath + "?_journal_mode=WAL" +
		"&_busy_timeout=10000" +
		"&_foreign_keys=1" +
		"&_synchronous=NORMAL" +
		"&_txlock=immediate"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	// Single connection: SQLite is single-writer, pool adds lock contention.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	// PRAGMAs not supported in mattn DSN — set via Exec after Open.
	ctx := context.Background()
	_, _ = db.ExecContext(ctx, "PRAGMA temp_store = MEMORY")
	_, _ = db.ExecContext(ctx, "PRAGMA mmap_size = 67108864") // 64 MB

	// Adaptive cache: 10% of DB file size, clamped to 2-64 MB.
	cacheMB := adaptiveCacheMB(dbPath)
	cacheKB := cacheMB * 1024
	_, _ = db.ExecContext(ctx, fmt.Sprintf("PRAGMA cache_size = -%d", cacheKB))

	s := &Store{db: db, dbPath: dbPath}
	s.q = s.db
	if err := s.initSchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	slog.Debug("store.open", "path", dbPath, "cache_mb", cacheMB)
	return s, nil
}

// recoverStaleSHM removes stale SHM files left by unclean shutdowns (SIGKILL).
// If the WAL file is empty or missing but the SHM file exists, the SHM contains
// stale lock state that can deadlock new connections. Removing it lets SQLite
// rebuild clean shared memory on next open.
func recoverStaleSHM(dbPath string) {
	shmPath := dbPath + "-shm"
	walPath := dbPath + "-wal"

	shmInfo, shmErr := os.Stat(shmPath)
	if shmErr != nil {
		return // no SHM file — nothing to recover
	}

	walInfo, walErr := os.Stat(walPath)
	walEmpty := walErr != nil || walInfo.Size() == 0

	if walEmpty && shmInfo.Size() > 0 {
		slog.Info("store.recover_shm", "path", dbPath, "shm_bytes", shmInfo.Size())
		_ = os.Remove(shmPath)
		// Also remove empty WAL to let SQLite start fresh
		if walErr == nil {
			_ = os.Remove(walPath)
		}
	}
}

// adaptiveCacheMB returns a cache size in MB proportional to the DB file size.
// 10% of DB size, clamped to [2, 64] MB. Returns 2 for missing/small files.
func adaptiveCacheMB(dbPath string) int {
	fi, err := os.Stat(dbPath)
	if err != nil {
		return 2
	}
	dbSizeMB := int(fi.Size() / (1 << 20))
	cacheMB := dbSizeMB / 10
	if cacheMB < 2 {
		return 2
	}
	if cacheMB > 64 {
		return 64
	}
	return cacheMB
}

// OpenMemory opens an in-memory SQLite database (for testing).
func OpenMemory() (*Store, error) {
	dsn := ":memory:?_foreign_keys=1" +
		"&_synchronous=OFF"
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open memory db: %w", err)
	}
	_, _ = db.ExecContext(context.Background(), "PRAGMA temp_store = MEMORY")
	s := &Store{db: db, dbPath: ":memory:"}
	s.q = s.db
	if err := s.initSchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return s, nil
}

// WithTransaction executes fn within a single SQLite transaction.
// The callback receives a transaction-scoped Store — all store methods called on
// txStore use the transaction. The receiver's q field is never mutated, so
// concurrent read-only handlers (using s.q == s.db) are unaffected.
func (s *Store) WithTransaction(ctx context.Context, fn func(txStore *Store) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	txStore := &Store{db: s.db, q: tx, dbPath: s.dbPath}
	if err := fn(txStore); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Checkpoint forces a WAL checkpoint, moving pages from WAL to the main DB,
// then runs PRAGMA optimize so the query planner has up-to-date statistics.
// PRAGMA optimize (SQLite 3.46+) auto-limits sampling per index, only re-analyzing
// stale stats. Cost is absorbed during indexing rather than the first read query.
func (s *Store) Checkpoint(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)")
	_, _ = s.db.ExecContext(ctx, "PRAGMA optimize")
}

// WALSize returns the current WAL file size in bytes, or -1 if unavailable.
// Useful for diagnosing memory bloat from un-checkpointed WAL files.
func (s *Store) WALSize() int64 {
	walPath := s.dbPath + "-wal"
	fi, err := os.Stat(walPath)
	if err != nil {
		return -1
	}
	return fi.Size()
}

// BeginBulkWrite switches to MEMORY journal mode for faster bulk writes.
// Also boosts cache to 64 MB for write throughput.
// Call EndBulkWrite when done to restore WAL mode and adaptive cache.
func (s *Store) BeginBulkWrite(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx, "PRAGMA journal_mode = MEMORY")
	_, _ = s.db.ExecContext(ctx, "PRAGMA synchronous = OFF")
	_, _ = s.db.ExecContext(ctx, "PRAGMA cache_size = -65536") // 64 MB
}

// EndBulkWrite restores WAL journal mode, NORMAL synchronous, and adaptive cache.
func (s *Store) EndBulkWrite(ctx context.Context) {
	_, _ = s.db.ExecContext(ctx, "PRAGMA synchronous = NORMAL")
	_, _ = s.db.ExecContext(ctx, "PRAGMA journal_mode = WAL")
	s.restoreDefaultCache(ctx)
}

// WithLargeCache temporarily boosts the page cache to 64 MB for heavy read operations
// (e.g. GetSchema, Louvain clustering), then restores the adaptive default.
func (s *Store) WithLargeCache(ctx context.Context, fn func() error) error {
	_, _ = s.db.ExecContext(ctx, "PRAGMA cache_size = -65536") // 64 MB
	defer s.restoreDefaultCache(ctx)
	return fn()
}

// restoreDefaultCache recalculates and applies the adaptive cache size from DB file size.
func (s *Store) restoreDefaultCache(ctx context.Context) {
	cacheMB := adaptiveCacheMB(s.dbPath)
	cacheKB := cacheMB * 1024
	_, _ = s.db.ExecContext(ctx, fmt.Sprintf("PRAGMA cache_size = -%d", cacheKB))
}

// Close closes the database connection.
func (s *Store) Close() error {
	return s.db.Close()
}

// DB returns the underlying sql.DB (for advanced queries).
func (s *Store) DB() *sql.DB {
	return s.db
}

// DBPath returns the filesystem path to the SQLite database.
func (s *Store) DBPath() string {
	return s.dbPath
}

func (s *Store) initSchema() error {
	ctx := context.Background()
	schema := `
	CREATE TABLE IF NOT EXISTS projects (
		name TEXT PRIMARY KEY,
		indexed_at TEXT NOT NULL,
		root_path TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS file_hashes (
		project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
		rel_path TEXT NOT NULL,
		sha256 TEXT NOT NULL,
		mtime_ns INTEGER NOT NULL DEFAULT 0,
		size INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (project, rel_path)
	);

	CREATE TABLE IF NOT EXISTS nodes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
		label TEXT NOT NULL,
		name TEXT NOT NULL,
		qualified_name TEXT NOT NULL,
		file_path TEXT DEFAULT '',
		start_line INTEGER DEFAULT 0,
		end_line INTEGER DEFAULT 0,
		properties TEXT DEFAULT '{}',
		UNIQUE(project, qualified_name)
	);

	CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(project, label);
	CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(project, name);
	CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(project, file_path);

	CREATE TABLE IF NOT EXISTS edges (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		project TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
		source_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		target_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
		type TEXT NOT NULL,
		properties TEXT DEFAULT '{}',
		UNIQUE(source_id, target_id, type)
	);

	CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id, type);
	CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id, type);
	CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(project, type);

	CREATE INDEX IF NOT EXISTS idx_edges_target_type ON edges(project, target_id, type);
	CREATE INDEX IF NOT EXISTS idx_edges_source_type ON edges(project, source_id, type);
	`
	_, err := s.db.ExecContext(ctx, schema)
	if err != nil {
		return err
	}

	// Migration: project_summaries table for ADR storage.
	_, _ = s.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS project_summaries (
			project TEXT PRIMARY KEY,
			summary TEXT NOT NULL,
			source_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`)

	// Migration: add url_path generated column to edges table.
	// Generated columns require SQLite 3.31.0+ (mattn/go-sqlite3 supports this).
	// We check if the column already exists to make this idempotent.
	var colCount int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_xinfo('edges') WHERE name='url_path_gen'`).Scan(&colCount)
	if colCount == 0 {
		_, err = s.db.ExecContext(ctx, `ALTER TABLE edges ADD COLUMN url_path_gen TEXT GENERATED ALWAYS AS (json_extract(properties, '$.url_path'))`)
		if err != nil {
			// If generated columns aren't supported, skip gracefully
			slog.Warn("schema.url_path_gen.skip", "err", err)
		}
	}

	// Index on generated column (safe to CREATE IF NOT EXISTS)
	_, _ = s.db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_edges_url_path ON edges(project, url_path_gen)`)

	// Migration: add mtime_ns and size columns to file_hashes for stat pre-filtering.
	var mtimeCol int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_table_xinfo('file_hashes') WHERE name='mtime_ns'`).Scan(&mtimeCol)
	if mtimeCol == 0 {
		_, _ = s.db.ExecContext(ctx, `ALTER TABLE file_hashes ADD COLUMN mtime_ns INTEGER NOT NULL DEFAULT 0`)
		_, _ = s.db.ExecContext(ctx, `ALTER TABLE file_hashes ADD COLUMN size INTEGER NOT NULL DEFAULT 0`)
	}

	return nil
}

// marshalProps serializes properties to JSON.
func marshalProps(props map[string]any) string {
	if props == nil {
		return "{}"
	}
	b, err := json.Marshal(props)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// UnmarshalProps deserializes JSON properties. Exported for use by cypher executor.
func UnmarshalProps(data string) map[string]any {
	return unmarshalProps(data)
}

// unmarshalProps deserializes JSON properties.
func unmarshalProps(data string) map[string]any {
	if data == "" {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(data), &m); err != nil {
		return map[string]any{}
	}
	return m
}

// Now returns the current time in ISO 8601 format.
func Now() string {
	return time.Now().UTC().Format(time.RFC3339)
}

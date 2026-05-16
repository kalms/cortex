import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Current FTS schema version. Bump when the FTS table or triggers change in
 * a way that requires existing DBs to rebuild the index.
 */
const FTS_VERSION = "2";

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  rationale    TEXT,
  problem      TEXT,
  resolution   TEXT,
  alternatives TEXT,
  tier         TEXT NOT NULL DEFAULT 'personal',
  status       TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  author       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_links (
  rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id  TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_kind  TEXT NOT NULL,
  target_ref   TEXT NOT NULL,
  relation     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_links_decision ON decision_links(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_links_target   ON decision_links(target_kind, target_ref);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/*
 * FTS5 sync via triggers — the SQLite-documented pattern for external-content
 * tables. The repository must NOT manually INSERT/DELETE on decisions_fts;
 * doing so after a content-table UPDATE corrupts the index because the FTS
 * machinery reads the (already-mutated) row values when reconciling.
 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, description, rationale, problem, resolution,
  content='decisions',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, title, description, rationale, problem, resolution)
  VALUES (new.rowid, new.title, new.description, new.rationale, new.problem, new.resolution);
END;

CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, title, description, rationale, problem, resolution)
  VALUES ('delete', old.rowid, old.title, old.description, old.rationale, old.problem, old.resolution);
END;

CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, title, description, rationale, problem, resolution)
  VALUES ('delete', old.rowid, old.title, old.description, old.rationale, old.problem, old.resolution);
  INSERT INTO decisions_fts(rowid, title, description, rationale, problem, resolution)
  VALUES (new.rowid, new.title, new.description, new.rationale, new.problem, new.resolution);
END;
`;

function readSchemaMeta(db: Database.Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeSchemaMeta(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)").run(key, value);
}

/**
 * Migrate FTS from v1 (manual sync via repository, index could be corrupted)
 * to v2 (triggers on the content table). Drops + recreates the FTS table and
 * its triggers, then rebuilds the index from the content table — safe because
 * `decisions` is the canonical store.
 */
function migrateFtsToTriggers(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS decisions_ai;
      DROP TRIGGER IF EXISTS decisions_ad;
      DROP TRIGGER IF EXISTS decisions_au;
      DROP TABLE IF EXISTS decisions_fts;
    `);
    db.exec(FTS_SCHEMA);
    db.prepare("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')").run();
    writeSchemaMeta(db, "fts_version", FTS_VERSION);
  })();
}

/** Open (and create if missing) the decisions sidecar DB. */
export function openDecisionsDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(BASE_SCHEMA);
  if (readSchemaMeta(db, "fts_version") !== FTS_VERSION) {
    migrateFtsToTriggers(db);
  }
  return db;
}

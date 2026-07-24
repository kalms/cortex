import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { relocateLegacyDecisions } from "./relocation.js";
import { runMigrations, MigrationError } from "../db/migrate.js";
import { snapshotDb, restoreDb, pruneSnapshots } from "../db/snapshot.js";
import { migrateDecisionIdsToShortForm } from "./id-migration.js";

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
  provenance   TEXT,
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

CREATE TABLE IF NOT EXISTS id_sequences (
  entity_type TEXT PRIMARY KEY,   -- 'decision' | 'todo' | 'story'
  next_val    INTEGER NOT NULL    -- next seq to hand out (1-based)
);

CREATE TABLE IF NOT EXISTS todos (
  id           TEXT PRIMARY KEY,
  seq          INTEGER,
  summary      TEXT NOT NULL,
  description  TEXT,
  state        TEXT NOT NULL DEFAULT 'open',
  state_reason TEXT,
  proposed_by  TEXT,
  proposed_at  TEXT NOT NULL,
  started_at   TEXT,
  closed_at    TEXT,
  assignee     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_links (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id     TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_ref  TEXT NOT NULL,
  relation    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_links_todo   ON todo_links(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_links_target ON todo_links(target_kind, target_ref);

CREATE TABLE IF NOT EXISTS stories (
  id           TEXT PRIMARY KEY,
  seq          INTEGER,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS story_steps (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL,           -- 1-based
  caption     TEXT NOT NULL,
  refs        TEXT NOT NULL,              -- JSON string[]
  emphasis_edges TEXT,                    -- JSON [string,string][] | NULL
  layout_hint TEXT                        -- 'network' | 'organic' | NULL (slice 3)
);
CREATE INDEX IF NOT EXISTS idx_story_steps_story ON story_steps(story_id, step_index);

CREATE TABLE IF NOT EXISTS story_links (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id    TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,              -- 'decision' | 'pr'
  target_ref  TEXT NOT NULL,
  relation    TEXT NOT NULL,              -- 'ABOUT'
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_story_links_story ON story_links(story_id);
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

const TODOS_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS todos_fts USING fts5(
  summary, description,
  content='todos',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS todos_ai AFTER INSERT ON todos BEGIN
  INSERT INTO todos_fts(rowid, summary, description)
  VALUES (new.rowid, new.summary, new.description);
END;
CREATE TRIGGER IF NOT EXISTS todos_ad AFTER DELETE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, summary, description)
  VALUES ('delete', old.rowid, old.summary, old.description);
END;
CREATE TRIGGER IF NOT EXISTS todos_au AFTER UPDATE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, summary, description)
  VALUES ('delete', old.rowid, old.summary, old.description);
  INSERT INTO todos_fts(rowid, summary, description)
  VALUES (new.rowid, new.summary, new.description);
END;
`;

export const PRIMITIVES_MIGRATIONS = [
  { name: "id-short-form", up: migrateDecisionIdsToShortForm },
];

function storeHasRows(db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT (SELECT COUNT(*) FROM decisions) + (SELECT COUNT(*) FROM todos) AS n",
  ).get() as { n: number };
  return row.n > 0;
}

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

/** Additively add the provenance column to pre-existing DBs. Idempotent. */
function ensureProvenanceColumn(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "provenance")) {
    db.exec("ALTER TABLE decisions ADD COLUMN provenance TEXT");
  }
}

/** Additively add the seq column to pre-existing DBs. Idempotent. */
function ensureSeqColumn(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "seq")) {
    db.exec("ALTER TABLE decisions ADD COLUMN seq INTEGER");
  }
}

/** Additively add the reconciliation columns to pre-existing DBs. Idempotent. */
function ensureReconciliationColumns(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  const additions: Array<[string, string]> = [
    ["reconciliation_verdict", "TEXT"],
    ["reconciled_at", "TEXT"],
    ["reconciled_source_hash", "TEXT"],
    ["reconciled_by", "TEXT"],
    ["nonconformant_nodes", "TEXT"],
    ["reconciliation_note", "TEXT"],
  ];
  for (const [name, type] of additions) {
    if (!have.has(name)) db.exec(`ALTER TABLE decisions ADD COLUMN ${name} ${type}`);
  }
}

/** Open (and create if missing) the decisions sidecar DB. */
export function openDecisionsDb(path: string, legacyPath?: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(BASE_SCHEMA);
  ensureProvenanceColumn(db);
  ensureSeqColumn(db);
  // Ensure reconciliation columns exist before FTS migration,
  // which may try to read from them when rebuilding the index.
  ensureReconciliationColumns(db);
  db.exec(TODOS_FTS_SCHEMA);
  if (readSchemaMeta(db, "fts_version") !== FTS_VERSION) {
    migrateFtsToTriggers(db);
  }
  if (legacyPath && legacyPath !== path) {
    relocateLegacyDecisions(db, legacyPath);
  }

  const backupsDir = join(dirname(path), "backups");
  let snapshotPath: string | null = null;
  try {
    runMigrations(db, PRIMITIVES_MIGRATIONS, {
      set: "primitives",
      beforeApply: () => {
        if (!storeHasRows(db)) return; // nothing to protect on an empty store
        mkdirSync(backupsDir, { recursive: true });
        snapshotPath = join(backupsDir, `decisions.db.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`);
        snapshotDb(db, snapshotPath);
        pruneSnapshots(backupsDir, 3);
      },
    });
  } catch (e) {
    if (e instanceof MigrationError && e.kind === "migration-failed" && snapshotPath) {
      db.close();
      restoreDb(path, snapshotPath);
      throw new MigrationError("migration-failed", `${e.message} — store restored from snapshot`, e.detail);
    }
    throw e; // store-too-new (no snapshot) and anything else propagate as-is
  }
  return db;
}

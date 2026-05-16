import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const SCHEMA = `
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

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, description, rationale, problem, resolution,
  content='decisions',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Open (and create if missing) the decisions sidecar DB. */
export function openDecisionsDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

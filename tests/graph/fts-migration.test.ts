import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("FTS migration: old schema -> new schema", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-fts-mig-"));
    dbPath = join(dir, "graph.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recreates FTS with problem + resolution columns when old schema detected", () => {
    // simulate pre-upgrade DB: create with old FTS only
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT,
        qualified_name TEXT, file_path TEXT, data TEXT NOT NULL DEFAULT '{}',
        tier TEXT NOT NULL DEFAULT 'personal',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT,
        relation TEXT, data TEXT DEFAULT '{}', created_at TEXT);
      CREATE TABLE edge_annotations (id TEXT, decision_id TEXT, edge_id TEXT, created_at TEXT);
      CREATE VIRTUAL TABLE decisions_fts USING fts5(title, description, rationale, node_id UNINDEXED);
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO nodes (id, kind, name, data, created_at, updated_at)
       VALUES (?, 'decision', ?, ?, ?, ?)`
    ).run("d1", "Old", JSON.stringify({ description: "desc", rationale: "why" }), now, now);
    db.prepare(
      "INSERT INTO decisions_fts (title, description, rationale, node_id) VALUES (?, ?, ?, ?)"
    ).run("Old", "desc", "why", "d1");
    db.close();

    // open via GraphStore — should detect old schema and migrate
    const store = new GraphStore(dbPath);

    const cols = (store as any).db
      .prepare(`PRAGMA table_info(decisions_fts)`)
      .all()
      .map((r: { name: string }) => r.name);
    expect(cols).toContain("problem");
    expect(cols).toContain("resolution");

    // existing row still searchable
    const hits = (store as any).db
      .prepare("SELECT node_id FROM decisions_fts WHERE decisions_fts MATCH 'desc'")
      .all();
    expect(hits.map((h: { node_id: string }) => h.node_id)).toContain("d1");
  });
});

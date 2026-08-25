import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { publishStagedDb } from "../../src/db/swap-graph-db.js";

const NODES_DDL = `CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
  qualified_name TEXT, file_path TEXT, data TEXT NOT NULL DEFAULT '{}', tier TEXT NOT NULL DEFAULT 'personal',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, start_line INTEGER, end_line INTEGER, project TEXT)`;

function writeStage(path: string, ids: string[]) {
  const db = new BetterSqlite3(path);
  db.exec(NODES_DDL);
  const ins = db.prepare("INSERT INTO nodes (id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?)");
  for (const id of ids) ins.run(id, "file", id, "t", "t");
  db.close();
}

describe("publishStagedDb", () => {
  let dir: string, live: string, stage: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "swap-"));
    live = join(dir, "db");
    stage = join(dir, "db.stage-1");
    const db = new BetterSqlite3(live);
    db.exec(NODES_DDL);
    db.exec("CREATE TABLE edge_annotations (id TEXT PRIMARY KEY, decision_id TEXT, edge_id TEXT, created_at TEXT)");
    db.prepare("INSERT INTO nodes (id,kind,name,created_at,updated_at) VALUES ('old','file','old','t','t')").run();
    db.prepare("INSERT INTO edge_annotations VALUES ('a1','d1','e1','t')").run();
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("replaces staging-present tables and leaves live-only tables intact", () => {
    writeStage(stage, ["n1", "n2", "n3"]);
    publishStagedDb({ stagePath: stage, liveDbPath: live });
    const db = new BetterSqlite3(live, { readonly: true });
    expect((db.prepare("SELECT count(*) c FROM nodes").get() as { c: number }).c).toBe(3);
    expect(db.prepare("SELECT 1 FROM nodes WHERE id='old'").get()).toBeUndefined();
    expect((db.prepare("SELECT count(*) c FROM edge_annotations").get() as { c: number }).c).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("an already-open WAL reader sees the new snapshot WITHOUT reopening", () => {
    writeStage(stage, ["n1", "n2"]);
    const reader = new BetterSqlite3(live);
    reader.pragma("journal_mode = WAL");
    expect((reader.prepare("SELECT count(*) c FROM nodes").get() as { c: number }).c).toBe(1);
    publishStagedDb({ stagePath: stage, liveDbPath: live });
    expect((reader.prepare("SELECT count(*) c FROM nodes").get() as { c: number }).c).toBe(2);
    expect(reader.pragma("integrity_check", { simple: true })).toBe("ok");
    reader.close();
  });

  it("leaves the OLD state intact if the swap transaction does not commit", () => {
    writeStage(stage, ["n1", "n2"]);
    const db = new BetterSqlite3(live);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = OFF");
    db.exec(`ATTACH '${stage}' AS stage`);
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM nodes");
    db.exec("INSERT INTO nodes (id,kind,name,created_at,updated_at) SELECT id,kind,name,created_at,updated_at FROM stage.nodes");
    db.exec("ROLLBACK");
    db.exec("DETACH stage");
    expect(db.prepare("SELECT 1 FROM nodes WHERE id='old'").get()).toBeTruthy();
    expect((db.prepare("SELECT count(*) c FROM nodes").get() as { c: number }).c).toBe(1);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("recreates + repopulates a contentless FTS5 table from nodes (ctx-<rowid> contract; no crash; integrity ok)", () => {
    // The real C-writer DB carries a contentless FTS5 table (ctx_nodes_fts) with
    // write-protected shadow tables that cannot be copied via SQL. The swap must
    // recreate it from staging's DDL and repopulate from the freshly-copied
    // nodes, keyed by the numeric suffix of the node id so the C BM25 handler's
    // `JOIN nodes n ON n.id = 'ctx-' || <fts>.rowid` resolves. Mirrors the
    // production schema (content='', unicode61 tokenizer).
    const FTS_DDL =
      "CREATE VIRTUAL TABLE ctx_nodes_fts USING fts5(name, qualified_name, kind, file_path, content='', tokenize='unicode61')";
    // Staging: regular nodes + a populated contentless FTS index.
    const sdb = new BetterSqlite3(stage);
    sdb.exec(NODES_DDL);
    sdb.exec(FTS_DDL);
    sdb.prepare("INSERT INTO nodes (id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?)").run("ctx-1", "function", "alpha", "t", "t");
    sdb.prepare("INSERT INTO nodes (id,kind,name,created_at,updated_at) VALUES (?,?,?,?,?)").run("ctx-2", "function", "beta", "t", "t");
    sdb.exec("INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) SELECT CAST(substr(id,5) AS INTEGER), name, qualified_name, kind, file_path FROM nodes");
    sdb.close();
    // Live already has a stale FTS table (prior index) that must be dropped/recreated.
    const ldb = new BetterSqlite3(live);
    ldb.exec(FTS_DDL);
    ldb.exec("INSERT INTO ctx_nodes_fts(rowid, name) VALUES (999, 'stale')");
    ldb.close();

    expect(() => publishStagedDb({ stagePath: stage, liveDbPath: live })).not.toThrow();

    const db = new BetterSqlite3(live, { readonly: true });
    // Regular table replaced from staging.
    expect((db.prepare("SELECT count(*) c FROM nodes").get() as { c: number }).c).toBe(2);
    // FTS repopulated from the new nodes — one row per ctx- node, stale row gone.
    expect((db.prepare("SELECT count(*) c FROM ctx_nodes_fts").get() as { c: number }).c).toBe(2);
    // The 'ctx-<rowid>' search contract resolves: MATCH 'alpha' -> node ctx-1.
    const hit = db.prepare(
      "SELECT n.id, n.name FROM ctx_nodes_fts f JOIN nodes n ON n.id = 'ctx-' || f.rowid WHERE ctx_nodes_fts MATCH 'alpha'",
    ).get() as { id: string; name: string } | undefined;
    expect(hit?.id).toBe("ctx-1");
    expect(hit?.name).toBe("alpha");
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });
  // ─── schema reconciliation (ruevu/cortex#81) ────────────────────────────────
  // `CREATE TABLE IF NOT EXISTS` cannot widen a table that already exists, so a
  // live store written before a C-indexer column addition used to fail the row
  // copy — discarding a fully built index and leaving the stale graph live.

  const PROJECTS_V1 = "CREATE TABLE ctx_projects (name TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, root_path TEXT NOT NULL)";
  const PROJECTS_V2 = PROJECTS_V1.replace("root_path TEXT NOT NULL)", "root_path TEXT NOT NULL, extract_schema INTEGER NOT NULL DEFAULT 0)");

  it("widens a live table the indexer has since added a column to, and publishes", () => {
    const ldb = new BetterSqlite3(live);
    ldb.exec(PROJECTS_V1);
    ldb.prepare("INSERT INTO ctx_projects VALUES ('p','2026-08-24T00:00:00Z','/old')").run();
    ldb.close();
    const sdb = new BetterSqlite3(stage);
    sdb.exec(PROJECTS_V2);
    sdb.prepare("INSERT INTO ctx_projects VALUES ('p','2026-08-25T00:00:00Z','/new',1)").run();
    sdb.close();

    expect(() => publishStagedDb({ stagePath: stage, liveDbPath: live })).not.toThrow();

    const db = new BetterSqlite3(live, { readonly: true });
    const row = db.prepare("SELECT * FROM ctx_projects").get() as Record<string, unknown>;
    expect(row.extract_schema).toBe(1);
    expect(row.indexed_at).toBe("2026-08-25T00:00:00Z"); // the NEW index is live, not the old one
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("adding a column in place keeps the live table's indexes and live-only columns", () => {
    const ldb = new BetterSqlite3(live);
    ldb.exec("ALTER TABLE nodes ADD COLUMN annotation TEXT"); // live-only, from a lazy migration
    ldb.exec("CREATE INDEX idx_nodes_name ON nodes(name)");
    ldb.close();
    const sdb = new BetterSqlite3(stage);
    sdb.exec(NODES_DDL.replace("project TEXT)", "project TEXT, signature TEXT NOT NULL DEFAULT '')"));
    sdb.prepare("INSERT INTO nodes (id,kind,name,created_at,updated_at,signature) VALUES ('n1','file','n1','t','t','sig')").run();
    sdb.close();

    publishStagedDb({ stagePath: stage, liveDbPath: live });

    const db = new BetterSqlite3(live, { readonly: true });
    const cols = (db.pragma("table_info(nodes)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("signature");  // staging's addition arrived
    expect(cols).toContain("annotation"); // the live-only column survived
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nodes_name'").get()).toBeTruthy();
    expect((db.prepare("SELECT signature s FROM nodes WHERE id='n1'").get() as { s: string }).s).toBe("sig");
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("rebuilds the live table when the new column cannot be added in place, replaying its indexes", () => {
    // SQLite refuses ADD COLUMN for NOT NULL with no default — the only way to
    // take this column is to rebuild the table from staging's DDL.
    const ldb = new BetterSqlite3(live);
    ldb.exec("CREATE INDEX idx_nodes_name ON nodes(name)");
    ldb.close();
    const sdb = new BetterSqlite3(stage);
    sdb.exec(NODES_DDL.replace("project TEXT)", "project TEXT, digest TEXT NOT NULL)"));
    sdb.prepare("INSERT INTO nodes (id,kind,name,created_at,updated_at,digest) VALUES ('n1','file','n1','t','t','d1')").run();
    sdb.close();

    publishStagedDb({ stagePath: stage, liveDbPath: live });

    const db = new BetterSqlite3(live, { readonly: true });
    const cols = (db.pragma("table_info(nodes)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("digest");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_nodes_name'").get()).toBeTruthy();
    expect((db.prepare("SELECT count(*) c FROM nodes").get() as { c: number }).c).toBe(1);
    expect(db.prepare("SELECT 1 FROM nodes WHERE id='old'").get()).toBeUndefined();
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });

  it("rebuilds when a live-only NOT NULL column could never be filled by the copy", () => {
    // The mirror case: the indexer DROPPED a column the live table still
    // requires. Copying staging's columns alone would violate it on every row.
    const ldb = new BetterSqlite3(live);
    ldb.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT, legacy TEXT NOT NULL)");
    ldb.prepare("INSERT INTO meta VALUES ('old','old','l')").run();
    ldb.close();
    const sdb = new BetterSqlite3(stage);
    sdb.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
    sdb.prepare("INSERT INTO meta VALUES ('a','b')").run();
    sdb.close();

    expect(() => publishStagedDb({ stagePath: stage, liveDbPath: live })).not.toThrow();

    const db = new BetterSqlite3(live, { readonly: true });
    expect((db.pragma("table_info(meta)") as Array<{ name: string }>).map((c) => c.name)).toEqual(["k", "v"]);
    expect((db.prepare("SELECT v FROM meta WHERE k='a'").get() as { v: string }).v).toBe("b");
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    db.close();
  });
});

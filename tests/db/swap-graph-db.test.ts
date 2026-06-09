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
});

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";

const RECON_COLS = [
  "reconciliation_verdict", "reconciled_at", "reconciled_source_hash",
  "reconciled_by", "nonconformant_nodes", "reconciliation_note",
];

function cols(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>).map((c) => c.name);
}

describe("reconciliation schema migration", () => {
  it("adds all reconciliation columns to a fresh DB", () => {
    const path = join(mkdtempSync(join(tmpdir(), "recon-")), "decisions.db");
    const db = openDecisionsDb(path);
    const present = cols(db);
    for (const c of RECON_COLS) expect(present).toContain(c);
    db.close();
  });

  it("adds columns idempotently to a pre-existing DB lacking them", () => {
    const path = join(mkdtempSync(join(tmpdir(), "recon-")), "decisions.db");
    const raw = new Database(path);
    raw.exec(`CREATE TABLE decisions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      description TEXT, rationale TEXT, problem TEXT, resolution TEXT,
      alternatives TEXT, tier TEXT NOT NULL DEFAULT 'personal',
      status TEXT NOT NULL DEFAULT 'active', superseded_by TEXT,
      author TEXT, provenance TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
    raw.close();
    const db = openDecisionsDb(path);
    const db2 = openDecisionsDb(path);
    for (const c of RECON_COLS) expect(cols(db2)).toContain(c);
    db.close(); db2.close();
  });

  it("leaves the FTS triggers intact (insert still mirrors to FTS)", () => {
    const path = join(mkdtempSync(join(tmpdir(), "recon-")), "decisions.db");
    const db = openDecisionsDb(path);
    db.prepare(`INSERT INTO decisions (id,title,description,rationale,problem,resolution,
      alternatives,tier,status,superseded_by,author,provenance,created_at,updated_at)
      VALUES ('d1','Bundle ripgrep',NULL,NULL,NULL,NULL,NULL,'personal','active',NULL,NULL,NULL,'t','t')`).run();
    const hit = db.prepare("SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'ripgrep'").all();
    expect(hit.length).toBe(1);
    db.close();
  });
});

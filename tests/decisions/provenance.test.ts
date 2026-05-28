import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository, DecisionRecord } from "../../src/decisions/repository.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "cortex-prov-"));
}

const baseRec = (over: Partial<DecisionRecord> = {}): DecisionRecord => ({
  id: "d1", title: "T", description: null, rationale: null,
  problem: null, resolution: null, alternatives: null,
  tier: "personal", status: "proposed", superseded_by: null,
  author: "cortex:seed", created_at: "2026-05-28", updated_at: "2026-05-28",
  ...over,
});

describe("decisions.provenance column", () => {
  it("fresh DB has a provenance column", () => {
    const root = tmp();
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("provenance");
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("idempotently adds provenance to a pre-existing column-less DB", () => {
    const root = tmp();
    try {
      const path = join(root, "decisions.db");
      const legacy = new Database(path);
      legacy.exec(`CREATE TABLE decisions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, rationale TEXT,
        problem TEXT, resolution TEXT, alternatives TEXT,
        tier TEXT NOT NULL DEFAULT 'personal', status TEXT NOT NULL DEFAULT 'active',
        superseded_by TEXT, author TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
      legacy.close();
      const db = openDecisionsDb(path);                       // migration runs
      const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
      expect(cols.map((c) => c.name)).toContain("provenance");
      db.close();
      // second open must not throw
      const db2 = openDecisionsDb(path);
      db2.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("round-trips provenance JSON through insert/get", () => {
    const root = tmp();
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const repo = new DecisionsRepository(db);
      const prov = JSON.stringify({ source: "adr", doc_path: "docs/adr/1.md", confidence: "high" });
      repo.insert(baseRec({ provenance: prov }));
      expect(repo.get("d1")?.provenance).toBe(prov);
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("inserts NULL provenance when the field is omitted", () => {
    const root = tmp();
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const repo = new DecisionsRepository(db);
      repo.insert(baseRec());                                  // no provenance key
      expect(repo.get("d1")?.provenance ?? null).toBeNull();
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

// tests/decisions/relocation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { relocateLegacyDecisions } from "../../src/decisions/relocation.js";

describe("relocateLegacyDecisions", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-reloc-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seedLegacy(path: string, ids: string[]): void {
    const db = openDecisionsDb(path);
    const insert = db.prepare(
      `INSERT INTO decisions (id, title, problem, resolution, rationale, status, tier, author, created_at, updated_at, seq)
       VALUES (?, ?, '', '', '', 'active', 'personal', 'tester', '2026-01-01', '2026-01-01', ?)`,
    );
    ids.forEach((id, i) => insert.run(id, `t-${id}`, i + 1));
    db.close();
  }

  it("copies legacy decisions into the new store and is idempotent", () => {
    const legacy = join(dir, "legacy", ".cortex", "decisions.db");
    mkdirSync(join(dir, "legacy", ".cortex"), { recursive: true });
    seedLegacy(legacy, ["D-9m2x", "D-7k3p"]);

    const target = openDecisionsDb(join(dir, "store", "decisions.db"));
    const first = relocateLegacyDecisions(target, legacy);
    expect(first.copied).toBe(2);
    expect(target.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 2 });

    const second = relocateLegacyDecisions(target, legacy);
    expect(second.copied).toBe(0);
    expect(target.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 2 });
    target.close();
  });

  it("unions without clobbering existing target rows (dedupe by id)", () => {
    const legacy = join(dir, "legacy", ".cortex", "decisions.db");
    mkdirSync(join(dir, "legacy", ".cortex"), { recursive: true });
    seedLegacy(legacy, ["D-aaaa", "D-bbbb"]);

    const target = openDecisionsDb(join(dir, "store", "decisions.db"));
    target.prepare(
      `INSERT INTO decisions (id, title, problem, resolution, rationale, status, tier, author, created_at, updated_at, seq)
       VALUES ('D-aaaa', 'existing', '', '', '', 'active', 'personal', 'me', '2026-01-01', '2026-01-01', 5)`,
    ).run();

    relocateLegacyDecisions(target, legacy);
    expect(target.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 2 });
    expect((target.prepare("SELECT title FROM decisions WHERE id='D-aaaa'").get() as { title: string }).title).toBe("existing");
    target.close();
  });

  it("no-ops when the legacy DB does not exist", () => {
    const target = openDecisionsDb(join(dir, "store", "decisions.db"));
    expect(relocateLegacyDecisions(target, join(dir, "nope", "decisions.db")).copied).toBe(0);
    target.close();
  });

  // Fix 1: dedupe decision_links by logical tuple
  it("does not duplicate decision_links when the same link exists in both target and legacy", () => {
    const legacy = join(dir, "legacy", ".cortex", "decisions.db");
    mkdirSync(join(dir, "legacy", ".cortex"), { recursive: true });

    // Seed legacy: decision D-dup with one link row
    const legacyDb = openDecisionsDb(legacy);
    legacyDb.prepare(
      `INSERT INTO decisions (id, title, problem, resolution, rationale, status, tier, author, created_at, updated_at, seq)
       VALUES ('D-dup', 't-D-dup', '', '', '', 'active', 'personal', 'tester', '2026-01-01', '2026-01-01', 1)`,
    ).run();
    legacyDb.prepare(
      `INSERT INTO decision_links (decision_id, target_kind, target_ref, relation, created_at)
       VALUES ('D-dup', 'path', 'src/x.ts', 'GOVERNS', '2026-01-01')`,
    ).run();
    legacyDb.close();

    // Pre-seed target with the same decision and the same link row
    const target = openDecisionsDb(join(dir, "store", "decisions.db"));
    target.prepare(
      `INSERT INTO decisions (id, title, problem, resolution, rationale, status, tier, author, created_at, updated_at, seq)
       VALUES ('D-dup', 't-D-dup', '', '', '', 'active', 'personal', 'tester', '2026-01-01', '2026-01-01', 1)`,
    ).run();
    target.prepare(
      `INSERT INTO decision_links (decision_id, target_kind, target_ref, relation, created_at)
       VALUES ('D-dup', 'path', 'src/x.ts', 'GOVERNS', '2026-01-01')`,
    ).run();

    relocateLegacyDecisions(target, legacy);

    const linkCount = (target.prepare(
      `SELECT COUNT(*) c FROM decision_links WHERE decision_id = 'D-dup'`,
    ).get() as { c: number }).c;
    expect(linkCount).toBe(1);
    target.close();
  });

  // Fix 2: non-fatal on corrupt/unreadable legacy DB
  it("does not throw and returns { copied: 0 } when legacy DB is corrupt", () => {
    const legacyPath = join(dir, "corrupt.db");
    writeFileSync(legacyPath, "not a sqlite db");
    const target = openDecisionsDb(join(dir, "store", "decisions.db"));
    expect(() => relocateLegacyDecisions(target, legacyPath)).not.toThrow();
    expect(relocateLegacyDecisions(target, legacyPath).copied).toBe(0);
    target.close();
  });

  // Fix 3: id_sequences high-water-mark
  it("takes the MAX next_val for id_sequences (legacy wins when higher)", () => {
    const legacy = join(dir, "legacy-seq", ".cortex", "decisions.db");
    mkdirSync(join(dir, "legacy-seq", ".cortex"), { recursive: true });
    const legacyDb = openDecisionsDb(legacy);
    legacyDb.prepare(
      `INSERT OR REPLACE INTO id_sequences (entity_type, next_val) VALUES ('decision', 10)`,
    ).run();
    legacyDb.close();

    const target = openDecisionsDb(join(dir, "store-seq", "decisions.db"));
    target.prepare(
      `INSERT OR REPLACE INTO id_sequences (entity_type, next_val) VALUES ('decision', 3)`,
    ).run();

    relocateLegacyDecisions(target, legacy);

    const row = target.prepare(
      `SELECT next_val FROM id_sequences WHERE entity_type = 'decision'`,
    ).get() as { next_val: number };
    expect(row.next_val).toBe(10);
    target.close();
  });

  it("does not lower an existing higher target id_sequences value (target wins when higher)", () => {
    const legacy = join(dir, "legacy-seq2", ".cortex", "decisions.db");
    mkdirSync(join(dir, "legacy-seq2", ".cortex"), { recursive: true });
    const legacyDb = openDecisionsDb(legacy);
    legacyDb.prepare(
      `INSERT OR REPLACE INTO id_sequences (entity_type, next_val) VALUES ('decision', 5)`,
    ).run();
    legacyDb.close();

    const target = openDecisionsDb(join(dir, "store-seq2", "decisions.db"));
    target.prepare(
      `INSERT OR REPLACE INTO id_sequences (entity_type, next_val) VALUES ('decision', 20)`,
    ).run();

    relocateLegacyDecisions(target, legacy);

    const row = target.prepare(
      `SELECT next_val FROM id_sequences WHERE entity_type = 'decision'`,
    ).get() as { next_val: number };
    expect(row.next_val).toBe(20);
    target.close();
  });

  it("relocates from an OLDER legacy schema missing seq/reconciliation columns", () => {
    // Simulate a legacy DB created by an older Cortex that never ran ensureSeqColumn
    // or ensureReconciliationColumns — only the BASE_SCHEMA columns exist.
    const legacy = join(dir, "old", ".cortex", "decisions.db");
    mkdirSync(join(dir, "old", ".cortex"), { recursive: true });
    const ldb = new Database(legacy);
    ldb.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        rationale TEXT,
        problem TEXT,
        resolution TEXT,
        alternatives TEXT,
        tier TEXT NOT NULL DEFAULT 'personal',
        status TEXT NOT NULL DEFAULT 'active',
        superseded_by TEXT,
        author TEXT,
        provenance TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE decision_links (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_id TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        relation TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE id_sequences (entity_type TEXT PRIMARY KEY, next_val INTEGER NOT NULL);
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    ldb.prepare(
      `INSERT INTO decisions (id, title, description, rationale, problem, resolution, alternatives, tier, status, superseded_by, author, provenance, created_at, updated_at)
       VALUES ('uuid-old-1', 'old decision', '', '', '', '', '[]', 'personal', 'active', NULL, 'me', NULL, '2026-01-01', '2026-01-01')`,
    ).run();
    ldb.close();

    const target = openDecisionsDb(join(dir, "store-old", "decisions.db"));
    const r = relocateLegacyDecisions(target, legacy);
    expect(r.copied).toBe(1);
    expect(
      (target.prepare("SELECT COUNT(*) c FROM decisions").get() as { c: number }).c,
    ).toBe(1);
    // The row exists with its id; seq is NULL (column absent in legacy, defaults to NULL)
    const row = target
      .prepare("SELECT id, seq FROM decisions WHERE id='uuid-old-1'")
      .get() as { id: string; seq: number | null };
    expect(row.id).toBe("uuid-old-1");
    expect(row.seq).toBeNull();
    target.close();
  });
});

// tests/decisions/relocation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});

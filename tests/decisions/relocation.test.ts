// tests/decisions/relocation.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
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
});

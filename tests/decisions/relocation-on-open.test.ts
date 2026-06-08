// tests/decisions/relocation-on-open.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";

describe("openDecisionsDb relocation", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-open-reloc-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pulls legacy decisions into the new store when legacyPath is given", () => {
    const legacyPath = join(dir, "repo", ".cortex", "decisions.db");
    mkdirSync(join(dir, "repo", ".cortex"), { recursive: true });
    const legacy = openDecisionsDb(legacyPath);
    legacy.prepare(
      `INSERT INTO decisions (id, title, problem, resolution, rationale, status, tier, author, created_at, updated_at, seq)
       VALUES ('D-zzzz','t','','','','active','personal','me','2026-01-01','2026-01-01',1)`,
    ).run();
    legacy.close();

    const store = openDecisionsDb(join(dir, "store", "decisions.db"), legacyPath);
    expect(store.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 1 });
    store.close();
  });

  it("is a no-op when no legacyPath is passed (back-compat)", () => {
    const store = openDecisionsDb(join(dir, "store2", "decisions.db"));
    expect(store.prepare("SELECT COUNT(*) c FROM decisions").get()).toEqual({ c: 0 });
    store.close();
  });
});

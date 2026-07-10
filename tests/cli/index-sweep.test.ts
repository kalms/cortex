import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { runSweep } from "../../src/cli/commands/index.js";
import { slugCachePath } from "../../src/db/store-paths.js";

let tmp: string;
const saved = process.env.CTX_CACHE_DIR;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sweep-")); process.env.CTX_CACHE_DIR = join(tmp, "cache"); mkdirSync(join(tmp, "cache"), { recursive: true }); });
afterEach(() => { process.env.CTX_CACHE_DIR = saved; rmSync(tmp, { recursive: true, force: true }); });

describe("runSweep", () => {
  it("reaps the current repo's slug cache when canonical exists", () => {
    const root = join(tmp, "repo"); mkdirSync(join(root, ".cortex"), { recursive: true });
    const g = new BetterSqlite3(join(root, ".cortex", "db")); g.exec("CREATE TABLE nodes (id TEXT)"); g.prepare("INSERT INTO nodes VALUES ('ctx-1')").run(); g.close();
    writeFileSync(slugCachePath(root), "x");
    runSweep(root);
    expect(existsSync(slugCachePath(root))).toBe(false);
  });

  it("is a no-op when CORTEX_GC=0", () => {
    const saved2 = process.env.CORTEX_GC;
    process.env.CORTEX_GC = "0";
    try {
      const root = join(tmp, "repo2"); mkdirSync(join(root, ".cortex"), { recursive: true });
      const g = new BetterSqlite3(join(root, ".cortex", "db")); g.exec("CREATE TABLE nodes (id TEXT)"); g.prepare("INSERT INTO nodes VALUES ('ctx-1')").run(); g.close();
      writeFileSync(slugCachePath(root), "x");
      runSweep(root);
      expect(existsSync(slugCachePath(root))).toBe(true);
    } finally {
      process.env.CORTEX_GC = saved2;
    }
  });

  it("never throws when sweepCurrentRepo would fail (best-effort)", () => {
    // A repo root that doesn't exist — sweepCurrentRepo should degrade quietly.
    const root = join(tmp, "does-not-exist");
    expect(() => runSweep(root)).not.toThrow();
  });
});

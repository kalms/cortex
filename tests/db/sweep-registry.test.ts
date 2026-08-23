import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/db/registry.js";
import { sweepCurrentRepo } from "../../src/db/store-gc.js";

let dir: string;
let liveRepo: string;
let regPath: string;
const saved = {
  home: process.env.CORTEX_HOME,
  cache: process.env.CTX_CACHE_DIR,
  reg: process.env.CORTEX_REGISTRY_DB,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sweep-registry-"));
  process.env.CORTEX_HOME = dir;                  // durable root → dir/.cortex
  process.env.CTX_CACHE_DIR = join(dir, "cache"); // slug caches → dir/cache
  mkdirSync(join(dir, "cache"), { recursive: true });

  liveRepo = join(dir, "live-repo");
  mkdirSync(liveRepo, { recursive: true });
  regPath = join(dir, "registry.db");
  // `defaultRegistryPath()` honors this override — pointing it at the isolated
  // temp path keeps the opts-less call path (which resolves the registry
  // internally) from ever touching the real user registry.
  process.env.CORTEX_REGISTRY_DB = regPath;
});

afterEach(() => {
  process.env.CORTEX_HOME = saved.home;
  process.env.CTX_CACHE_DIR = saved.cache;
  if (saved.reg === undefined) delete process.env.CORTEX_REGISTRY_DB;
  else process.env.CORTEX_REGISTRY_DB = saved.reg;
  rmSync(dir, { recursive: true, force: true });
});

describe("sweepCurrentRepo — registry pruning", () => {
  it("prunes registry rows whose path no longer exists", () => {
    const reg = new Registry(regPath);
    reg.register("gone", join(dir, "removed-worktree"));
    reg.register("alive", liveRepo);
    reg.close();

    const res = sweepCurrentRepo(liveRepo, { registryPath: regPath });
    expect(res.prunedRows).toEqual(["gone"]);

    const after = new Registry(regPath);
    expect(after.findByName("gone")).toBeNull();
    expect(after.findByName("alive")).not.toBeNull();
    after.close();
  });

  it("never throws when the registry is unavailable", () => {
    expect(() => sweepCurrentRepo(liveRepo, { registryPath: "/nonexistent/x/r.db" })).not.toThrow();
  });

  it("calling with no opts (the production call path) does not throw and returns a prunedRows array", () => {
    // runSweep (src/cli/commands/index.ts) calls sweepCurrentRepo(repoRoot) with
    // no second argument at all — this must resolve `registryPath` to a real
    // default (defaultRegistryPath()), not silently skip pruning.
    const res = sweepCurrentRepo(liveRepo);
    expect(() => res).not.toThrow();
    expect(Array.isArray(res.prunedRows)).toBe(true);
  });
});

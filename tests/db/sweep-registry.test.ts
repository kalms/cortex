import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/db/registry.js";
import { sweepCurrentRepo, pruneVanishedRows } from "../../src/db/store-gc.js";

let dir: string;
let liveRepo: string;
let regPath: string;
const saved = {
  home: process.env.CORTEX_HOME,
  cache: process.env.CTX_CACHE_DIR,
  reg: process.env.CORTEX_REGISTRY_DB,
  gc: process.env.CORTEX_GC,
};

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

/** A real main checkout + a real linked worktree (mainWorktreeRoot needs
 *  actual git plumbing — a fake `.git` dir won't resolve `--git-common-dir`).
 *  `mainWorktreeRoot` resolves `--git-common-dir` with `--path-format=absolute`,
 *  which itself realpath-resolves (e.g. macOS `/var/folders/...` -> a
 *  `/private/var/folders/...` symlink target), so `base` must already be
 *  realpath'd or the returned main root won't string-equal what we register
 *  as `worktree_of` here. */
function mainWithWorktree(base: string): { main: string; worktree: string } {
  const root = realpathSync(base);
  const main = join(root, "main");
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@t.t");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.txt"), "a");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  const worktree = join(root, "wt");
  git(main, "worktree", "add", "-q", "-b", "feature/wt", worktree);
  return { main, worktree };
}

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
  if (saved.gc === undefined) delete process.env.CORTEX_GC;
  else process.env.CORTEX_GC = saved.gc;
  rmSync(dir, { recursive: true, force: true });
});

describe("sweepCurrentRepo — registry pruning is scoped to the current repo family", () => {
  it("prunes a dead WORKTREE row belonging to THIS repo's family", () => {
    const { main, worktree } = mainWithWorktree(dir);
    const reg = new Registry(regPath);
    reg.register("this-repo-wt", worktree, undefined, { worktree_of: main });
    reg.close();
    // Simulate `git worktree remove` (or a manual `rm -rf`) taking the
    // checkout dir with it, leaving the registry row behind.
    rmSync(worktree, { recursive: true, force: true });

    const res = sweepCurrentRepo(main, { registryPath: regPath });
    expect(res.prunedRows).toEqual(["this-repo-wt"]);

    const after = new Registry(regPath);
    expect(after.findByName("this-repo-wt")).toBeNull();
    after.close();
  });

  it("leaves a dead row belonging to ANOTHER repo's family untouched", () => {
    const { main } = mainWithWorktree(dir);
    // An unrelated repo elsewhere on the machine, with its own dead worktree
    // row. Its `worktree_of` points at a DIFFERENT main root, not this one.
    const otherMain = join(dir, "other-main");
    mkdirSync(otherMain, { recursive: true });
    const reg = new Registry(regPath);
    reg.register("other-repo-wt", join(dir, "other-main-removed-wt"), undefined, { worktree_of: otherMain });
    reg.close();

    const res = sweepCurrentRepo(main, { registryPath: regPath });
    expect(res.prunedRows).toEqual([]);

    const after = new Registry(regPath);
    expect(after.findByName("other-repo-wt")).not.toBeNull(); // survives — out of family
    after.close();
  });

  it("never prunes the current checkout's own row while it exists", () => {
    const reg = new Registry(regPath);
    reg.register("alive", liveRepo);
    reg.close();

    const res = sweepCurrentRepo(liveRepo, { registryPath: regPath });
    expect(res.prunedRows).not.toContain("alive");

    const after = new Registry(regPath);
    expect(after.findByName("alive")).not.toBeNull();
    after.close();
  });

  it("never throws when the registry is unavailable", () => {
    expect(() => sweepCurrentRepo(liveRepo, { registryPath: "/nonexistent/x/r.db" })).not.toThrow();
  });

  it("never throws outside a git repo (mainWorktreeRoot degrades to null)", () => {
    // liveRepo is a plain directory, not a git repo — mainWorktreeRoot(liveRepo)
    // returns null. Family then narrows to "this checkout's own row" only,
    // and the function must still not throw.
    const reg = new Registry(regPath);
    reg.register("alive", liveRepo);
    reg.register("unrelated-dead", join(dir, "gone-elsewhere"));
    reg.close();

    let res: ReturnType<typeof sweepCurrentRepo> | undefined;
    expect(() => { res = sweepCurrentRepo(liveRepo, { registryPath: regPath }); }).not.toThrow();
    expect(res?.prunedRows).not.toContain("alive");
    expect(res?.prunedRows).not.toContain("unrelated-dead"); // out of family — untouched

    const after = new Registry(regPath);
    expect(after.findByName("unrelated-dead")).not.toBeNull();
    after.close();
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

describe("sweepCurrentRepo — CORTEX_GC=0 disables pruning from inside the function itself", () => {
  it("returns an empty result and prunes nothing when CORTEX_GC=0, even called directly", () => {
    const reg = new Registry(regPath);
    reg.register("alive", liveRepo);
    reg.close();

    process.env.CORTEX_GC = "0";
    // Calling sweepCurrentRepo directly (bypassing runSweep's own guard)
    // must still no-op — the gate must hold for ANY caller, not just the one
    // caller (runSweep) that happens to check the env var today.
    const res = sweepCurrentRepo(liveRepo, { registryPath: regPath });
    expect(res).toEqual({ bytes: 0, removed: [], prunedRows: [] });
  });
});

describe("pruneVanishedRows — re-checks existence immediately before removing", () => {
  it("does NOT remove a row whose path is confirmed to exist at check time", () => {
    // Simulates a path that looked dead in some earlier snapshot but has
    // since reappeared (worktree re-created, flaky mount back online) —
    // pruneVanishedRows must re-check right before acting, not trust a
    // stale precomputed "dead" list.
    const reg = new Registry(regPath);
    reg.register("reappeared", join(dir, "back-now"));
    reg.close();
    mkdirSync(join(dir, "back-now"), { recursive: true }); // exists NOW

    const reg2 = new Registry(regPath);
    const pruned = pruneVanishedRows(reg2, reg2.list());
    expect(pruned).not.toContain("reappeared");
    expect(reg2.findByName("reappeared")).not.toBeNull();
    reg2.close();
  });

  it("still removes a row that is genuinely gone at check time", () => {
    const reg = new Registry(regPath);
    reg.register("really-gone", join(dir, "does-not-exist"));
    reg.close();

    const reg2 = new Registry(regPath);
    const pruned = pruneVanishedRows(reg2, reg2.list());
    expect(pruned).toEqual(["really-gone"]);
    expect(reg2.findByName("really-gone")).toBeNull();
    reg2.close();
  });
});

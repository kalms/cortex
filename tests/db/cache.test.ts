import BetterSqlite3 from "better-sqlite3";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { computeCacheKey, cachePath, hasCacheEntry, readCacheEntry, writeCacheEntry } from "../../src/db/cache.js";

describe("content-hash cache", () => {
  let repo: string;
  const createdKeys: string[] = [];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-cache-"));
    execSync(
      "git -c user.email=t@t -c user.name=t init && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
      { cwd: repo, stdio: "ignore" },
    );
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    // Cleanup any cache entries created during tests so ~/.cache/cortex/
    // doesn't accumulate junk across repeated runs.
    while (createdKeys.length) {
      const k = createdKeys.pop()!;
      rmSync(cachePath(k), { force: true });
    }
  });

  it("derives a stable cache key from repo state", () => {
    const k1 = computeCacheKey(repo);
    const k2 = computeCacheKey(repo);
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("key changes when repo tree changes", () => {
    const k1 = computeCacheKey(repo);
    writeFileSync(join(repo, "a.txt"), "hello");
    execSync("git -c user.email=t@t -c user.name=t add . && git -c user.email=t@t -c user.name=t commit -m a", {
      cwd: repo,
      stdio: "ignore",
    });
    const k2 = computeCacheKey(repo);
    expect(k1).not.toBe(k2);
  });

  it("derives distinct keys per index mode so a fast snapshot is never served for a full request", () => {
    const full = computeCacheKey(repo, "full");
    const fast = computeCacheKey(repo, "fast");
    const moderate = computeCacheKey(repo, "moderate");
    expect(full).not.toBe(fast);
    expect(full).not.toBe(moderate);
    expect(fast).not.toBe(moderate);
    // fast key is stable for the same repo+mode
    expect(computeCacheKey(repo, "fast")).toBe(fast);
  });

  it("keeps the full-mode key backward-compatible with the no-mode default", () => {
    // Existing cache entries were written without a mode; full must hash the
    // same so they stay valid after this change.
    expect(computeCacheKey(repo, "full")).toBe(computeCacheKey(repo));
  });

  it("writes and detects a cache entry", () => {
    const key = computeCacheKey(repo)!;
    createdKeys.push(key);
    const fakeDb = mkdtempSync(join(tmpdir(), "fake-db-"));
    writeFileSync(join(fakeDb, "db"), "fake sqlite bytes");
    writeCacheEntry(key, join(fakeDb, "db"));
    expect(hasCacheEntry(key)).toBe(true);
    expect(existsSync(cachePath(key))).toBe(true);
    rmSync(fakeDb, { recursive: true, force: true });
  });
  /**
   * The 2026-08-30 mislabel: a checkout served another checkout's whole store.
   *
   * A cached store is a whole SQLite file carrying its writer's `ctx_projects`
   * row and its project name baked into every `qualified_name`, so serving one
   * across checkouts hands over that identity entire. Two checkouts of one repo
   * on the same commit have the same tree BY DEFINITION — which is the normal
   * state of a worktree just branched from main — so a tree-only key made this
   * a certainty rather than a risk.
   */
  it("gives two checkouts of one repo distinct keys, even on an identical tree", () => {
    const other = join(repo, "..", `wt-${Date.now().toString(36)}`);
    execSync(`git -c user.email=t@t -c user.name=t worktree add -b second ${JSON.stringify(other)}`, {
      cwd: repo,
      stdio: "ignore",
    });
    try {
      // Same repo, same commit, same tree — the precondition, asserted so a
      // failure below cannot be misread as the trees having diverged.
      const treeOf = (d: string) =>
        execSync("git rev-parse HEAD^{tree}", { cwd: d, encoding: "utf8" }).trim();
      expect(treeOf(other)).toBe(treeOf(repo));

      expect(computeCacheKey(other)).not.toBe(computeCacheKey(repo));
    } finally {
      execSync(`git worktree remove --force ${JSON.stringify(other)}`, { cwd: repo, stdio: "ignore" });
    }
  });

  it("refuses a cached entry that declares another project, and drops it", () => {
    const key = computeCacheKey(repo)!;
    createdKeys.push(key);
    // A store from some other checkout: real SQLite, foreign ctx_projects row.
    const foreign = join(mkdtempSync(join(tmpdir(), "foreign-db-")), "db");
    const db = new BetterSqlite3(foreign);
    db.exec("CREATE TABLE ctx_projects (name TEXT, root_path TEXT)");
    db.prepare("INSERT INTO ctx_projects (name, root_path) VALUES (?, ?)")
      .run("Users-someone-else-repo", "/Users/someone/else/repo");
    db.close();
    writeCacheEntry(key, foreign);

    const dest = join(mkdtempSync(join(tmpdir(), "dest-db-")), "db");
    expect(readCacheEntry(key, dest, repo)).toBe(false);
    expect(existsSync(dest)).toBe(false);   // nothing published
    expect(hasCacheEntry(key)).toBe(false); // and the bad entry is gone
  });

  it("declines to key at all when the indexer version cannot be determined", () => {
    // The old code answered "unknown" here and kept going, which silently
    // removed version invalidation from every embedded deployment — the sidecar
    // runs with a cwd that is not the install root, so a cwd-relative
    // `bin/cortex-indexer` never resolved. Serving no cache is safe; keying on
    // a constant is not.
    const prev = process.env.CORTEX_INDEXER_PATH;
    process.env.CORTEX_INDEXER_PATH = join(tmpdir(), "definitely-not-an-indexer");
    try {
      expect(computeCacheKey(repo)).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.CORTEX_INDEXER_PATH;
      else process.env.CORTEX_INDEXER_PATH = prev;
    }
  });
});

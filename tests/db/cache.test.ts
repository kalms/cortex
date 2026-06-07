import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { computeCacheKey, cachePath, hasCacheEntry, writeCacheEntry } from "../../src/db/cache.js";

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
    const key = computeCacheKey(repo);
    createdKeys.push(key);
    const fakeDb = mkdtempSync(join(tmpdir(), "fake-db-"));
    writeFileSync(join(fakeDb, "db"), "fake sqlite bytes");
    writeCacheEntry(key, join(fakeDb, "db"));
    expect(hasCacheEntry(key)).toBe(true);
    expect(existsSync(cachePath(key))).toBe(true);
    rmSync(fakeDb, { recursive: true, force: true });
  });
});

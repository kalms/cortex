import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { reapFile, archiveDecisionDir, reapRepoSlugCache, sweepCurrentRepo } from "../../src/db/store-gc.js";

let tmp: string;
const saved = { home: process.env.CORTEX_HOME, cache: process.env.CTX_CACHE_DIR };
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gca-"));
  process.env.CORTEX_HOME = tmp;                       // durable root → tmp/.cortex
  process.env.CTX_CACHE_DIR = join(tmp, "cache");      // slug caches → tmp/cache
  mkdirSync(join(tmp, "cache"), { recursive: true });
});
afterEach(() => {
  process.env.CORTEX_HOME = saved.home; process.env.CTX_CACHE_DIR = saved.cache;
  rmSync(tmp, { recursive: true, force: true });
});

function graph(root: string) {
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const db = new BetterSqlite3(join(root, ".cortex", "db"));
  db.exec("CREATE TABLE nodes (id TEXT)"); db.prepare("INSERT INTO nodes VALUES ('ctx-1')").run(); db.close();
}

it("reapFile removes the db and its wal/shm and reports bytes", () => {
  const f = join(tmp, "x.db"); writeFileSync(f, "abc"); writeFileSync(f + "-wal", "de");
  const bytes = reapFile(f);
  expect(bytes).toBeGreaterThan(0);
  expect(existsSync(f)).toBe(false);
  expect(existsSync(f + "-wal")).toBe(false);
});

it("archiveDecisionDir moves the dir under _archive, never deletes", () => {
  const repoId = "abc-123";
  const dir = join(tmp, ".cortex", repoId); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "decisions.db"), "data");
  const dest = archiveDecisionDir(repoId);
  expect(dest).toBe(join(tmp, ".cortex", "_archive", repoId));
  expect(existsSync(join(dest!, "decisions.db"))).toBe(true);
  expect(existsSync(dir)).toBe(false);
});

it("reapRepoSlugCache reaps only when canonical graph exists", () => {
  const withGraph = join(tmp, "wg"); graph(withGraph);
  const slug = join(tmp, "cache", "" + withGraph.replace(/^\//, "").replace(/\//g, "-") + ".db");
  writeFileSync(slug, "x");
  expect(reapRepoSlugCache(withGraph)).toBeGreaterThan(0);
  expect(existsSync(slug)).toBe(false);
});

it("sweepCurrentRepo removes this repo's slug + stale tmp-ctx_incr, keeps fresh ones", () => {
  const root = join(tmp, "repo"); graph(root);
  const slug = join(tmp, "cache", root.replace(/^\//, "").replace(/\//g, "-") + ".db");
  writeFileSync(slug, "x");
  const stale = join(tmp, "cache", "tmp-ctx_incr_OLD.db"); writeFileSync(stale, "x");
  const old = Date.now() / 1000 - 2 * 86400; utimesSync(stale, old, old);
  const fresh = join(tmp, "cache", "tmp-ctx_incr_NEW.db"); writeFileSync(fresh, "x");
  const res = sweepCurrentRepo(root, { maxStagingAgeMs: 86400_000 });
  expect(existsSync(slug)).toBe(false);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  expect(res.bytes).toBeGreaterThan(0);
});

it("sweepCurrentRepo reaps a stale db.stage-* but leaves a fresh one alone", () => {
  const root = join(tmp, "repo2"); graph(root);
  const staleStage = join(root, ".cortex", "db.stage-1111"); writeFileSync(staleStage, "x");
  const old = Date.now() / 1000 - 2 * 86400; utimesSync(staleStage, old, old);
  const freshStage = join(root, ".cortex", "db.stage-2222"); writeFileSync(freshStage, "x");
  const res = sweepCurrentRepo(root, { maxStagingAgeMs: 86400_000 });
  expect(existsSync(staleStage)).toBe(false);
  expect(existsSync(freshStage)).toBe(true);
  expect(res.removed).toContain(staleStage);
  expect(res.removed).not.toContain(freshStage);
});

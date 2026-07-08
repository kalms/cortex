// tests/cli/index-reap.test.ts — unit-level: publishing leaves no slug cache when guard passes
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { reapRepoSlugCache } from "../../src/db/store-gc.js";
import { slugCachePath } from "../../src/db/store-paths.js";

let tmp: string;
const saved = process.env.CTX_CACHE_DIR;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "reap-")); process.env.CTX_CACHE_DIR = join(tmp, "cache"); mkdirSync(join(tmp, "cache"), { recursive: true }); });
afterEach(() => { process.env.CTX_CACHE_DIR = saved; rmSync(tmp, { recursive: true, force: true }); });

it("after a successful index (canonical populated), the slug cache is reaped", () => {
  const root = join(tmp, "repo");
  mkdirSync(join(root, ".cortex"), { recursive: true });
  const g = new BetterSqlite3(join(root, ".cortex", "db")); g.exec("CREATE TABLE nodes (id TEXT)"); g.prepare("INSERT INTO nodes VALUES ('ctx-1')").run(); g.close();
  writeFileSync(slugCachePath(root), "stale");   // the copy the indexer left behind
  reapRepoSlugCache(root);                        // <-- what the write path now calls
  expect(existsSync(slugCachePath(root))).toBe(false);
});

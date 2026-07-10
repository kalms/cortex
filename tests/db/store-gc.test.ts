import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import {
  isEmptyDecisionDir, hasValidCanonicalGraph, isReapableSlugCache, isStaleStaging,
} from "../../src/db/store-gc.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "gc-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function makeDecisionsDb(dir: string, rows: number) {
  mkdirSync(dir, { recursive: true });
  const db = new BetterSqlite3(join(dir, "decisions.db"));
  db.exec("CREATE TABLE decisions (id TEXT PRIMARY KEY)");
  for (let i = 0; i < rows; i++) db.prepare("INSERT INTO decisions (id) VALUES (?)").run(`D-${i}`);
  db.close();
}
function makeGraphDb(repoRoot: string, nodes: number) {
  mkdirSync(join(repoRoot, ".cortex"), { recursive: true });
  const db = new BetterSqlite3(join(repoRoot, ".cortex", "db"));
  db.exec("CREATE TABLE nodes (id TEXT)");
  for (let i = 0; i < nodes; i++) db.prepare("INSERT INTO nodes (id) VALUES (?)").run(`ctx-${i}`);
  db.close();
}

it("isEmptyDecisionDir: 0 rows → true, ≥1 → false, unreadable → false (keep)", () => {
  const empty = join(tmp, "empty"); makeDecisionsDb(empty, 0);
  const full = join(tmp, "full"); makeDecisionsDb(full, 3);
  expect(isEmptyDecisionDir(empty)).toBe(true);
  expect(isEmptyDecisionDir(full)).toBe(false);
  expect(isEmptyDecisionDir(join(tmp, "missing"))).toBe(false);
});

it("hasValidCanonicalGraph: populated → true, absent → false", () => {
  const root = join(tmp, "r"); makeGraphDb(root, 5);
  expect(hasValidCanonicalGraph(root)).toBe(true);
  expect(hasValidCanonicalGraph(join(tmp, "nope"))).toBe(false);
});

it("isReapableSlugCache: canonical exists → reap; path gone → reap; else keep", () => {
  const withGraph = join(tmp, "wg"); makeGraphDb(withGraph, 2);
  expect(isReapableSlugCache(withGraph)).toBe(true);            // canonical replacement exists
  expect(isReapableSlugCache(join(tmp, "gone"))).toBe(true);    // path gone
  const noGraph = join(tmp, "ng"); mkdirSync(noGraph);
  expect(isReapableSlugCache(noGraph)).toBe(false);             // only copy — keep
});

it("isStaleStaging: older than maxAge → true", () => {
  const f = join(tmp, "tmp-ctx_incr_x.db"); writeFileSync(f, "x");
  const twoDaysAgo = Date.now() / 1000 - 2 * 86400;
  utimesSync(f, twoDaysAgo, twoDaysAgo);
  expect(isStaleStaging(f, Date.now(), 86400_000)).toBe(true);
  expect(isStaleStaging(f, Date.now(), 7 * 86400_000)).toBe(false);
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { captureIndexMeta } from "../../src/graph/capture-index-meta.js";
import { readIndexMeta } from "../../src/graph/index-meta.js";

const git = (repo: string, a: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });

describe("captureIndexMeta", () => {
  let repo: string, dbPath: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-cap-"));
    git(repo, ["init"]); writeFileSync(join(repo, "a.txt"), "x");
    git(repo, ["add", "."]); git(repo, ["commit", "-m", "init"]);
    dbPath = join(repo, "db");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("captures HEAD + dirty-sig + timestamp into the DB", () => {
    captureIndexMeta(dbPath, repo);
    const db = new Database(dbPath);
    try {
      const m = readIndexMeta(db)!;
      expect(m.indexed_commit).toMatch(/^[0-9a-f]{40}$/);
      expect(m.indexed_dirty_sig).toMatch(/^[0-9a-f]{40}$/);
      expect(m.indexed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally { db.close(); }
  });

  it("is a no-op when CORTEX_FRESHNESS=0", () => {
    const prev = process.env.CORTEX_FRESHNESS;
    process.env.CORTEX_FRESHNESS = "0";
    try {
      captureIndexMeta(dbPath, repo);
      const db = new Database(dbPath);
      try { expect(readIndexMeta(db)).toBeNull(); } finally { db.close(); }
    } finally { process.env.CORTEX_FRESHNESS = prev; }
  });
});

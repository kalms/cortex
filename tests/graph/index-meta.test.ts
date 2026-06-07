import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { writeIndexMeta, readIndexMeta } from "../../src/graph/index-meta.js";

describe("index-meta", () => {
  let dir: string, dbPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-meta-")); dbPath = join(dir, "db"); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns null when the table does not exist", () => {
    const db = new Database(dbPath);
    try { expect(readIndexMeta(db)).toBeNull(); } finally { db.close(); }
  });

  it("writes and reads back a baseline (idempotent upsert)", () => {
    writeIndexMeta(dbPath, { indexed_commit: "abc", indexed_dirty_sig: "sig1", indexed_at: "2026-06-07T00:00:00Z" });
    writeIndexMeta(dbPath, { indexed_commit: "def", indexed_dirty_sig: "sig2", indexed_at: "2026-06-07T01:00:00Z" });
    const db = new Database(dbPath);
    try {
      expect(readIndexMeta(db)).toEqual({ indexed_commit: "def", indexed_dirty_sig: "sig2", indexed_at: "2026-06-07T01:00:00Z" });
    } finally { db.close(); }
  });

  it("tolerates a null commit (non-git index)", () => {
    writeIndexMeta(dbPath, { indexed_commit: null, indexed_dirty_sig: null, indexed_at: "2026-06-07T00:00:00Z" });
    const db = new Database(dbPath);
    try {
      const m = readIndexMeta(db)!;
      expect(m.indexed_commit).toBeNull();
      expect(m.indexed_at).toBe("2026-06-07T00:00:00Z");
    } finally { db.close(); }
  });
});

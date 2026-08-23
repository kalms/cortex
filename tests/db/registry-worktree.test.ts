// tests/db/registry-worktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Registry } from "../../src/db/registry.js";

let dir: string, dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-reg-")); dbPath = join(dir, "r.db"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("registry worktree columns", () => {
  it("stores and returns worktree_of and branch", () => {
    const r = new Registry(dbPath);
    r.register("wt-proj", "/tmp/wt", "2026-08-23T00:00:00Z", { worktree_of: "/tmp/main", branch: "feature/x" });
    const row = r.findByName("wt-proj")!;
    expect(row.worktree_of).toBe("/tmp/main");
    expect(row.branch).toBe("feature/x");
    r.close();
  });

  it("defaults both to null for a main checkout", () => {
    const r = new Registry(dbPath);
    r.register("main-proj", "/tmp/main");
    const row = r.findByName("main-proj")!;
    expect(row.worktree_of).toBeNull();
    expect(row.branch).toBeNull();
    r.close();
  });

  it("migrates a pre-existing registry additively and idempotently", () => {
    const raw = new BetterSqlite3(dbPath);
    raw.exec(`CREATE TABLE repos (name TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, indexed_at TEXT NOT NULL)`);
    raw.prepare("INSERT INTO repos VALUES (?,?,?)").run("old", "/tmp/old", "2026-01-01T00:00:00Z");
    raw.close();

    for (const _ of [1, 2]) {          // idempotent: opening twice must not throw
      const r = new Registry(dbPath);
      const row = r.findByName("old")!;
      expect(row.root_path).toBe("/tmp/old");
      expect(row.worktree_of).toBeNull();
      r.close();
    }
  });
});

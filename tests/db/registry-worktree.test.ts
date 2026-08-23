// tests/db/registry-worktree.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

/**
 * Regression — finding 3: `register()` must not NULL out checkout metadata
 * when a caller passes no `meta`.
 *
 * `importLegacyRegistry` and `migrateCacheToRegistry` both call the 3-arg form,
 * and `startViewerServer` runs both on EVERY server start. A name collision
 * (a leftover `~/.cache/cortex-indexer/<worktree-slug>.db`, or a worktree row
 * in the legacy `_registry.db`) therefore cleared `worktree_of` — which removes
 * `cortex doctor`'s carve-out, so `doctor --fix` would prune the very rows the
 * per-worktree-index feature creates.
 */
describe("registry register() — metadata preservation", () => {
  it("preserves worktree_of/branch when re-registered WITHOUT meta", () => {
    const r = new Registry(dbPath);
    r.register("wt-proj", "/tmp/wt", "2026-08-23T00:00:00Z", {
      worktree_of: "/tmp/main",
      branch: "feature/x",
    });
    // What importLegacyRegistry / migrateCacheToRegistry do on every boot.
    r.register("wt-proj", "/tmp/wt", "2026-08-24T00:00:00Z");
    const row = r.findByName("wt-proj")!;
    expect(row.worktree_of).toBe("/tmp/main");
    expect(row.branch).toBe("feature/x");
    expect(row.indexed_at).toBe("2026-08-24T00:00:00Z"); // still refreshed
    r.close();
  });

  it("preserves the other field when only one is supplied", () => {
    const r = new Registry(dbPath);
    r.register("wt-proj", "/tmp/wt", "2026-08-23T00:00:00Z", {
      worktree_of: "/tmp/main",
      branch: "feature/x",
    });
    r.register("wt-proj", "/tmp/wt", "2026-08-24T00:00:00Z", { branch: "feature/y" });
    const row = r.findByName("wt-proj")!;
    expect(row.worktree_of).toBe("/tmp/main");
    expect(row.branch).toBe("feature/y");
    r.close();
  });

  it("an EXPLICIT null still clears the field (a worktree promoted to a main checkout)", () => {
    const r = new Registry(dbPath);
    r.register("wt-proj", "/tmp/wt", "2026-08-23T00:00:00Z", {
      worktree_of: "/tmp/main",
      branch: "feature/x",
    });
    r.register("wt-proj", "/tmp/wt", "2026-08-24T00:00:00Z", { worktree_of: null, branch: null });
    const row = r.findByName("wt-proj")!;
    expect(row.worktree_of).toBeNull();
    expect(row.branch).toBeNull();
    r.close();
  });

  it("survives the migration pass startViewerServer runs on every boot", async () => {
    const { migrateCacheToRegistry } = await import("../../src/db/registry-migration.js");
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir, { recursive: true });
    // A leftover cache slug for the SAME project name as the worktree row.
    const slug = new BetterSqlite3(join(cacheDir, "wt-proj.db"));
    slug.exec("CREATE TABLE ctx_projects (name TEXT, root_path TEXT, indexed_at TEXT)");
    slug.prepare("INSERT INTO ctx_projects VALUES (?,?,?)")
      .run("wt-proj", "/tmp/wt", "2026-01-01T00:00:00Z");
    slug.close();

    const r = new Registry(dbPath);
    r.register("wt-proj", "/tmp/wt", "2026-08-23T00:00:00Z", {
      worktree_of: "/tmp/main",
      branch: "feature/x",
    });
    migrateCacheToRegistry(r, cacheDir);
    const row = r.findByName("wt-proj")!;
    expect(row.worktree_of).toBe("/tmp/main");
    expect(row.branch).toBe("feature/x");
    r.close();
  });
});

/**
 * Regression — finding 2: `listProjectsUnified` must MERGE the registry row's
 * checkout metadata (`worktree_of` / `branch`) into a project the bound store
 * already knows, instead of skipping the registry row wholesale.
 *
 * The registry is the ONLY source of `worktree_of`/`branch`. The bound store's
 * `ctx_projects` always lists the served checkout, so a plain
 * `if (out.has(r.name)) continue;` guaranteed the active project could never
 * carry them — and the viewer's `"<name> @ <branch>"` label, the headline of
 * the per-worktree-index work, could never render for the checkout actually
 * being served.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { Registry } from "../../src/db/registry.js";
import { listProjectsUnified } from "../../src/graph/code-queries.js";

let dir: string;
let store: GraphStore;
let prevRegistry: string | undefined;

/** Write the `ctx_projects` row the indexer creates for a served checkout. */
function seedBoundProject(dbPath: string, name: string, rootPath: string): void {
  const db = new BetterSqlite3(dbPath);
  db.exec(
    "CREATE TABLE IF NOT EXISTS ctx_projects (name TEXT PRIMARY KEY, root_path TEXT, indexed_at TEXT)",
  );
  db.prepare("INSERT OR REPLACE INTO ctx_projects VALUES (?, ?, ?)").run(
    name,
    rootPath,
    "2026-08-23T00:00:00.000Z",
  );
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cortex-lpu-"));
  mkdirSync(join(dir, "store"), { recursive: true });
  prevRegistry = process.env.CORTEX_REGISTRY_DB;
  process.env.CORTEX_REGISTRY_DB = join(dir, "registry.db");
  seedBoundProject(join(dir, "store", "db"), "r-wt-x", "/r/wt-x");
  store = new GraphStore(join(dir, "store", "db"));
});

afterEach(() => {
  store?.close();
  if (prevRegistry === undefined) delete process.env.CORTEX_REGISTRY_DB;
  else process.env.CORTEX_REGISTRY_DB = prevRegistry;
  rmSync(dir, { recursive: true, force: true });
});

describe("listProjectsUnified — registry metadata merge", () => {
  it("carries worktree_of/branch onto a project the bound store already lists", () => {
    const registry = new Registry();
    registry.register("r-wt-x", "/r/wt-x", "2026-08-23T00:00:00.000Z", {
      worktree_of: "/r/main",
      branch: "feature/x",
    });
    registry.close();

    const row = listProjectsUnified(store).find((p) => p.name === "r-wt-x");
    expect(row).toBeDefined();
    expect(row!.worktree_of).toBe("/r/main");
    expect(row!.branch).toBe("feature/x");
  });

  it("does not let the registry row clobber store-derived fields", () => {
    const registry = new Registry();
    // Deliberately divergent root_path/indexed_at — the bound store wins.
    registry.register("r-wt-x", "/r/wt-x", "2020-01-01T00:00:00.000Z", {
      worktree_of: "/r/main",
      branch: "feature/x",
    });
    registry.close();

    const row = listProjectsUnified(store).find((p) => p.name === "r-wt-x")!;
    expect(row.root_path).toBe("/r/wt-x");
    expect(row.indexed_at).toBe("2026-08-23T00:00:00.000Z");
  });

  it("leaves a main checkout's metadata null (no phantom worktree_of)", () => {
    const registry = new Registry();
    registry.register("r-wt-x", "/r/wt-x", "2026-08-23T00:00:00.000Z");
    registry.close();

    const row = listProjectsUnified(store).find((p) => p.name === "r-wt-x")!;
    expect(row.worktree_of ?? null).toBeNull();
    expect(row.branch ?? null).toBeNull();
  });

  it("still folds in registry-only projects the bound store has never seen", () => {
    const registry = new Registry();
    registry.register("r-other", "/r/other", "2026-08-23T00:00:00.000Z", {
      worktree_of: null,
      branch: "main",
    });
    registry.close();

    const names = listProjectsUnified(store).map((p) => p.name).sort();
    expect(names).toEqual(["r-other", "r-wt-x"]);
  });
});

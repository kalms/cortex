// tests/graph/open-project-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";
import { openProjectStore } from "../../src/graph/code-queries.js";
import { Registry } from "../../src/db/registry.js";

function seedGraph(path: string, project: string, label: string) {
  const db = new BetterSqlite3(path);
  db.exec(`CREATE TABLE nodes (id TEXT, kind TEXT, name TEXT, qualified_name TEXT,
    file_path TEXT, data TEXT, project TEXT)`);
  db.prepare(`INSERT INTO nodes VALUES (?,?,?,?,?,?,?)`).run(
    "n1", "file", "a.ts", "p.a", "src/a.ts", JSON.stringify({ frame_label: label }), project);
  db.close();
}

describe("openProjectStore — registry-driven resolution", () => {
  let repoDir: string;
  let cacheDir: string;
  let regDir: string;
  let bound: GraphStore;
  let registry: Registry;
  const project = "Users-x-repo";

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "repo-"));
    cacheDir = mkdtempSync(join(tmpdir(), "cache-"));
    regDir = mkdtempSync(join(tmpdir(), "reg-"));
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    mkdirSync(join(repoDir, ".cortex"), { recursive: true });
    // .cortex/db = NEW label; cache = STALE label.
    seedGraph(join(repoDir, ".cortex", "db"), project, "infrastructure");
    seedGraph(join(cacheDir, `${project}.db`), project, "cluster:21");
    bound = new GraphStore(":memory:");
    registry = new Registry(join(regDir, "_registry.db"));
    registry.register(project, repoDir, "t");
  });
  afterEach(() => {
    bound.close();
    registry.close();
    for (const d of [repoDir, cacheDir, regDir]) rmSync(d, { recursive: true, force: true });
  });

  it("reads .cortex/db (not the stale cache) for a registered non-bound project", () => {
    const resolved = openProjectStore(bound, "other-bound-project", project, { registry });
    expect(resolved).not.toBeNull();
    try {
      const row = resolved!.store.queryRaw<{ label: string }>(
        "SELECT json_extract(data,'$.frame_label') AS label FROM nodes LIMIT 1", [])[0];
      expect(row?.label).toBe("infrastructure");
    } finally {
      if (resolved!.owned) resolved!.store.close();
    }
  });

  it("returns the bound store unchanged for the bound project", () => {
    const resolved = openProjectStore(bound, project, project, { registry });
    expect(resolved).toEqual({ store: bound, owned: false });
  });

  it("returns null for an unknown project", () => {
    const resolved = openProjectStore(bound, "bound", "no-such-project", { registry });
    expect(resolved).toBeNull();
  });
});

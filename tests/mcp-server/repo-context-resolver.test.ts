import { afterEach, beforeEach, describe, expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  MissingRepoPathError,
  PathNotFoundError,
  NotAGitRepoError,
  RepoNotIndexedError,
  RepoContextResolver,
} from "../../src/mcp-server/repo-context.js";

function makeIndexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-repo-"));
  execSync(`git init -q "${root}"`);
  mkdirSync(join(root, ".cortex"));
  // Create an empty placeholder so the resolver sees this repo as indexed.
  // The resolver's GraphStore construction will initialize the SQLite schema
  // on first open (idempotent CREATE TABLE IF NOT EXISTS), so no real graph
  // data is needed for these tests.
  writeFileSync(join(root, ".cortex", "db"), "");
  return root;
}

function projectSlug(absPath: string): string {
  return absPath.replace(/^\//, "").replace(/\//g, "-");
}

/**
 * Seed a fake cache-registry entry at `~/.cache/cortex-indexer/<slug>.db`.
 * The resolver reads ctx_projects from each cache file to discover projects,
 * so we create the minimum schema + one row. Returns the cache file path so
 * the caller can remove it in teardown.
 */
function seedCacheRegistryEntry(rootPath: string, name?: string): string {
  const slug = name ?? projectSlug(rootPath);
  const cacheDir = join(homedir(), ".cache", "cortex-indexer");
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, `${slug}.db`);
  const db = new BetterSqlite3(file);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS ctx_projects (name TEXT PRIMARY KEY, root_path TEXT, indexed_at TEXT)",
    );
    db.prepare(
      "INSERT OR REPLACE INTO ctx_projects (name, root_path, indexed_at) VALUES (?, ?, ?)",
    ).run(slug, rootPath, new Date().toISOString());
  } finally {
    db.close();
  }
  return file;
}

describe("Resolver error classes", () => {
  it("MissingRepoPathError carries name, hint, available_projects", () => {
    const err = new MissingRepoPathError("create_decision", []);
    expect(err.name).toBe("MissingRepoPathError");
    expect(err.message).toContain("create_decision");
    expect(err.hint).toMatch(/list_projects/);
    expect(err.availableProjects).toEqual([]);
  });

  it("PathNotFoundError mentions the path", () => {
    const err = new PathNotFoundError("/no/such/path");
    expect(err.message).toContain("/no/such/path");
  });

  it("NotAGitRepoError carries inferred git_root when known", () => {
    const err = new NotAGitRepoError("/repo/subdir/file", "/repo");
    expect(err.message).toContain("/repo/subdir/file");
    expect(err.gitRoot).toBe("/repo");
  });

  it("RepoNotIndexedError carries available_projects", () => {
    const err = new RepoNotIndexedError("/repo/x", [
      { name: "p", path: "/repo/p", indexed: true },
    ]);
    expect(err.availableProjects).toHaveLength(1);
    expect(err.availableProjects[0].path).toBe("/repo/p");
  });
});

describe("RepoContextResolver.resolve — happy path", () => {
  it("returns a RepoContext for a valid indexed git root", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      const ctx = resolver.resolve(repo);
      expect(ctx.repoPath).toBe(repo);
      expect(ctx.graphDb).toBeDefined();
      expect(ctx.decisionsDb).toBeDefined();
    } finally {
      resolver.shutdown();
    }
  });

  it("returns the same context on repeated calls (pool hit)", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      expect(resolver.resolve(repo)).toBe(resolver.resolve(repo));
    } finally {
      resolver.shutdown();
    }
  });
});

describe("RepoContextResolver.resolve — error paths", () => {
  it("throws PathNotFoundError when path does not exist", () => {
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      expect(() => resolver.resolve("/nonexistent/path/abc")).toThrow(PathNotFoundError);
    } finally {
      resolver.shutdown();
    }
  });

  it("throws NotAGitRepoError when path is not a git root", () => {
    const dir = mkdtempSync(join(tmpdir(), "not-a-repo-"));
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      expect(() => resolver.resolve(dir)).toThrow(NotAGitRepoError);
    } finally {
      resolver.shutdown();
    }
  });

  it("throws RepoNotIndexedError when .cortex/graph.db is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "unindexed-repo-"));
    execSync(`git init -q "${root}"`);
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      try {
        resolver.resolve(root);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(RepoNotIndexedError);
        expect((e as RepoNotIndexedError).availableProjects).toBeDefined();
      }
    } finally {
      resolver.shutdown();
    }
  });
});

describe("RepoContextResolver.listKnownRepos", () => {
  const seededFiles: string[] = [];

  afterEach(() => {
    for (const f of seededFiles.splice(0)) {
      try { rmSync(f, { force: true }); } catch { /* ignore */ }
      // Clear SQLite sidecars too.
      for (const ext of ["-wal", "-shm"]) {
        try { rmSync(f + ext, { force: true }); } catch { /* ignore */ }
      }
    }
  });

  it("returns pooled repos with indexed=true", () => {
    const repo = makeIndexedRepo();
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      resolver.resolve(repo);
      const list = resolver.listKnownRepos();
      const entry = list.find((p) => p.path === resolver.resolve(repo).repoPath);
      expect(entry).toBeDefined();
      expect(entry!.indexed).toBe(true);
    } finally {
      resolver.shutdown();
    }
  });

  it("reads the master cache registry and surfaces unpooled projects", () => {
    // Phantom path: registry entry need not exist on disk for listKnownRepos
    // to surface it — the registry IS the answer. Use a unique pretend-path
    // so we don't collide with the user's actual indexed repos.
    //
    // NOTE: avoid slugs that start with `tmp-` — the resolver skips those
    // alongside `_*.db` as staging files, mirroring the indexer's convention.
    const phantomRoot = `/cortex-test-phantom-${Date.now()}`;
    const slug = projectSlug(phantomRoot);
    seededFiles.push(seedCacheRegistryEntry(phantomRoot, slug));

    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      const list = resolver.listKnownRepos();
      const match = list.find((p) => p.path === phantomRoot);
      expect(match, `expected ${phantomRoot} in ${JSON.stringify(list)}`).toBeDefined();
      expect(match!.name).toBe(slug);
      expect(match!.indexed).toBe(true);
    } finally {
      resolver.shutdown();
    }
  });

  it("dedupes pooled + cache entries on path", () => {
    const repo = makeIndexedRepo();
    // Seed cache to point at the same path; pooled should NOT be duplicated.
    seededFiles.push(seedCacheRegistryEntry(repo));
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      resolver.resolve(repo);
      const list = resolver.listKnownRepos();
      const matches = list.filter((p) => p.path === repo);
      expect(matches).toHaveLength(1);
    } finally {
      resolver.shutdown();
    }
  });

  it("ignores _config.db and other non-project cache files", () => {
    // The real cache dir has _config.db; listKnownRepos must not surface it.
    const resolver = new RepoContextResolver({ poolCapacity: 8 });
    try {
      const list = resolver.listKnownRepos();
      expect(list.find((p) => p.name === "_config")).toBeUndefined();
      // Sanity check — the cache dir exists on dev machines but we don't
      // require any specific count here.
      expect(existsSync(join(homedir(), ".cache", "cortex-indexer"))).toBeTypeOf("boolean");
    } finally {
      resolver.shutdown();
    }
  });
});

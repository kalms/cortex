import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
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

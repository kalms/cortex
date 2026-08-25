import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepoContextResolver,
  RepoNotIndexedError,
  WorktreeIndexPendingError,
} from "../../src/mcp-server/repo-context.js";

function indexedGitRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-resolve-")));
  execSync(`git init -q "${root}"`);
  execSync(`git -C "${root}" commit -q --allow-empty -m init`);
  mkdirSync(join(root, ".cortex"));
  writeFileSync(join(root, ".cortex", "db"), "");
  return root;
}

describe("resolve() — canonical routing", () => {
  // Fixture dirs (and, for the worktree case, the linked worktree dir) created
  // by each test, torn down after so repeated runs leave no stray tmp dirs.
  const cleanupPaths: string[] = [];

  afterEach(() => {
    while (cleanupPaths.length > 0) {
      rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
    }
  });

  it("routes a subdir to the canonical root instead of throwing", () => {
    const root = indexedGitRepo();
    cleanupPaths.push(root);
    const sub = join(root, "packages", "x");
    mkdirSync(sub, { recursive: true });
    const resolver = new RepoContextResolver({ poolCapacity: 4 });
    expect(resolver.resolve(sub).repoPath).toBe(root);
  });

  it("resolves a worktree to itself (checkout axis), not the canonical root, when it has its own store", () => {
    // Two-axis model: the graph/store side no longer collapses a linked
    // worktree onto the canonical repo. `worktreeOf` still exposes the
    // canonical root for callers that need repo identity.
    const root = indexedGitRepo();
    cleanupPaths.push(root);
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-resolve-wt-")));
    cleanupPaths.push(wt);
    execSync(`git -C "${root}" worktree add -q "${wt}"`);
    mkdirSync(join(wt, ".cortex"));
    writeFileSync(join(wt, ".cortex", "db"), "");
    const resolver = new RepoContextResolver({ poolCapacity: 4 });
    const ctx = resolver.resolve(wt);
    expect(ctx.repoPath).toBe(wt);
    expect(ctx.worktreeOf).toBe(root);
  });

  it("refuses (never falls back to the canonical root) when the worktree has no store of its own — strict reads", () => {
    // Re-fixtured: this used to assert the Stage 1 transitional fallback
    // served the canonical repo's store here (`servedFrom: "canonical"`).
    // That fallback — and the field annotating it — is gone. A worktree with
    // nothing of its own is refused even though `root` is fully indexed.
    const root = indexedGitRepo();
    cleanupPaths.push(root);
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-resolve-wt-")));
    cleanupPaths.push(wt);
    execSync(`git -C "${root}" worktree add -q "${wt}"`);
    const prevAutoIndex = process.env.CORTEX_AUTO_INDEX;
    process.env.CORTEX_AUTO_INDEX = "0"; // no real background index against a scratch fixture
    try {
      const resolver = new RepoContextResolver({ poolCapacity: 4 });
      try {
        resolver.resolve(wt);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(RepoNotIndexedError);
        expect(e).not.toBeInstanceOf(WorktreeIndexPendingError);
      }
    } finally {
      if (prevAutoIndex === undefined) delete process.env.CORTEX_AUTO_INDEX;
      else process.env.CORTEX_AUTO_INDEX = prevAutoIndex;
    }
  });

  it("serves an indexed non-git directory (no NotAGitRepoError)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nogit-idx-")));
    cleanupPaths.push(dir);
    mkdirSync(join(dir, ".cortex"));
    writeFileSync(join(dir, ".cortex", "db"), "");
    const resolver = new RepoContextResolver({ poolCapacity: 4 });
    expect(resolver.resolve(dir).repoPath).toBe(dir);
  });

  it("throws RepoNotIndexedError for a non-git dir with no store", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nogit-empty-")));
    cleanupPaths.push(dir);
    const prevAutoIndex = process.env.CORTEX_AUTO_INDEX;
    process.env.CORTEX_AUTO_INDEX = "0"; // no real background index against a scratch fixture
    try {
      const resolver = new RepoContextResolver({ poolCapacity: 4 });
      expect(() => resolver.resolve(dir)).toThrow(RepoNotIndexedError);
    } finally {
      if (prevAutoIndex === undefined) delete process.env.CORTEX_AUTO_INDEX;
      else process.env.CORTEX_AUTO_INDEX = prevAutoIndex;
    }
  });
});

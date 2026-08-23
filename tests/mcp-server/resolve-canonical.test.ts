import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoContextResolver, RepoNotIndexedError } from "../../src/mcp-server/repo-context.js";

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

  it("resolves a worktree to itself (checkout axis), not the canonical root", () => {
    // Two-axis model: the graph/store side no longer collapses a linked
    // worktree onto the canonical repo. `worktreeOf` still exposes the
    // canonical root for callers that need repo identity. The worktree here
    // has no `.cortex/` of its own, so the Stage 1 transitional fallback in
    // resolveGraphDbForRead serves the canonical repo's store — surfaced via
    // servedFrom: "canonical".
    const root = indexedGitRepo();
    cleanupPaths.push(root);
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-resolve-wt-")));
    cleanupPaths.push(wt);
    execSync(`git -C "${root}" worktree add -q "${wt}"`);
    const resolver = new RepoContextResolver({ poolCapacity: 4 });
    const ctx = resolver.resolve(wt);
    expect(ctx.repoPath).toBe(wt);
    expect(ctx.worktreeOf).toBe(root);
    expect(ctx.servedFrom).toBe("canonical");
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
    const resolver = new RepoContextResolver({ poolCapacity: 4 });
    expect(() => resolver.resolve(dir)).toThrow(RepoNotIndexedError);
  });
});

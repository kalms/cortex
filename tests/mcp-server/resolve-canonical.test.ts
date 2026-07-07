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

  it("collapses a worktree to the canonical root", () => {
    const root = indexedGitRepo();
    cleanupPaths.push(root);
    const wt = realpathSync(mkdtempSync(join(tmpdir(), "cortex-resolve-wt-")));
    cleanupPaths.push(wt);
    execSync(`git -C "${root}" worktree add -q "${wt}"`);
    const resolver = new RepoContextResolver({ poolCapacity: 4 });
    expect(resolver.resolve(wt).repoPath).toBe(root);
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

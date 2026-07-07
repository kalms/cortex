// tests/db/git-root.test.ts
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync, realpathSync, mkdirSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainWorktreeRoot, canonicalRepoPath } from "../../src/db/git-root.js";

describe("mainWorktreeRoot", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-gitroot-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    // Hermetic identity — the worktree test commits, which fails with
    // "Author identity unknown" on machines/CI with no global git user set.
    execFileSync("git", ["config", "user.email", "ci@cortex.test"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Cortex CI"], { cwd: root });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns the repo root from the repo root", () => {
    expect(mainWorktreeRoot(root)).toBe(root);
  });

  it("returns the main worktree root from a linked worktree", () => {
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
    const wt = join(root, "..", "wt-" + Math.abs(root.length));
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: root });
    try {
      expect(mainWorktreeRoot(realpathSync(wt))).toBe(root);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: root });
    }
  });

  it("returns null outside any git repo", () => {
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "cortex-nogit-")));
    try { expect(mainWorktreeRoot(bare)).toBeNull(); }
    finally { rmSync(bare, { recursive: true, force: true }); }
  });
});

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-canon-"));
  execSync(`git init -q "${root}"`);
  execSync(`git -C "${root}" commit -q --allow-empty -m init`);
  return realpathSync(root);
}

describe("canonicalRepoPath", () => {
  let root: string;
  beforeAll(() => { root = gitRepo(); });

  it("returns the root unchanged for the git root itself", () => {
    expect(canonicalRepoPath(root)).toBe(root);
  });

  it("collapses a subdir to the git root", () => {
    const sub = join(root, "packages", "app");
    mkdirSync(sub, { recursive: true });
    expect(canonicalRepoPath(sub)).toBe(root);
  });

  it("collapses a worktree to the canonical root", () => {
    const wt = join(tmpdir(), `cortex-canon-wt-${Date.now()}`);
    execSync(`git -C "${root}" worktree add -q "${wt}"`);
    expect(canonicalRepoPath(wt)).toBe(root);
    mkdirSync(join(wt, "packages"), { recursive: true });
    expect(canonicalRepoPath(join(wt, "packages"))).toBe(root); // existing worktree subdir → canonical root
  });

  it("returns the realpath for a non-git directory", () => {
    const plain = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
    expect(canonicalRepoPath(plain)).toBe(realpathSync(plain));
  });

  it("returns an absolute path for a non-existent non-git path without throwing", () => {
    const missing = join(tmpdir(), "cortex-does-not-exist-xyz");
    expect(canonicalRepoPath(missing)).toBe(missing);
  });
});

// tests/db/git-root.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mainWorktreeRoot } from "../../src/db/git-root.js";

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

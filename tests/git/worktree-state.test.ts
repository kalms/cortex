import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitHead, gitDirtySig, gitCommitsBehind, isGitRepo, gitBranch } from "../../src/git/worktree-state.js";

const git = (repo: string, args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });

describe("worktree-state", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-wt-"));
    git(repo, ["init"]);
    writeFileSync(join(repo, "a.txt"), "one");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reports HEAD, clean dirty-sig, and git-repo status", () => {
    expect(isGitRepo(repo)).toBe(true);
    expect(gitHead(repo)).toMatch(/^[0-9a-f]{40}$/);
    const clean = gitDirtySig(repo);
    expect(gitDirtySig(repo)).toBe(clean); // stable when nothing changes
  });

  it("dirty-sig changes when the working tree changes", () => {
    const clean = gitDirtySig(repo);
    writeFileSync(join(repo, "a.txt"), "two");
    expect(gitDirtySig(repo)).not.toBe(clean);
  });

  it("counts commits ahead of a base commit", () => {
    const base = gitHead(repo)!;
    writeFileSync(join(repo, "b.txt"), "x");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "second"]);
    expect(gitCommitsBehind(repo, base)).toBe(1);
  });

  it("returns nulls / false outside a git repo", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
    expect(isGitRepo(notRepo)).toBe(false);
    expect(gitHead(notRepo)).toBeNull();
    expect(gitDirtySig(notRepo)).toBeNull();
    rmSync(notRepo, { recursive: true, force: true });
  });

  it("gitBranch returns the current branch name", () => {
    // beforeEach's `git init` defaults to whatever the environment's
    // init.defaultBranch is; read it back rather than assuming "main".
    const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    expect(gitBranch(repo)).toBe(branch);
  });

  it("gitBranch returns null on a detached HEAD (git prints the literal 'HEAD')", () => {
    const sha = gitHead(repo)!;
    git(repo, ["checkout", "--detach", sha]);
    expect(gitBranch(repo)).toBeNull();
  });

  it("gitBranch returns null for a non-git path", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
    expect(gitBranch(notRepo)).toBeNull();
    rmSync(notRepo, { recursive: true, force: true });
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeRoot } from "../../src/db/git-root.js";
import { mainWorktreeRoot, canonicalRepoPath } from "../../src/db/git-root.js";

let base: string, main: string, wt: string;

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-wtroot-")));
  main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-b", "main");
  git(main, "config", "user.email", "t@t.t");
  git(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.txt"), "a");
  git(main, "add", "-A");
  git(main, "commit", "-m", "init");
  wt = join(base, "wt");
  git(main, "worktree", "add", "-b", "feature/x", wt);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("worktreeRoot", () => {
  it("returns the checkout itself for a main checkout", () => {
    expect(worktreeRoot(main)).toBe(main);
  });

  it("returns the WORKTREE for a linked worktree — not the main checkout", () => {
    expect(worktreeRoot(wt)).toBe(wt);
    expect(mainWorktreeRoot(wt)).toBe(main); // the identity axis still collapses
  });

  it("collapses a subdirectory to its own checkout root", () => {
    const sub = join(wt, "src", "deep");
    mkdirSync(sub, { recursive: true });
    expect(worktreeRoot(sub)).toBe(wt);
  });

  it("falls back to canonicalRepoPath outside a git repo", () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect(worktreeRoot(plain)).toBe(canonicalRepoPath(plain));
  });

  it("is identical to canonicalRepoPath in a main checkout", () => {
    expect(worktreeRoot(main)).toBe(canonicalRepoPath(main));
  });
});

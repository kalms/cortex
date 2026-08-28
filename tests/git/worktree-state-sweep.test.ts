import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChangedFiles, gitKnownBranches, gitHead } from "../../src/git/worktree-state.js";
import { concludedBranches } from "../../src/staleness/sweep.js";

function repoWithCommit(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-sweep-git-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", root, "config", "user.name", "T"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "seed"]);
  return root;
}

describe("gitChangedFiles", () => {
  it("names files committed since the given base", () => {
    const root = repoWithCommit();
    const base = gitHead(root)!;
    writeFileSync(join(root, "src", "b.ts"), "export const b = 2;\n");
    execFileSync("git", ["-C", root, "add", "."]);
    execFileSync("git", ["-C", root, "commit", "-q", "--no-gpg-sign", "-m", "second"]);
    const changed = gitChangedFiles(root, base);
    expect(changed).not.toBeNull();
    expect(changed!.has("src/b.ts")).toBe(true);
    expect(changed!.has("src/a.ts")).toBe(false);
  });

  it("includes dirty working-tree files alongside committed ones", () => {
    const root = repoWithCommit();
    const base = gitHead(root)!;
    writeFileSync(join(root, "src", "a.ts"), "export const a = 99;\n");
    const changed = gitChangedFiles(root, base)!;
    expect(changed.has("src/a.ts")).toBe(true);
  });

  it("returns null outside a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-nogit-"));
    expect(gitChangedFiles(dir, null)).toBeNull();
  });

  it("returns null when the base commit no longer exists", () => {
    const root = repoWithCommit();
    expect(gitChangedFiles(root, "0".repeat(40))).toBeNull();
  });
});

describe("gitKnownBranches", () => {
  it("lists local heads", () => {
    const root = repoWithCommit();
    execFileSync("git", ["-C", root, "branch", "feature/x"]);
    const known = gitKnownBranches(root)!;
    expect(known.has("feature/x")).toBe(true);
    expect(known.size).toBeGreaterThan(0);
  });

  it("strips the remote prefix and drops origin/HEAD", () => {
    const root = repoWithCommit();
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/landed", "HEAD"]);
    execFileSync("git", ["-C", root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/landed"]);
    const known = gitKnownBranches(root)!;
    expect(known.has("landed")).toBe(true);
    expect(known.has("origin/landed")).toBe(false);
    expect(known.has("HEAD")).toBe(false);
  });

  it("strips a single-segment remote from a MULTI-segment branch name", () => {
    // The load-bearing case: origin_branch stores "feature/x", and the
    // remote-tracking ref is refs/remotes/origin/feature/x.
    const root = repoWithCommit();
    execFileSync("git", ["-C", root, "remote", "add", "origin", "https://example.invalid/r.git"]);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/feature/x", "HEAD"]);
    const known = gitKnownBranches(root)!;
    expect(known.has("feature/x")).toBe(true);
    expect(known.has("origin/feature/x")).toBe(false);
  });

  it("strips a remote whose own NAME contains a slash", () => {
    const root = repoWithCommit();
    execFileSync("git", ["-C", root, "remote", "add", "upstream/mirror", "https://example.invalid/r.git"]);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/upstream/mirror/feature/x", "HEAD"]);
    const known = gitKnownBranches(root)!;
    expect(known.has("feature/x")).toBe(true);
    expect(known.has("mirror/feature/x")).toBe(false);
  });

  it("names files inside an untracked DIRECTORY, not just the directory", () => {
    const root = repoWithCommit();
    const base = gitHead(root)!;
    mkdirSync(join(root, "newdir"), { recursive: true });
    writeFileSync(join(root, "newdir", "x.ts"), "export const x = 1;\n");
    const changed = gitChangedFiles(root, base)!;
    expect(changed.has("newdir/x.ts")).toBe(true);
  });

  it("returns null outside a git repo", () => {
    expect(gitKnownBranches(mkdtempSync(join(tmpdir(), "cortex-nogit-")))).toBeNull();
  });
});

describe("C4 end to end: gitKnownBranches feeding concludedBranches", () => {
  it("does not conclude a branch that exists ONLY as a remote-tracking ref", () => {
    const root = repoWithCommit();
    execFileSync("git", ["-C", root, "remote", "add", "origin", "https://example.invalid/r.git"]);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/feature/x", "HEAD"]);
    // No local head for feature/x — only the remote-tracking ref.
    expect(concludedBranches(["feature/x"], gitKnownBranches(root))).toEqual([]);
  });

  it("concludes a branch git knows nothing about, and un-concludes it when recreated", () => {
    const root = repoWithCommit();
    expect(concludedBranches(["feature/x"], gitKnownBranches(root))).toEqual(["feature/x"]);
    execFileSync("git", ["-C", root, "branch", "feature/x"]);
    expect(concludedBranches(["feature/x"], gitKnownBranches(root))).toEqual([]);
  });
});

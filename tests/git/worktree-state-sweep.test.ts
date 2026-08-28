import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChangedFiles, gitKnownBranches, gitHead } from "../../src/git/worktree-state.js";

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

  it("returns null outside a git repo", () => {
    expect(gitKnownBranches(mkdtempSync(join(tmpdir(), "cortex-nogit-")))).toBeNull();
  });
});

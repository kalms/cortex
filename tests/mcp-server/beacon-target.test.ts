// tests/mcp-server/beacon-target.test.ts
// Unit tests for beacon path → registry row resolution. Uses a real Registry on
// a temp db (better-sqlite3 has no useful in-memory shortcut here) plus real
// on-disk dirs, so realpath behaviour is exercised rather than mocked.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registry } from "../../src/db/registry.js";
import { resolveBeaconTarget } from "../../src/mcp-server/beacon-target.js";

describe("resolveBeaconTarget", () => {
  let dir: string;
  let reg: Registry;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-beacon-")));
    reg = new Registry(join(dir, "registry.db"));
  });
  afterEach(() => {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a registered checkout to its own row", () => {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    reg.register("repo", repo, "t");
    expect(resolveBeaconTarget(repo, reg)).toEqual({ name: "repo", root_path: repo });
  });

  it("resolves a registered worktree to ITSELF, not its parent", () => {
    const main = join(dir, "repo");
    const wt = join(dir, "repo-wt");
    mkdirSync(main); mkdirSync(wt);
    reg.register("repo", main, "t");
    reg.register("repo-wt", wt, "t", { worktree_of: main, branch: "feature/x" });
    expect(resolveBeaconTarget(wt, reg)).toEqual({ name: "repo-wt", root_path: wt });
  });

  it("returns null for an unregistered path", () => {
    expect(resolveBeaconTarget(join(dir, "nope"), reg)).toBeNull();
  });

  it("returns null for a non-existent path without throwing", () => {
    expect(() => resolveBeaconTarget("/definitely/not/here", reg)).not.toThrow();
    expect(resolveBeaconTarget("/definitely/not/here", reg)).toBeNull();
  });

  it("resolves a path given in symlinked form to a row stored realpath'd", () => {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    reg.register("real", real, "t");
    expect(resolveBeaconTarget(link, reg)).toEqual({ name: "real", root_path: real });
  });

  it("resolves a path given realpath'd to a row stored in symlinked form", () => {
    const real = join(dir, "real2");
    const link = join(dir, "link2");
    mkdirSync(real);
    symlinkSync(real, link);
    reg.register("link2", link, "t");     // stored unresolved
    expect(resolveBeaconTarget(real, reg)).toEqual({ name: "link2", root_path: link });
  });
});

describe("resolveBeaconTarget — repo-identity fallback", () => {
  let dir: string;
  let reg: Registry;
  let repo: string;
  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-beacon-git-")));
    reg = new Registry(join(dir, "registry.db"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    git(["init", "-q", "-b", "main"], repo);
    git(["config", "user.email", "t@t.t"], repo);
    git(["config", "user.name", "t"], repo);
    git(["commit", "-q", "--allow-empty", "-m", "init"], repo);
  });
  afterEach(() => {
    reg.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a subdir of a registered checkout up to the checkout", () => {
    const sub = join(repo, "src", "deep");
    mkdirSync(sub, { recursive: true });
    reg.register("repo", repo, "t");
    expect(resolveBeaconTarget(sub, reg)).toEqual({ name: "repo", root_path: repo });
  });

  it("resolves an UNregistered worktree to its registered parent", () => {
    const wt = join(dir, "repo-wt");
    git(["worktree", "add", "-q", "-b", "wt", wt], repo);
    reg.register("repo", repo, "t");
    expect(resolveBeaconTarget(wt, reg)).toEqual({ name: "repo", root_path: repo });
  });
});

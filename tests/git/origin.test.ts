import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOrigin } from "../../src/git/origin.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "cortex-origin-"));
  dirs.push(d);
  return d;
}
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}
function repo(): string {
  const d = tmp();
  git(d, ["init", "-b", "main"]);
  git(d, ["config", "user.email", "t@t.t"]);
  git(d, ["config", "user.name", "t"]);
  writeFileSync(join(d, "f.txt"), "one");
  git(d, ["add", "."]);
  git(d, ["commit", "-m", "one"]);
  return d;
}

let prevThread: string | undefined;
beforeEach(() => { prevThread = process.env.CORTEX_THREAD_ID; delete process.env.CORTEX_THREAD_ID; });
afterEach(() => {
  if (prevThread === undefined) delete process.env.CORTEX_THREAD_ID;
  else process.env.CORTEX_THREAD_ID = prevThread;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("captureOrigin", () => {
  it("reads branch and commit in a main checkout", () => {
    const d = repo();
    const o = captureOrigin(d);
    expect(o.branch).toBe("main");
    expect(o.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(o.thread).toBeNull();
  });

  it("reads the WORKTREE's branch, not the main checkout's", () => {
    const main = repo();
    const wt = join(tmp(), "wt");
    git(main, ["worktree", "add", "-b", "feature/x", wt]);
    const o = captureOrigin(wt);
    expect(o.branch).toBe("feature/x");           // not "main"
    expect(captureOrigin(main).branch).toBe("main");
  });

  it("returns a null branch but a real commit on detached HEAD", () => {
    const d = repo();
    const head = git(d, ["rev-parse", "HEAD"]);
    git(d, ["checkout", "--detach", head]);
    const o = captureOrigin(d);
    expect(o.branch).toBeNull();
    expect(o.commit).toBe(head);
  });

  it("returns all-null on a non-git directory and does not throw", () => {
    expect(captureOrigin(tmp())).toEqual({ branch: null, commit: null, thread: null });
  });

  it("returns all-null for a path that does not exist", () => {
    expect(() => captureOrigin("/no/such/path/anywhere")).not.toThrow();
    expect(captureOrigin("/no/such/path/anywhere").branch).toBeNull();
  });

  it("prefers an explicit thread over the environment", () => {
    process.env.CORTEX_THREAD_ID = "from-env";
    expect(captureOrigin(repo(), "explicit").thread).toBe("explicit");
  });

  it("falls back to CORTEX_THREAD_ID when no thread is supplied", () => {
    process.env.CORTEX_THREAD_ID = "from-env";
    expect(captureOrigin(repo()).thread).toBe("from-env");
  });

  it("treats an empty-string thread as absent", () => {
    process.env.CORTEX_THREAD_ID = "";
    expect(captureOrigin(repo(), "").thread).toBeNull();
  });
});

import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashGovernedSource } from "../../src/decisions/reconciliation.js";

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), "cortex-basis-")); dirs.push(d); return d; }
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("basis hash anchoring", () => {
  it("hashes the WORKTREE's file content, not the canonical checkout's", () => {
    // main checkout: governed file says "main"
    const main = tmp();
    git(main, ["init", "-b", "main"]);
    git(main, ["config", "user.email", "t@t.t"]);
    git(main, ["config", "user.name", "t"]);
    writeFileSync(join(main, "src.ts"), "export const V = 'main';\n");
    git(main, ["add", "."]);
    git(main, ["commit", "-m", "one"]);

    // linked worktree on a branch where the same file says "worktree"
    const wt = join(tmp(), "wt");
    git(main, ["worktree", "add", "-b", "feature/x", wt]);
    writeFileSync(join(wt, "src.ts"), "export const V = 'worktree';\n");

    const refs = [{ target_kind: "path", target_ref: "src.ts" }];
    const fromWorktree = hashGovernedSource(wt, refs);
    const fromCanonical = hashGovernedSource(main, refs);

    // THE assertion: the two trees differ, so the two hashes must differ.
    // If a create path anchored to the canonical root, a decision authored in
    // the worktree would record `fromCanonical` — a reference to a tree the
    // author never edited, which can never detect their own change.
    expect(fromWorktree).not.toBe(fromCanonical);
  });

  it("is stable when the two trees agree", () => {
    const main = tmp();
    git(main, ["init", "-b", "main"]);
    git(main, ["config", "user.email", "t@t.t"]);
    git(main, ["config", "user.name", "t"]);
    writeFileSync(join(main, "src.ts"), "same\n");
    git(main, ["add", "."]);
    git(main, ["commit", "-m", "one"]);
    const wt = join(tmp(), "wt");
    git(main, ["worktree", "add", "-b", "feature/y", wt]);

    const refs = [{ target_kind: "path", target_ref: "src.ts" }];
    expect(hashGovernedSource(wt, refs)).toBe(hashGovernedSource(main, refs));
  });
});

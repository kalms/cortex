import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(process.cwd(), "hooks/suggest-capture.sh");

let repo: string;

function git(...args: string[]): void {
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
}

/** Run the hook with the fixture repo as cwd; return its stdout. */
function run(): string {
  return execFileSync("bash", [HOOK], { cwd: repo, encoding: "utf-8" });
}

describe("suggest-capture.sh — commit reminder vs merge drafting trigger", () => {
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-suggest-capture-"));
    execFileSync("git", ["init", "--initial-branch=main", repo]);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "--no-gpg-sign", "-m", "feat(core): seed");
    // Second commit: `git diff-tree HEAD` is empty on a root commit (no
    // --root in the hook), so the code-touched nudge only fires from the
    // second commit onward — assert against a non-root HEAD.
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    git("add", ".");
    git("commit", "--no-gpg-sign", "-m", "fix(core): bump");
  });

  afterAll(() => {
    try { rmSync(repo, { recursive: true }); } catch { /* ignore */ }
  });

  it("on an ordinary commit, prints the capture reminder (no drafting block)", () => {
    const out = run();
    expect(out).toContain("Were any architectural or design decisions made");
    expect(out).not.toContain("A branch was just merged");
    // Code file touched → the reindex nudge is present.
    expect(out).toContain("detect_changes");
  });

  it("on a merge commit, prints the warm-path drafting instructions", () => {
    git("checkout", "-b", "feature/y");
    writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
    git("add", ".");
    git("commit", "--no-gpg-sign", "-m", "feat(api): branch work");
    git("checkout", "main");
    git("merge", "--no-ff", "--no-gpg-sign", "-m", "merge feature/y", "feature/y");

    const out = run();
    expect(out).toContain("A branch was just merged");
    expect(out).toContain('candidates", base:"HEAD^1"');
    expect(out).toContain('author:"cortex:draft"');
    expect(out).toContain("promote");
    expect(out).not.toContain("Were any architectural or design decisions made");
  });

  it("degrades to the plain reminder outside a git repo", () => {
    const out = execFileSync("bash", [HOOK], { cwd: tmpdir(), encoding: "utf-8" });
    expect(out).toContain("Were any architectural or design decisions made");
    expect(out).not.toContain("A branch was just merged");
  });
});

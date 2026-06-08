import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("decisions store is shared across worktrees", () => {
  let root: string; let home: string; let prevHome: string | undefined;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cw-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: root });
    home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cwhome-")));
    prevHome = process.env.HOME; process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("a linked worktree resolves to the SAME decisions DB as main", () => {
    const mainPath = resolveDecisionsDbPath(root);
    execFileSync("git", ["add", "cortex.json"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "repo-id"], { cwd: root });

    const wt = join(root, "..", "cw-wt-" + Math.abs(root.length));
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: root });
    try {
      expect(resolveDecisionsDbPath(realpathSync(wt))).toBe(mainPath);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: root });
    }
  });
});

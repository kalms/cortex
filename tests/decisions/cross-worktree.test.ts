import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("decisions store is shared across worktrees", () => {
  let root: string;
  let home: string;
  let prevCortexHome: string | undefined;
  let prevDecisionsDb: string | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cw-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"],
      { cwd: root },
    );
    home = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cwhome-")));
    prevCortexHome = process.env.CORTEX_HOME;
    process.env.CORTEX_HOME = home;
    // Save and delete CORTEX_DECISIONS_DB so an override can't turn this into
    // a trivial identity check (the env var short-circuits ensureRepoId entirely).
    prevDecisionsDb = process.env.CORTEX_DECISIONS_DB;
    delete process.env.CORTEX_DECISIONS_DB;
  });

  afterEach(() => {
    if (prevCortexHome === undefined) delete process.env.CORTEX_HOME;
    else process.env.CORTEX_HOME = prevCortexHome;
    if (prevDecisionsDb === undefined) delete process.env.CORTEX_DECISIONS_DB;
    else process.env.CORTEX_DECISIONS_DB = prevDecisionsDb;
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("a linked worktree resolves to the SAME decisions DB as main", () => {
    // Call resolveDecisionsDbPath on the main worktree first.  This mints and
    // writes cortex.json UNTRACKED in the main working dir — it is intentionally
    // NOT committed, so the linked worktree's checkout won't contain it.  The
    // test is thereby load-bearing on mainWorktreeRoot: if the worktree path
    // were resolved as its own root, ensureRepoId would mint a DIFFERENT id
    // there and the two paths would diverge.
    const mainPath = resolveDecisionsDbPath(root);

    // Use a unique temp dir as the worktree to avoid collisions across parallel
    // test runs (a sibling path derived from root.length would be the same every
    // run in the same session).
    const wtBase = realpathSync(mkdtempSync(join(tmpdir(), "cortex-cwwt-")));
    const wt = join(wtBase, "wt");
    execFileSync("git", ["worktree", "add", "-q", wt], { cwd: root });
    try {
      expect(resolveDecisionsDbPath(realpathSync(wt))).toBe(mainPath);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", wt], { cwd: root });
      rmSync(wtBase, { recursive: true, force: true });
    }
  });
});

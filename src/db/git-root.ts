// src/db/git-root.ts
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Resolve the MAIN worktree root for `startDir` — the directory containing the
 * primary repo's `.git`. For a linked worktree this is the original checkout,
 * not the worktree, so every worktree of a repo resolves to one identity.
 * Returns null when `startDir` is not inside a git repo.
 */
export function mainWorktreeRoot(startDir: string): string | null {
  try {
    const commonDir = execFileSync(
      "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: startDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!commonDir) return null;
    // commonDir is "<mainRoot>/.git" → parent is the main worktree root.
    const resolved = resolve(dirname(commonDir));
    try {
      return realpathSync(resolved);
    } catch {
      return resolved;
    }
  } catch {
    return null;
  }
}

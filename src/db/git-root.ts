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

/**
 * Canonical repo root for any path: the main-worktree root when `path` is
 * inside a git repo (worktrees and subdirs collapse to it), else the path's
 * own realpath (or an absolute literal when it does not exist). Never throws —
 * the single canonicalizer both the index entry points and the read resolver
 * route through so no code path re-derives its own notion of "root".
 */
export function canonicalRepoPath(path: string): string {
  const root = mainWorktreeRoot(path);
  if (root) return root;
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Resolve the CHECKOUT root for `startDir` — the working tree the caller is
 * actually standing in. A linked worktree resolves to ITSELF (unlike
 * {@link mainWorktreeRoot}, which collapses it to the main checkout); a
 * subdirectory collapses to its own checkout root.
 *
 * This is the "checkout axis" of the two-axis model: graph store, staging,
 * index lock, freshness baseline, registry row, and every governed-source hash
 * anchor derive from it. The "repo-identity axis" (repoId, decisions store)
 * stays on {@link mainWorktreeRoot}.
 *
 * In a main checkout the two axes are byte-identical. Never throws; outside a
 * git repo it degrades to {@link canonicalRepoPath}.
 */
export function worktreeRoot(startDir: string): string {
  try {
    const top = execFileSync(
      "git", ["rev-parse", "--show-toplevel"],
      { cwd: startDir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (top) {
      try {
        return realpathSync(top);
      } catch {
        return resolve(top);
      }
    }
  } catch {
    /* fall through */
  }
  return canonicalRepoPath(startDir);
}

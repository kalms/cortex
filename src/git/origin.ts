import { gitBranch, gitHead } from "./worktree-state.js";

/** Git identity for one authored row. Every field is independently nullable:
 *  a detached HEAD has a commit but no branch, a non-git directory has neither. */
export interface OriginFields {
  branch: string | null;
  commit: string | null;
  thread: string | null;
}

/**
 * Read the git identity of `path`, best-effort.
 *
 * MUST NEVER THROW. Provenance is metadata attached to a write, not the write
 * itself — a broken or absent git must degrade to NULLs, never fail a caller's
 * decision/todo/story creation.
 *
 * `path` must be the CHECKOUT root (`ctx.repoPath` after the 2.0.0 two-axis
 * split), so a linked worktree reports its own branch rather than the main
 * checkout's. Passing a canonical root here reintroduces exactly the defect
 * per-worktree indexing removed.
 */
export function captureOrigin(path: string, thread?: string | null): OriginFields {
  let branch: string | null = null;
  let commit: string | null = null;
  // An empty path must read as "no git identity", not as the CALLING PROCESS's
  // identity. `git -C ""` is treated by git as if no -C were given, so it would
  // silently report this process's own branch/commit and attribute the row to a
  // checkout it never came from — confidently wrong, which is the exact failure
  // this feature exists to remove. Only branch/commit are suppressed: `thread`
  // is independent of the path and still resolves below.
  if (path !== "") {
    try {
      branch = gitBranch(path);   // null on detached HEAD, by design
      commit = gitHead(path);     // recorded even when detached
    } catch {
      /* best-effort: a non-git path, a missing binary, a vanished directory */
    }
  }
  const supplied = thread ?? process.env.CORTEX_THREAD_ID ?? null;
  return { branch, commit, thread: supplied === "" ? null : supplied };
}

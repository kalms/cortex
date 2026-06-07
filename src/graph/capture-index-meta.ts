import { writeIndexMeta } from "./index-meta.js";
import { gitHead, gitDirtySig } from "../git/worktree-state.js";

/** Capture the freshness baseline for `repoPath` into the graph DB at `dbPath`.
 *  Called as a post-index step by both index paths. Best-effort + gated by
 *  CORTEX_FRESHNESS=0. Uses an injectable `now` for deterministic tests. */
export function captureIndexMeta(dbPath: string, repoPath: string, now: () => Date = () => new Date()): void {
  if (process.env.CORTEX_FRESHNESS === "0") return;
  writeIndexMeta(dbPath, {
    indexed_commit: gitHead(repoPath),
    indexed_dirty_sig: gitDirtySig(repoPath),
    indexed_at: now().toISOString(),
  });
}

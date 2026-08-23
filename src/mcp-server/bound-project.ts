// src/mcp-server/bound-project.ts
import type { GraphStore } from "../graph/store.js";
import { worktreeRoot } from "../db/git-root.js";

export interface BoundProject {
  /** The checkout root the lookup was keyed on — what gets reported to the
   *  user in the "indexed project" / "not indexed" startup lines. */
  readonly root: string;
  /** The indexed project name for `root`, or null when the bound store has no
   *  matching `ctx_projects` row (or no `ctx_projects` table at all). */
  readonly project: string | null;
  /** True when the bound store has no `ctx_projects` table yet — a first run
   *  where the indexer has never written. Distinguished from "table exists but
   *  has no row for this root" only so the startup message can be accurate. */
  readonly noIndexerState: boolean;
}

/**
 * Resolve which indexed project the server is bound to, given the store it
 * opened and the directory it was launched from.
 *
 * **Checkout axis.** The root is {@link worktreeRoot}, matching the axis the
 * store path itself is derived on (`resolveCortexDbPath`) and the axis
 * `index_repository` writes `ctx_projects.root_path` on. Using the identity
 * axis ({@link import("../db/git-root.js").canonicalRepoPath}) here instead
 * would query a worktree's own store with the MAIN checkout's path, which
 * never matches — leaving the viewer dropdown at "(no projects)",
 * `/api/projects.active` null, and `hello.project_id` empty on a perfectly
 * well-indexed worktree. That is the same class of failure T-a1kg originally
 * fixed for the opposite case (a worktree querying the main checkout's store
 * with a raw cwd); both are cured by keeping the lookup key on the same axis
 * as the store.
 *
 * Never throws: a missing `ctx_projects` table (first run, before any index)
 * resolves to `{ project: null, noIndexerState: true }`.
 */
export function resolveBoundProject(store: GraphStore, cwd: string): BoundProject {
  let root = cwd;
  try {
    root = worktreeRoot(cwd);
  } catch {
    /* not a git repo — raw cwd */
  }

  try {
    const row = store.queryRaw<{ name: string }>(
      "SELECT name FROM ctx_projects WHERE root_path = ? LIMIT 1",
      [root],
    )[0];
    return { root, project: row ? row.name : null, noIndexerState: false };
  } catch (e) {
    // ctx_projects doesn't exist yet — first run, indexer hasn't created it.
    if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
    return { root, project: null, noIndexerState: true };
  }
}

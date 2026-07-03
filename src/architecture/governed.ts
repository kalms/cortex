import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../db/resolve-path.js";
import { openDecisionsDb } from "../decisions/db.js";

/** One governance link: the governing entity's id and the code ref it governs. */
export interface GovernanceRef {
  id: string;   // decision id or todo id
  ref: string;  // code ref governed (path or qualified name)
}

/** Active-decision and open-todo GOVERNS links for a repo, for per-module counts. */
export interface Governance {
  decisions: GovernanceRef[];  // GOVERNS links of active decisions
  todos: GovernanceRef[];      // GOVERNS links of non-terminal (open) todos
}

const EMPTY: Governance = { decisions: [], todos: [] };

/**
 * Load the (id, code-ref) GOVERNS links for active decisions and open todos from
 * the shared decisions store. The caller buckets each ref by module and counts
 * DISTINCT ids, so `governing_decisions` is a true decision count and `open_todos`
 * a true todo count. Best-effort: returns empty on any failure (missing/locked DB).
 */
export function loadGovernance(root: string): Governance {
  try {
    const ddb = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
    try {
      const decisions = ddb.prepare(
        `SELECT dl.decision_id AS id, dl.target_ref AS ref
           FROM decision_links dl
           JOIN decisions d ON d.id = dl.decision_id
          WHERE dl.relation = 'GOVERNS'
            AND dl.target_kind IN ('path','qn')
            AND d.status = 'active'`,
      ).all() as GovernanceRef[];
      const todos = ddb.prepare(
        `SELECT tl.todo_id AS id, tl.target_ref AS ref
           FROM todo_links tl
           JOIN todos t ON t.id = tl.todo_id
          WHERE tl.relation = 'GOVERNS'
            AND tl.target_kind IN ('path','qn','file')
            AND t.state NOT IN ('done','cancelled')`,
      ).all() as GovernanceRef[];
      return { decisions, todos };
    } finally {
      ddb.close();
    }
  } catch {
    return EMPTY;
  }
}

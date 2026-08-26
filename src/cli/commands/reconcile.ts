import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../db/resolve-path.js";
import { openDecisionsDb } from "../../decisions/db.js";
import { DecisionsRepository } from "../../decisions/repository.js";
import { DecisionLinksRepository } from "../../decisions/links-repository.js";
import { hashGovernedSource, type GovernedRef } from "../../decisions/reconciliation.js";
import { worktreeRoot } from "../../db/git-root.js";

/** Count active, reconcilable decisions whose governed hash drifted. Pure-ish:
 *  takes the repos so it is unit-testable without path resolution. */
export function countDriftedDecisions(
  repoPath: string, decisions: DecisionsRepository, links: DecisionLinksRepository,
): number {
  let n = 0;
  for (const d of decisions.list()) {
    if (d.status !== "active") continue;
    const refs: GovernedRef[] = links.findByDecision(d.id)
      .filter((l) => l.relation === "GOVERNS")
      .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
    if (refs.length === 0) continue;
    if (hashGovernedSource(repoPath, refs) !== d.reconciled_source_hash) n++;
  }
  return n;
}

/** `cortex reconcile status` — print the drifted-decision count for the repo
 *  containing `startDir` (default: the cwd). */
export function runReconcileCommand(sub: string | null, startDir: string = process.cwd()): void {
  const subCmd = sub ?? "status";
  if (subCmd !== "status") { process.stderr.write(`unknown: cortex reconcile ${subCmd}\n`); process.exit(2); }
  // Anchor to the CHECKOUT ROOT, not the cwd. Governed refs are stored
  // repo-relative, so hashing them from a subdirectory resolves every one to
  // <missing> and reports the entire store as drifted. Harmless while
  // CORTEX_RECONCILE gated this command; it is always-on now.
  const repoPath = worktreeRoot(startDir);
  const db = openDecisionsDb(resolveDecisionsDbPath(repoPath), legacyDecisionsDbPath(repoPath));
  try {
    const n = countDriftedDecisions(repoPath, new DecisionsRepository(db), new DecisionLinksRepository(db));
    process.stdout.write(`${n}\n`);
  } finally { db.close(); }
}

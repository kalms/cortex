import type { GovernedRef } from "../decisions/reconciliation.js";

export type StaleKind = "decision" | "todo";
export type StaleReason = "basis_moved" | "verdict_stale";

export interface StaleRow {
  kind: StaleKind;
  id: string;
  /** decision.title / todo.summary */
  title: string;
  reason: StaleReason;
  origin_branch: string | null;
  origin_commit: string | null;
  origin_thread: string | null;
  /** C4 cross: the branch this row was authored on is no longer known to git. */
  branch_concluded: boolean;
  /** Governed refs that do not resolve to anything right now. */
  unresolved_refs: string[];
}

export interface StalenessCounts {
  /** basis_hash IS NULL — counted, never itemized. A backlog, not news. */
  no_reference_point: number;
  basis_moved: number;
  verdict_stale: number;
  itemized: number;
  /** Flagged rows the changed-file scope excluded from itemization. */
  outstanding: number;
}

export interface StalenessReport {
  version: 1;
  swept_at: string;
  repo_path: string;
  /** HEAD at sweep time. Informational — the NEXT sweep reads its own baseline
   *  from the graph DB, not from here. */
  head_commit: string | null;
  /** The previous index's commit. null on a first index or an unanswerable
   *  diff; either way nothing is itemized. */
  since_commit: string | null;
  itemized: StaleRow[];
  counts: StalenessCounts;
  concluded_branches: string[];
  orphaned: Array<{ kind: StaleKind; id: string; origin_branch: string }>;
}

/** One authored row flattened to exactly what the sweep needs. Built by the
 *  caller from the repositories — see run-sweep.ts. */
export interface SweepCandidate {
  kind: StaleKind;
  id: string;
  title: string;
  /** Decisions: status === "active". Todos: state is non-terminal. */
  status_active: boolean;
  refs: GovernedRef[];
  basis_hash: string | null;
  /** Decisions only. Todos are never reconciled — pass null. */
  reconciled_source_hash: string | null;
  origin_branch: string | null;
  origin_commit: string | null;
  origin_thread: string | null;
}

export interface SweepInput {
  /** CHECKOUT root. Every hash is taken against this tree. */
  repoPath: string;
  candidates: SweepCandidate[];
  /** Distinct non-null origin_branch across decisions + todos + STORIES.
   *  Stories govern nothing, so they contribute here and nowhere else. */
  originBranches: string[];
  knownBranches: Set<string> | null;
  changedFiles: Set<string> | null;
  sinceCommit: string | null;
  headCommit: string | null;
  now: () => Date;
}

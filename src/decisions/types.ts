import type { NodeRow } from "../graph/store.js";
import type { PRState } from "../prs/types.js";
import type { OriginFields } from "../git/origin.js";

/**
 * Structured provenance for machine-authored decisions (e.g. those proposed by
 * the seed-decisions skill with author "cortex:seed"). Stored as JSON TEXT in
 * decisions.db; parsed back to this shape by every toDecision() mapper.
 * Human-authored decisions carry null.
 */
export interface ProvenanceMeta {
  source: "adr" | "prose" | "commits";
  doc_path?: string;
  commit_shas?: string[];
  confidence: "high" | "medium" | "low";
}

export interface Alternative {
  name: string;
  reason_rejected: string;
}

export type Tier = "personal" | "team" | "public";
export type DecisionStatus = "proposed" | "active" | "superseded" | "deprecated";

export interface Decision {
  id: string;
  seq: number;
  title: string;
  description: string;
  rationale: string;
  alternatives: Alternative[];
  tier: Tier;
  status: DecisionStatus;
  superseded_by: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  // NEW — narrative split
  problem: string | null;
  resolution: string | null;
  provenance: ProvenanceMeta | null;
}

/** A ref row on a decision link — the sidecar model surfaces target refs
 *  (qns/paths/decision-ids/pr-numbers), not full node rows. */
export interface DecisionRefRow {
  target_kind: string;
  target_ref: string;
}

/** Composed read shape for a single decision: the decision, its sidecar link
 *  refs, and the reconciliation columns that `toDecision()` strips. Mirrors
 *  `TodoWithRefs`. `display_state` is NOT included — it needs a RepoContext,
 *  so the tool layer adds it. */
export interface DecisionWithRefs extends Decision {
  reconciliation_verdict: string | null;
  reconciled_at: string | null;
  reconciled_source_hash: string | null;
  reconciled_by: string | null;
  nonconformant_nodes: unknown | null;
  reconciliation_note: string | null;
  governs: DecisionRefRow[];
  references: DecisionRefRow[];
  related_decisions: Decision[];
  depends_on: Decision[];
  introduced_in: { pr_number: number } | null;
  implemented_by: Array<{ pr_number: number }>;
  challenged_by: Array<{ pr_number: number }>;
  discussed_in: Array<{ pr_number: number }>;
}

export interface CreateDecisionInput {
  title: string;
  description?: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];
  references?: string[];
  author?: string;
  problem?: string | null;
  resolution?: string | null;
  provenance?: ProvenanceMeta;
  origin?: OriginFields; // git identity captured by the tool handler
}

export interface UpdateDecisionInput {
  title?: string;
  description?: string;
  rationale?: string;
  alternatives?: Alternative[];
  status?: DecisionStatus;
  superseded_by?: string;
  reason?: string;
  problem?: string | null;
  resolution?: string | null;
  author?: string;
  // NEW — full-replacement semantics: if provided, this set replaces the current GOVERNS edges
  governs?: string[];
  // NEW — full-replacement semantics for REFERENCES edges
  references?: string[];
  // Git identity captured by the tool handler, describing the checkout this
  // update was made from. Rewrites last_touched_* only — origin is immutable.
  // Every real caller (tool handlers, the CLI) now threads this through, so
  // it is stamped UNCONDITIONALLY: `origin?.field ?? null`. Omitting it (as
  // some direct unit-test call sites still do) stamps null, same as a
  // non-git checkout would — an honest "no git identity was captured here",
  // never a stale leftover from a previous mutation.
  origin?: OriginFields;
}

export interface ProposeDecisionInput {
  title: string;
  problem: string;
  resolution: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];
  references?: string[];
  author?: string;
  provenance?: ProvenanceMeta;
  pr_number?: number;
  origin?: OriginFields; // git identity captured by the tool handler
}

export interface SupersedeDecisionInput {
  old_decision_id: string;
  title: string;
  problem: string;
  resolution: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];
  references?: string[];
  author?: string;
  // Git identity captured by the tool handler, used for BOTH rows this call
  // touches: the replacement decision it mints (origin-at-create, exactly as
  // any other create) and the old decision whose status it flips
  // (last_touched_* refresh). An earlier revision threaded it only into the
  // latter, which left every supersede-created decision with NULL provenance —
  // a row authored today that is permanently unknowable and never
  // drift-detectable. The handler also stamps the replacement's basis_hash.
  origin?: OriginFields;
}

export interface PRRef {
  number: number;
  title: string;
  state: PRState;
}

export function nodeToDecision(node: NodeRow): Decision {
  const data = JSON.parse(node.data);
  return {
    id: node.id,
    seq: data.seq ?? 0,
    title: data.title,
    description: data.description,
    rationale: data.rationale,
    alternatives: data.alternatives ?? [],
    tier: node.tier as Tier,
    status: data.status ?? "active",
    superseded_by: data.superseded_by ?? null,
    author: data.author ?? null,
    created_at: node.created_at,
    updated_at: node.updated_at,
    problem: data.problem ?? null,
    resolution: data.resolution ?? null,
    provenance: data.provenance ?? null,
  };
}

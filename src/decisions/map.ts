import type { Decision } from "./types.js";
import type { DecisionRecord } from "./repository.js";

/** Map a raw DecisionRecord row to the public Decision shape. */
export function toDecision(rec: DecisionRecord): Decision {
  return {
    id: rec.id,
    seq: rec.seq,
    title: rec.title,
    description: rec.description ?? "",
    rationale: rec.rationale ?? "",
    alternatives: rec.alternatives ? JSON.parse(rec.alternatives) : [],
    tier: rec.tier as Decision["tier"],
    status: rec.status as Decision["status"],
    superseded_by: rec.superseded_by,
    author: rec.author ?? "claude",
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    problem: rec.problem,
    resolution: rec.resolution,
    provenance: rec.provenance ? JSON.parse(rec.provenance) : null,
    origin_branch: rec.origin_branch ?? null,
    origin_commit: rec.origin_commit ?? null,
    origin_thread: rec.origin_thread ?? null,
    last_touched_branch: rec.last_touched_branch ?? null,
    last_touched_commit: rec.last_touched_commit ?? null,
    last_touched_thread: rec.last_touched_thread ?? null,
    basis_hash: rec.basis_hash ?? null,
    reconciled_branch: rec.reconciled_branch ?? null,
    reconciled_commit: rec.reconciled_commit ?? null,
  };
}

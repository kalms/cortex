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
  };
}

import type { NodeRow } from "../graph/store.js";

export interface Alternative {
  name: string;
  reason_rejected: string;
}

export type Tier = "personal" | "team" | "public";
export type DecisionStatus = "proposed" | "active" | "superseded" | "deprecated";

export interface Decision {
  id: string;
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
}

export interface CreateDecisionInput {
  title: string;
  description: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];
  references?: string[];
  author?: string;
  problem?: string | null;
  resolution?: string | null;
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
  pr_number?: number;
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
}

export function nodeToDecision(node: NodeRow): Decision {
  const data = JSON.parse(node.data);
  return {
    id: node.id,
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
  };
}

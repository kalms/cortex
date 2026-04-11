import type { NodeRow } from "../graph/store.js";

export interface Alternative {
  name: string;
  reason_rejected: string;
}

export type Tier = "personal" | "team" | "public";
export type DecisionStatus = "active" | "superseded" | "deprecated";

export interface Decision {
  id: string;
  title: string;
  description: string;
  rationale: string;
  alternatives: Alternative[];
  tier: Tier;
  status: DecisionStatus;
  superseded_by?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateDecisionInput {
  title: string;
  description: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];
  references?: string[];
}

export interface UpdateDecisionInput {
  title?: string;
  description?: string;
  rationale?: string;
  alternatives?: Alternative[];
  status?: DecisionStatus;
  superseded_by?: string;
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
    superseded_by: data.superseded_by,
    created_by: data.created_by,
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
}

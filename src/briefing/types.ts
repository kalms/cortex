import type { DecisionSearch } from "../decisions/search.js";
import type { DecisionsRepository } from "../decisions/repository.js";
import type { GraphStore } from "../graph/store.js";

export type Verdict = "match" | "partial" | "drift" | "unreconciled";

export interface BriefingFacts {
  target: string;
  decision?: { id: string; title: string; displayState: string; verdict: Verdict };
  callerCount: number;
  fanoutThreshold: number;
  pr?: number;
}

export interface Briefing {
  gated: boolean;
  escalate: boolean;
  headline: string;
}

/** Everything composeBriefing needs, satisfied by both the CLI and the MCP RepoContext. */
export interface BriefingDeps {
  search: DecisionSearch;
  decisions: DecisionsRepository;
  store: GraphStore;
  project: string;
}

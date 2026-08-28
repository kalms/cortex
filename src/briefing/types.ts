import type { DecisionSearch } from "../decisions/search.js";
import type { DecisionsRepository } from "../decisions/repository.js";
import type { DecisionLinksRepository } from "../decisions/links-repository.js";
import type { GraphStore } from "../graph/store.js";

export type Verdict = "match" | "partial" | "drift" | "unreconciled";

export interface BriefingFacts {
  target: string;
  decision?: { id: string; title: string; displayState: string; verdict: Verdict };
  callerCount: number;
  fanoutThreshold: number;
  pr?: number;
  /** The governing decision's stored reference point no longer matches its
   *  governed source. Distinct from the verdict: a `match` decision whose
   *  basis moved is exactly the row that reads clean while being wrong. */
  basisMoved?: boolean;
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
  links: DecisionLinksRepository;
  store: GraphStore;
  project: string;
  /** CHECKOUT root — the basis comparison hashes this tree. */
  repoPath: string;
}

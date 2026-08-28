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
  /** Some active governing decision's governed source has moved since it was
   *  last judged — its basis moved, or its verdict was recorded against a
   *  different tree — AND no verdict has been recorded against the tree as it
   *  stands. Distinct from the displayed verdict: a `match` decision whose
   *  basis moved is exactly the row that reads clean while being wrong. */
  needsRejudge?: boolean;
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

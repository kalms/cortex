export type CandidateKind = "adr" | "prose" | "commit_cluster";
export type Confidence = "high" | "medium" | "low";

export interface CandidateProvenance {
  doc_path?: string;
  commit_shas?: string[];
  files_touched: string[];
}

export interface DecisionCandidate {
  kind: CandidateKind;
  confidence: Confidence;
  title_hint: string;
  provenance: CandidateProvenance;
  raw_excerpt: string;
}

/** Default cap on candidates returned by frameCandidates(). */
export const DEFAULT_MAX_CANDIDATES = 20;

/** Default git-log depth for clusterCommitCandidates(). */
export const DEFAULT_MAX_COMMITS = 500;

export interface FrameCandidatesOptions {
  repo_path: string;
  max_candidates?: number; // default DEFAULT_MAX_CANDIDATES
  max_commits?: number;    // default DEFAULT_MAX_COMMITS
  /** Git ref: scope to base..HEAD commits and base...HEAD-touched docs
   *  (warm path). Omitted = whole-history cold start. Invalid ref throws. */
  base?: string;
}

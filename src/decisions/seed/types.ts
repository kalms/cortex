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

export interface FrameCandidatesOptions {
  repo_path: string;
  max_candidates?: number; // default 20
  max_commits?: number;    // default 500
}

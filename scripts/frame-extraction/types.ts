// scripts/frame-extraction/types.ts

export interface RepoSpec {
  slug: string;
  git: string | null;          // null = use local_path (no clone)
  local_path?: string;         // resolved relative to repo root
  archetype: string;
  size_hint: "small" | "medium" | "large";
  primary_language: string;
}

export interface CorpusFile {
  $schema_version: number;
  comment?: string;
  repos: RepoSpec[];
}

/** Successful or failed result of one MCP call. */
export type IndexerEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; status: string; error_phase: string; error: string; raw: string };

export interface NodeLabelCount {
  label: string;
  count: number;
}

export interface GraphStats {
  total_nodes: number;
  total_edges: number;
  edge_density: number;
  node_labels: NodeLabelCount[];
  /** Sum of function + class + method + interface + type — the entity_count
   *  used by frame-extraction.md §Verification "complexity score". */
  entity_count: number;
}

export interface FsStats {
  file_count: number;
  max_depth: number;
  mean_depth: number;
  /** Map from extension (with leading dot, lowercased) → count. */
  extension_histogram: Record<string, number>;
  /** Auxiliary-path hits per the path-pattern list from
   *  frame-extraction.md §Two content streams Group A. */
  auxiliary_directories: string[];
}

export type RepoStatus =
  | { ok: true; stats: GraphStats & FsStats }
  | { ok: false; phase: "clone" | "index" | "graph_stats" | "fs_stats"; message: string };

export interface SurveyResult {
  slug: string;
  archetype: string;
  size_hint: string;
  primary_language: string;
  commit_sha: string | null;
  result: RepoStatus;
  /** Wall-clock seconds for the (clone + index + stats) pipeline. */
  elapsed_seconds: number;
}

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

/** Options controlling framework-aware path tokenization.
 *  Defaults are baked into `tokenizePath`; callers override only when
 *  exercising the service-suffix edge case (see frame-extraction.md
 *  §Path tokenization). */
export interface PathTokenizeOptions {
  /** Strip role suffixes only when the prefix is itself a domain token
   *  (i.e. not a member of `STRIP_SEGMENTS`). Defaults to true. */
  service_suffix_aware: boolean;
}

/** Output of tokenizing a file path. `path_tokens` come from the stripped
 *  path + filename stem; `symbol_tokens` come from the bare filename stem
 *  only (after extension + role-suffix removal). Returned as ordered sets
 *  (string[]) so callers can compute Jaccard, cosine, etc. without
 *  re-sorting. */
export interface PathTokens {
  path_tokens: string[];
  symbol_tokens: string[];
}

/** A single co-change observation: files `a` and `b` appeared together in
 *  `count` commits over the analysis window. Stored sorted by `a < b` to
 *  avoid double-counting symmetric pairs. */
export interface FilePair {
  a: string;
  b: string;
  count: number;
}

export interface CoChangeOptions {
  /** Repo to analyse. */
  repo_path: string;
  /** Co-change window. The spec uses 180 days from HEAD's committer date. */
  since_days: number;
  /** Drop commits with this many or more files (format passes, bulk renames,
   *  initial imports). Spec starter: 50. */
  big_commit_threshold: number;
  /** Drop pairs with `count` below this. Defaults to 2 so single co-occurrences
   *  don't dominate downstream noise. */
  min_count: number;
}

/** Per-file text blob handed to a clustering algorithm. `path` is the
 *  file's path relative to the repo root. `text` is a single string
 *  with path tokens + symbol identifiers, space-separated. Used directly
 *  as input to TF-IDF / embedding pipelines. */
export interface FileBlob {
  path: string;
  text: string;
}

/** One cluster assignment from the algorithm output. */
export interface ClusterAssignment {
  /** Cluster id. -1 means HDBSCAN noise (file not confidently assigned). */
  cluster_id: number;
  /** File paths in this cluster, relative to the repo root. Sorted. */
  member_paths: string[];
}

/** Output of one clustering run. Algorithm name + parameters are stamped
 *  for reproducibility — re-running with the same input + parameters must
 *  produce byte-identical output (determinism is required per the spec). */
export interface ClusterResult {
  algorithm: "tfidf+hdbscan" | "embedding+hdbscan" | "leiden";
  parameters: Record<string, string | number>;
  /** All clusters, sorted by member_count desc then by cluster_id asc.
   *  The noise cluster (cluster_id = -1) is included if non-empty. */
  clusters: ClusterAssignment[];
  /** Total file count = sum of all clusters' member counts. */
  total_files: number;
  /** Number of files in the noise cluster (HDBSCAN-specific; 0 for
   *  algorithms that don't produce noise). */
  noise_count: number;
}

export type Target = {
  name: string;
  repo_url?: string;
  sha?: string;
  default_branch?: string;
  local_path?: string;
};

export type Targets = { targets: Target[] };

export type FixId = 2 | 3 | 4 | 5 | 6 | 8;

// Query shapes the harness can run.
export type AssertionQuery =
  | { kind: "sql"; sql: string }
  | { kind: "count_label"; label: string }                // nodes WHERE kind = ?
  | { kind: "count_edge"; type: string }                  // edges WHERE relation = ?
  | { kind: "tool_call"; tool: string; args: Record<string, unknown> };

export type Predicate =
  | { op: "gt"; value: number }
  | { op: "gte"; value: number }
  | { op: "eq"; value: number }
  | { op: "matches"; regex: string }
  | { op: "no_match"; regex: string }
  | { op: "tool_text_nonempty" }                          // tool result content is non-empty
  | { op: "tool_text_contains"; needle: string };

export type Assertion = {
  fix_id: FixId;
  name: string;
  description: string;
  query: AssertionQuery;
  predicate: Predicate;
  baseline_expected: "pass" | "fail";
};

export type AssertionResult = {
  assertion: Assertion;
  observed: number | string[] | { text: string; isError?: boolean };
  passed: boolean;
  surprised: boolean;
};

export type KillerQueryResult = {
  name: string;
  cypher: string;        // illustrative; the actual SQL lives in queries.ts
  row_count: number;
  sample_rows: unknown[];
};

export type Scorecard = {
  target: string;
  indexer_seconds: number | null;       // null if reusing existing index
  nodes_by_label: Record<string, number>;
  edges_by_type: Record<string, number>;
  killer_queries: KillerQueryResult[];
};

export type Baseline = {
  target: string;
  captured_at: string;                  // ISO 8601
  source_sha?: string;                  // for cloned targets; null for local_path
  nodes_by_label: Record<string, number>;
  edges_by_type: Record<string, number>;
  per_assertion: Record<string, number | string[]>; // assertion name -> observed value
};

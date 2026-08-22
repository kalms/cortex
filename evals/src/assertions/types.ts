export type Target = {
  name: string;
  repo_url?: string;
  sha?: string;
  default_branch?: string;
  local_path?: string;
  /** Assertion packs to run. Defaults to ["universal"] — a new target gets
   *  the portable checks and none of the ecosystem-specific ones. */
  packs?: AssertionScope[];
  /** Suite membership for --suite selection. Defaults to ["nuxt"]. */
  suites?: string[];
};

export type Targets = { targets: Target[] };

export type FixId = 2 | 3 | 4 | 5 | 6 | 8 | "universal";

export type AssertionScope = "universal" | "nuxt";

export type RatchetDirection = "lower_is_better" | "higher_is_better" | "exact";

/** The verdict of comparing one observed value against its baseline.
 *  Defined here rather than in ratchet.ts so `types.ts` stays the leaf of the
 *  import graph — ratchet.ts already imports `RatchetDirection` from here.
 *  `not_measured` is distinct from a zero: a rate over zero rows has
 *  nothing to measure, and reporting it as a number would make a total
 *  extraction failure read as a healthy score. */
export type RatchetOutcome =
  | { status: "not_measured"; observed: null }
  | { status: "no_baseline"; observed: number }
  | { status: "pass"; observed: number; baseline: number; delta: number; improved: boolean }
  | { status: "fail"; observed: number; baseline: number; delta: number; improved: false };

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
  /** Required for scope "nuxt". Universal metrics carry NO predicate: their
   *  verdict is the ratchet against this repo's own baseline, applied in
   *  Task 5. Never add a permissive predicate to satisfy the type. */
  predicate?: Predicate;
  baseline_expected: "pass" | "fail";
  /** Which target packs this assertion applies to. */
  scope: AssertionScope;
  /** Ratchet direction. Required for scope "universal"; unused for "nuxt",
   *  which keeps the static baseline_expected semantics. */
  direction?: RatchetDirection;
};

export type AssertionResult = {
  assertion: Assertion;
  /** null = the query had nothing to measure (a rate over zero rows). Distinct
   *  from 0, which is a real measurement. */
  observed: number | string[] | Record<string, number> | { text: string; isError?: boolean } | null;
  /** null = not judged. A universal metric with no baseline has nothing to
   *  compare against; reporting `false` would invent a failure and `true`
   *  would invent a pass. */
  passed: boolean | null;
  surprised: boolean;
  /** Set for scope "universal" only, by applyRatchet (Task 5). A single
   *  outcome for scalar metrics; one per key for map-valued metrics. */
  ratchet?: RatchetOutcome | Record<string, RatchetOutcome>;
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
  /** assertion name -> observed value. Map values hold per-language metrics. */
  per_assertion: Record<string, number | string[] | string | Record<string, number>>;
};

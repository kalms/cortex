import type { Assertion } from "./types.js";

export const FIX_3_ASSERTIONS: Assertion[] = [
  // imports_edge_count_grew is baseline-relative and lives in the report
  // layer (Task 7) rather than as a static predicate. It's intentionally
  // omitted from this file.
  {
    fix_id: 3,
    name: "composable_has_callers",
    description: "At least one function whose name starts with 'use' has CALLS in-degree > 0",
    query: {
      kind: "sql",
      sql: `
        SELECT g.name FROM edges e
        JOIN nodes g ON g.id = e.target_id
        WHERE e.relation = 'CALLS' AND g.kind = 'function' AND g.name LIKE 'use%'
        GROUP BY g.name
      `,
    },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 3,
    name: "pinia_store_node_exists",
    description: "defineStore appears as a function with at least one CALLS edge to it",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM edges e
        JOIN nodes g ON g.id = e.target_id
        WHERE e.relation = 'CALLS' AND g.kind = 'function' AND g.name = 'defineStore'
      `,
    },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
];

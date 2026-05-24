import type { Assertion } from "./types.js";

export const FIX_2_ASSERTIONS: Assertion[] = [
  {
    fix_id: 2,
    name: "http_calls_edge_count_nonzero",
    description: "At least one HTTP_CALLS edge exists",
    query: { kind: "count_edge", type: "HTTP_CALLS" },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 2,
    name: "http_calls_to_api_route",
    description: "More than 5 HTTP_CALLS edges target a Route node whose name starts with /api",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM edges e
        JOIN nodes rt ON rt.id = e.target_id
        WHERE e.relation = 'HTTP_CALLS' AND rt.kind = 'Route' AND rt.name LIKE '/api%'
      `,
    },
    predicate: { op: "gt", value: 5 },
    baseline_expected: "fail",
  },
  {
    fix_id: 2,
    name: "route_node_named_api_path",
    description: "More than 3 Route nodes have names starting with /api",
    query: {
      kind: "sql",
      sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'Route' AND name LIKE '/api%'",
    },
    predicate: { op: "gt", value: 3 },
    baseline_expected: "fail",
  },
];

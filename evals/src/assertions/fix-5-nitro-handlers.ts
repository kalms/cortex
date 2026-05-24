import type { Assertion } from "./types.js";

export const FIX_5_ASSERTIONS: Assertion[] = [
  {
    fix_id: 5,
    name: "nitro_handler_function_exists",
    description: "More than 5 function nodes whose file_path is under server/api/**/*.ts",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM nodes
        WHERE kind = 'function' AND file_path LIKE '%server/api/%' AND file_path LIKE '%.ts'
      `,
    },
    predicate: { op: "gt", value: 5 },
    baseline_expected: "fail",
  },
  {
    fix_id: 5,
    name: "nitro_route_handles_edge",
    description: "At least one HANDLES edge from a function to a Route",
    query: { kind: "count_edge", type: "HANDLES" },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
];

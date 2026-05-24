import type { Assertion } from "./types.js";

export const FIX_6_ASSERTIONS: Assertion[] = [
  {
    fix_id: 6,
    name: "no_tarball_routes",
    description: "No Route nodes whose name contains 'tarball' or ends in .tgz (regression guard)",
    query: {
      kind: "sql",
      sql: "SELECT name FROM nodes WHERE kind = 'Route'",
    },
    predicate: { op: "no_match", regex: "tarball|\\.tgz" },
    baseline_expected: "pass",
  },
  {
    fix_id: 6,
    name: "no_codeartifact_routes",
    description: "No Route nodes whose name contains 'codeartifact' (regression guard)",
    query: {
      kind: "sql",
      sql: "SELECT name FROM nodes WHERE kind = 'Route'",
    },
    predicate: { op: "no_match", regex: "codeartifact" },
    baseline_expected: "pass",
  },
];

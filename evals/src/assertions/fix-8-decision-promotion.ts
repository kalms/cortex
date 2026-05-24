import type { Assertion } from "./types.js";

export const FIX_8_ASSERTIONS: Assertion[] = [
  {
    fix_id: 8,
    name: "decision_node_count_nonzero",
    description: "At least one Decision node exists",
    query: { kind: "count_label", label: "Decision" },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 8,
    name: "decision_governs_edges_exist",
    description: "At least one GOVERNS edge from a Decision exists",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM edges e
        JOIN nodes d ON d.id = e.source_id
        WHERE e.relation = 'GOVERNS' AND d.kind = 'Decision'
      `,
    },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 8,
    name: "decision_rationale_no_xml_leakage",
    description: "No Decision has rationale containing structured-marshalling markers (regression guard)",
    query: {
      kind: "sql",
      sql: `
        SELECT json_extract(data, '$.rationale') AS rationale
        FROM nodes
        WHERE kind = 'Decision' AND json_extract(data, '$.rationale') IS NOT NULL
      `,
    },
    predicate: { op: "no_match", regex: "</rationale>|<problem>|</invoke>" },
    baseline_expected: "pass",
  },
];

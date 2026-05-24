import type { Assertion } from "./types.js";

// Three graph-content + four tool-behavior assertions. Tool-behavior assertions
// have query kind 'tool_call' and require runToolAssertion (Task 6).
export const FIX_4_ASSERTIONS: Assertion[] = [
  {
    fix_id: 4,
    name: "vue_function_node_count_nonzero",
    description: "More than 10 function nodes with file_path ending in .vue",
    query: {
      kind: "sql",
      sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'function' AND file_path LIKE '%.vue'",
    },
    predicate: { op: "gt", value: 10 },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "vue_function_has_high_degree",
    description: "At least one .vue function with degree > 5",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n FROM nodes f
        WHERE f.kind = 'function' AND f.file_path LIKE '%.vue'
          AND (SELECT COUNT(*) FROM edges WHERE source_id = f.id OR target_id = f.id) > 5
      `,
    },
    predicate: { op: "gte", value: 1 },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "sfc_qn_well_formed",
    description: "No .vue function has qualified_name containing literal '<script setup>' or null",
    query: {
      kind: "sql",
      sql: `
        SELECT COALESCE(qualified_name, '') AS qn FROM nodes
        WHERE kind = 'function' AND file_path LIKE '%.vue'
        LIMIT 5
      `,
    },
    predicate: { op: "no_match", regex: "<script setup>|^$" },
    baseline_expected: "fail",
  },
  // Tool-behavior assertions — must be run by runToolAssertion.
  {
    fix_id: 4,
    name: "vue_file_is_module_node",
    description: "Even without parsing, .vue files appear as module nodes (governs/get_code_snippet MVP)",
    query: {
      kind: "sql",
      sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'module' AND file_path LIKE '%.vue'",
    },
    predicate: { op: "gt", value: 0 },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "get_code_snippet_returns_vue_content",
    description: "get_code_snippet with a .vue path returns non-empty content",
    query: {
      kind: "tool_call",
      tool: "get_code_snippet",
      args: { /* qualified_name filled in from fixture at run time */ },
    },
    predicate: { op: "tool_text_nonempty" },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "governs_link_to_vue_path_persists",
    description: "create_decision(governs=[<.vue path>]) -> get_decision shows non-empty governs",
    query: {
      kind: "tool_call",
      tool: "__governs_link_vue_path__",   // pseudo-tool — handled specially in tool-runner
      args: {},
    },
    predicate: { op: "tool_text_nonempty" },
    baseline_expected: "fail",
  },
  {
    fix_id: 4,
    name: "search_graph_finds_vue_component",
    description: "search_graph(name_pattern=<vue component basename>) returns at least one result",
    query: {
      kind: "tool_call",
      tool: "search_graph",
      args: { /* name_pattern filled in from fixture */ },
    },
    predicate: { op: "tool_text_nonempty" },
    baseline_expected: "fail",
  },
];

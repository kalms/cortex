import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { runToolAssertion } from "../../evals/src/assertions/tool-runner.js";
import type { Assertion } from "../../evals/src/assertions/types.js";

describe("tool-runner — in-process MCP tool assertions", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-toolrun-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("vue_file_is_module_node: passes when a .vue module node exists", () => {
    store.createNode({ kind: "module", name: "Card.vue", file_path: "app/Card.vue" });
    const a: Assertion = {
      fix_id: 4,
      name: "vue_file_is_module_node",
      description: "stub",
      query: {
        kind: "sql",
        sql: "SELECT COUNT(*) AS n FROM nodes WHERE kind = 'module' AND file_path LIKE '%.vue'",
      },
      predicate: { op: "gt", value: 0 },
      baseline_expected: "fail",
    };
    // vue_file_is_module_node is SQL-only — runToolAssertion delegates to runAssertion.
    const result = runToolAssertion(a, {
      dbPath,
      fixture: { vue_file_path: "app/Card.vue", vue_component_name: "Card" },
      project: "test-project",
    });
    expect(result.passed).toBe(true);
  });

  it("get_code_snippet_returns_vue_content: fails when no module node for the vue path", () => {
    const a: Assertion = {
      fix_id: 4,
      name: "get_code_snippet_returns_vue_content",
      description: "stub",
      query: {
        kind: "tool_call",
        tool: "get_code_snippet",
        args: {},
      },
      predicate: { op: "tool_text_nonempty" },
      baseline_expected: "fail",
    };
    const result = runToolAssertion(a, {
      dbPath,
      fixture: { vue_file_path: "app/Card.vue", vue_component_name: "Card" },
      project: "test-project",
    });
    expect(result.passed).toBe(false);
  });

  it("search_graph_finds_vue_component: passes when a node matches the basename", () => {
    store.createNode({ kind: "function", name: "Card", qualified_name: "app/Card.vue::Card" });
    const a: Assertion = {
      fix_id: 4,
      name: "search_graph_finds_vue_component",
      description: "stub",
      query: {
        kind: "tool_call",
        tool: "search_graph",
        args: {},
      },
      predicate: { op: "tool_text_nonempty" },
      baseline_expected: "fail",
    };
    const result = runToolAssertion(a, {
      dbPath,
      fixture: { vue_file_path: "app/Card.vue", vue_component_name: "Card" },
      project: "test-project",
    });
    expect(result.passed).toBe(true);
  });

  it("governs_link_to_vue_path_persists: round-trips through decision DB", () => {
    // This test exercises the cortex decision service end-to-end using a temp decision DB.
    // It passes when create_decision with a .vue governs target results in a non-empty
    // governs array on read-back.
    const a: Assertion = {
      fix_id: 4,
      name: "governs_link_to_vue_path_persists",
      description: "stub",
      query: { kind: "tool_call", tool: "__governs_link_vue_path__", args: {} },
      predicate: { op: "tool_text_nonempty" },
      baseline_expected: "fail",
    };
    const result = runToolAssertion(a, {
      dbPath,
      fixture: { vue_file_path: "app/Card.vue", vue_component_name: "Card" },
      project: "test-project",
      decisionsDbPath: join(dir, "decisions.db"),
    });
    expect(result.passed).toBe(true);
    // The cortex decision service stores governs as a link, not as filesystem-validated.
    // So this passes even without a real module node — the assertion is purely about
    // whether the round-trip preserves the array.
  });
});

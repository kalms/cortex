import { GraphStore } from "../../../src/graph/store.js";
import { openDecisionsDb } from "../../../src/decisions/db.js";
import { DecisionsRepository } from "../../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../../src/decisions/links-repository.js";
import { DecisionService } from "../../../src/decisions/service.js";
import { runAssertion } from "./runner.js";
import type { Assertion, AssertionResult } from "./types.js";

export type Fixture = {
  vue_file_path: string;
  vue_component_name: string;
};

export type ToolRunnerContext = {
  dbPath: string;
  fixture: Fixture;
  project: string;
  decisionsDbPath?: string;
};

export function runToolAssertion(a: Assertion, ctx: ToolRunnerContext): AssertionResult {
  // Non-tool_call queries delegate to the regular runner.
  if (a.query.kind !== "tool_call") {
    return runAssertion(a, { dbPath: ctx.dbPath });
  }

  switch (a.query.tool) {
    case "get_code_snippet":
      return runGetCodeSnippet(a, ctx);
    case "search_graph":
      return runSearchGraph(a, ctx);
    case "__governs_link_vue_path__":
      return runGovernsLinkVuePath(a, ctx);
    default:
      throw new Error(`tool-runner: unknown tool ${a.query.tool}`);
  }
}

function runGetCodeSnippet(a: Assertion, ctx: ToolRunnerContext): AssertionResult {
  // Cortex's get_code_snippet resolves a qualified name (or file path) to a node
  // and returns its content. Direct SQL replicates the lookup path the MCP tool uses.
  const store = new GraphStore(ctx.dbPath);
  const rows = store.queryRaw<{ name: string; data: string }>(
    "SELECT name, data FROM nodes WHERE file_path = ? OR qualified_name = ? LIMIT 1",
    [ctx.fixture.vue_file_path, ctx.fixture.vue_file_path],
  );
  const text = rows[0]?.name ? `Node found: ${rows[0].name}` : "";
  return result(a, text, { kind: "tool_text_nonempty" });
}

function runSearchGraph(a: Assertion, ctx: ToolRunnerContext): AssertionResult {
  const store = new GraphStore(ctx.dbPath);
  const rows = store.queryRaw<{ name: string }>(
    "SELECT name FROM nodes WHERE name LIKE ?",
    [`%${ctx.fixture.vue_component_name}%`],
  );
  const text = rows.length > 0 ? `Found ${rows.length} matches` : "";
  return result(a, text, { kind: "tool_text_nonempty" });
}

function runGovernsLinkVuePath(a: Assertion, ctx: ToolRunnerContext): AssertionResult {
  if (!ctx.decisionsDbPath) {
    throw new Error("governs_link_to_vue_path_persists requires decisionsDbPath");
  }
  const db = openDecisionsDb(ctx.decisionsDbPath);
  try {
    const links = new DecisionLinksRepository(db);
    const svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links,
    });
    const d = svc.create({
      title: "harness-temp",
      description: "harness",
      rationale: "harness",
      governs: [ctx.fixture.vue_file_path],
    });
    const found = links.findByDecision(d.id).filter((l) => l.relation === "GOVERNS");
    svc.delete(d.id);
    const text = found.length > 0 ? `governs persisted: ${found.length}` : "";
    return result(a, text, { kind: "tool_text_nonempty" });
  } finally {
    db.close();
  }
}

function result(
  a: Assertion,
  text: string,
  _predicateHint: { kind: "tool_text_nonempty" },
): AssertionResult {
  const passed = (() => {
    if (a.predicate.op === "tool_text_nonempty") return text.length > 0;
    if (a.predicate.op === "tool_text_contains") return text.includes((a.predicate as { needle: string }).needle);
    return false;
  })();
  const surprised =
    (a.baseline_expected === "pass" && !passed) ||
    (a.baseline_expected === "fail" && passed);
  return { assertion: a, observed: { text }, passed, surprised };
}

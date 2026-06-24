import { describe, it, expect } from "vitest";
import { createServer } from "../../src/mcp-server/server.js";

describe("consolidated tool surface", () => {
  it("exposes decision/todo/pr and none of the old primitive names", () => {
    const server = createServer(null);
    const names = Object.keys((server as any)._registeredTools ?? {});
    expect(names).toEqual(expect.arrayContaining(["decision", "todo", "pr"]));
    for (const gone of [
      "create_decision",
      "update_decision",
      "delete_decision",
      "get_decision",
      "search_decisions",
      "why_was_this_built",
      "decision_candidates",
      "link_decision",
      "promote_decision",
      "propose_decision",
      "supersede_decision",
      "record_reconciliation",
      "pending_reconciliations",
      "open_pr",
      "add_pr_touch",
      "merge_pr",
      "get_pr",
    ]) {
      expect(names).not.toContain(gone);
    }
  });
});

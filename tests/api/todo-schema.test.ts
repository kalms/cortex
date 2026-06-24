import { describe, it, expect } from "vitest";
import { AdaptedTodoSchema, RESPONSE_SCHEMAS } from "../../src/mcp-server/api-schemas.js";

describe("AdaptedTodoSchema", () => {
  it("accepts a well-formed adapted todo", () => {
    const ok = AdaptedTodoSchema.safeParse({
      id: "T-9m2x", seq: 3, summary: "x", state: "open", description: "",
      proposedBy: "rka", proposedAt: "t", startedAt: null, closedAt: null, assignee: null,
      governs: [], blockedBy: [], blocks: [], relatedTo: [], spawnsFrom: null, resolvedBy: [],
    });
    expect(ok.success).toBe(true);
  });
  it("is registered for doc generation", () => {
    expect(Object.keys(RESPONSE_SCHEMAS)).toContain("todos");
  });
});

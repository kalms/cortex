import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

describe("promotion-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("promote_decision: happy path promotes an existing decision", async () => {
    const create = await callTool(h, "create_decision", {
      title: "Promotion test",
      description: "for promotion contract",
      rationale: "testing",
    });
    const id = JSON.parse(create.content[0].text).id;

    const res = await callTool(h, "promote_decision", { id, tier: "team" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();

    await callTool(h, "delete_decision", { id });
  });

  it("promote_decision: unknown id returns empty or structured error", async () => {
    // Use a syntactically valid UUID that doesn't exist
    const res = await callTool(h, "promote_decision", {
      id: "00000000-0000-0000-0000-000000000000",
      tier: "team",
    });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
  });
});

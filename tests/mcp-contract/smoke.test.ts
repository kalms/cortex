import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("mcp-contract smoke", () => {
  let h: HarnessContext;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("list_projects returns the fixture project", async () => {
    const res = await callTool(h, "list_projects", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(h.project);
  });

  it("get_graph_schema returns labels", async () => {
    const res = await callTool(h, "get_graph_schema", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Function/);
  });
});

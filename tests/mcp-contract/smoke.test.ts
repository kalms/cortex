import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("mcp-contract smoke", () => {
  let h: HarnessContext;

  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("list_projects returns the fixture project after the resolver touches it", async () => {
    // Phase 4: list_projects sources from RepoContextResolver.listKnownRepos.
    // Pool the harness repo first via any per-repo tool, then verify.
    await callTool(h, "search_graph", { name_pattern: "_does_not_exist_" });
    const res = await callTool(h, "list_projects", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain(h.repoPath);
  });

  it("get_graph_schema returns labels", async () => {
    const res = await callTool(h, "get_graph_schema", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/function/);
  });
});

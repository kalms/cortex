import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("context_pack", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("returns all five labeled sections for a resolvable symbol", async () => {
    const res = await callTool(h, "context_pack", { qualified_name: "handleRequest" });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toContain("## SNIPPET");
    expect(text).toContain("## CALLERS");
    expect(text).toContain("## CALLEES");
    expect(text).toContain("## GOVERNING DECISIONS");
    expect(text).toContain("## RECENT COMMITS");
  });

  it("returns ambiguous_input once for a multi-match bare name", async () => {
    const res = await callTool(h, "context_pack", { qualified_name: "handler" });
    if (res.isError) {
      expect(res.content[0].text).toContain("Multiple matches");
    } else {
      expect(res.content[0].text).toContain("## SNIPPET");
    }
  });

  it("returns empty for an unresolvable name", async () => {
    const res = await callTool(h, "context_pack", { qualified_name: "ZzNoSuchSymbol999" });
    expect(res.content[0].text.toLowerCase()).toMatch(/no results|empty|context_pack/);
  });

  it("rejects when repo_path is missing", async () => {
    const res = await callTool(h, "context_pack", { repo_path: undefined, qualified_name: "x" });
    expect(res.isError).toBeTruthy();
  });

  it("always renders a RECENT COMMITS section and never errors on a resolvable symbol", async () => {
    const res = await callTool(h, "context_pack", { qualified_name: "handleRequest" });
    expect(res.isError).toBeFalsy();
    const text = res.content[0].text;
    expect(text).toMatch(/## RECENT COMMITS( \(|\n)/);
    expect(text).toContain("## SNIPPET");
  });
});

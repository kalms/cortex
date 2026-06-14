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

  it("returns ambiguous_input with a candidate list for a multi-match bare name", async () => {
    // `route` resolves to multiple symbols in the fixture: the bare-name LIKE
    // ('%route%') matches the `router` module/file/class nodes plus the
    // `Router.route` method — so resolveInput returns `multi` and we exercise
    // the candidate-list ("Multiple matches") formatting path unconditionally.
    const res = await callTool(h, "context_pack", { qualified_name: "route" });
    expect(res.isError).toBeTruthy();
    const text = res.content[0].text;
    expect(text).toContain("Multiple matches");
    // The candidate list is numbered "1.", "2.", … — assert ≥2 candidates.
    const candidateLines = text.split("\n").filter((l) => /^\s+\d+\.\s/.test(l));
    expect(candidateLines.length).toBeGreaterThanOrEqual(2);
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

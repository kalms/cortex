import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("propose_decision forwards provenance + author", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("accepts provenance + cortex:seed author through the MCP tool boundary", async () => {
    const res = await callTool(h, "decision", {
      action: "propose",
      title: "X",
      problem: "p",
      resolution: "r",
      rationale: "why",
      author: "cortex:seed",
      provenance: { source: "adr", doc_path: "docs/adr/1.md", confidence: "high" },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.author).toBe("cortex:seed");
    expect(parsed.provenance?.source).toBe("adr");
    expect(parsed.provenance?.doc_path).toBe("docs/adr/1.md");
    expect(parsed.provenance?.confidence).toBe("high");
    expect(parsed.status).toBe("proposed");
  });
});

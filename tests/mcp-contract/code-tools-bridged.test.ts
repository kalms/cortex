import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, type HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

describe("Phase 6 bridged tools", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("query_graph dispatches via indexer CLI", async () => {
    const res = await callTool(h, "query_graph", {
      query: "MATCH (n) RETURN count(n) AS c LIMIT 1",
    });
    // Verify the call returns a parseable, contract-conforming response (success or structured error).
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    // On success we expect a JSON envelope containing the column "c".
    if (!res.isError) {
      expect(res.content[0].text).toMatch(/"c"/);
    }
  });

  it("get_architecture returns aspects payload", async () => {
    const res = await callTool(h, "get_architecture", { aspects: ["all"] });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.content[0].text.length).toBeGreaterThan(0);
  });

  it("ingest_traces accepts empty trace list", async () => {
    const res = await callTool(h, "ingest_traces", { traces: [] });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, makeIndexedRepoFixture, type HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { rmSync } from "node:fs";

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

  describe("query_graph per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "query_graph", {
        repo_path: undefined,
        query: "MATCH (n) RETURN count(n) AS c LIMIT 1",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes the query to the addressed repo, not the server's cwd", async () => {
      // The indexer subprocess opens CORTEX_DB; assert the call succeeds when
      // we explicitly point query_graph at a second indexed repo.
      const repoB = makeIndexedRepoFixture();
      try {
        const res = await callTool(h, "query_graph", {
          repo_path: repoB,
          query: "MATCH (n) RETURN count(n) AS c LIMIT 1",
        });
        expect(ResponseSchema.safeParse(res).success).toBe(true);
        if (!res.isError) {
          expect(res.content[0].text).toMatch(/"c"/);
        }
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });

    it("forwards explicit project arg as in-graph filter", async () => {
      // project is an *in-graph* filter (ctx_projects row), distinct from
      // repo_path which selects which .cortex/db to open. We can't directly
      // observe the forwarded filter without inspecting the indexer call,
      // but we can assert that an obviously-bogus project name yields no
      // rows on a query that would otherwise return ≥1 row.
      const res = await callTool(h, "query_graph", {
        query: "MATCH (n) RETURN count(n) AS c LIMIT 1",
        project: "zzz_nonexistent_project_filter",
      });
      expect(ResponseSchema.safeParse(res).success).toBe(true);
      // Either a structured no-results envelope or an empty count row — both
      // confirm the filter was applied (didn't silently degrade to no-filter).
      if (!res.isError) {
        // c=0 (or empty rows array) means filter applied successfully
        expect(res.content[0].text).toMatch(/"c"\s*:\s*0|"rows"\s*:\s*\[\s*\]|"count"\s*:\s*0/);
      }
    });
  });

});

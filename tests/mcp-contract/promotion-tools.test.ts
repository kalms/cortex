import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, callTool, makeIndexedRepoFixture, type HarnessContext } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { rmSync } from "node:fs";

describe("promotion-tools contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("promote_decision: happy path promotes an existing decision", async () => {
    const create = await callTool(h, "decision", {
      action: "create",
      title: "Promotion test",
      description: "for promotion contract",
      rationale: "testing",
    });
    const id = JSON.parse(create.content[0].text).id;

    const res = await callTool(h, "decision", { action: "promote", id, tier: "team" });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
    expect(res.isError).toBeFalsy();

    await callTool(h, "decision", { action: "delete", id });
  });

  it("promote_decision: unknown id returns empty or structured error", async () => {
    // Use a syntactically valid UUID that doesn't exist
    const res = await callTool(h, "decision", {
      action: "promote",
      id: "00000000-0000-0000-0000-000000000000",
      tier: "team",
    });
    expect(ResponseSchema.safeParse(res).success).toBe(true);
  });

  describe("promote_decision per-call routing", () => {
    it("rejects when repo_path is missing", async () => {
      const res = await callTool(h, "decision", {
        repo_path: undefined,
        action: "promote",
        id: "00000000-0000-0000-0000-000000000000",
        tier: "team",
      });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toMatch(/repo_path required/);
    });

    it("routes the tier write to the addressed repo, not the harness primary", async () => {
      const repoB = makeIndexedRepoFixture();
      try {
        // Seed a decision in repoB.
        const seed = await callTool(h, "decision", {
          action: "create",
          repo_path: repoB,
          title: "to be promoted",
          description: "d",
          rationale: "r",
        });
        const id = JSON.parse(seed.content[0].text).id;

        const res = await callTool(h, "decision", {
          action: "promote",
          repo_path: repoB,
          id,
          tier: "team",
        });
        expect(res.isError).toBeFalsy();
        const parsed = JSON.parse(res.content[0].text);
        expect(parsed.tier).toBe("team");

        // The harness primary service does not know this id.
        expect(h.service.get(id)).toBeNull();
      } finally {
        try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
      }
    });
  });
});

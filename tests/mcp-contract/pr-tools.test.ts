import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, type HarnessContext, callTool } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

describe("PR tools contract — lifecycle", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("open_pr → add_pr_touch × 3 → propose_decision(pr_number) → merge_pr ratifies", async () => {
    // open
    const openRes = await callTool(h, "open_pr", { title: "temporal subsystem", author: "mira", introduces_frame: "src/temporal" });
    expect(ResponseSchema.safeParse(openRes).success).toBe(true);
    expect(openRes.isError).toBeFalsy();
    const pr = JSON.parse(openRes.content[0].text);
    expect(typeof pr.number).toBe("number");
    expect(pr.state).toBe("open");

    // touches
    for (const touch of [
      { frame_id: "src/temporal", node_name: "timeline.ts", action: "added" as const },
      { frame_id: "src/temporal", node_name: "ordering.ts", action: "added" as const },
      { frame_id: "src/events", node_name: "emitter.ts", action: "modified" as const },
    ]) {
      const tRes = await callTool(h, "add_pr_touch", { pr_number: pr.number, ...touch });
      expect(tRes.isError).toBeFalsy();
    }

    // propose a decision introduced by the PR
    const propRes = await callTool(h, "propose_decision", {
      title: "causal ordering",
      problem: "need order",
      resolution: "Lamport + wall clock",
      rationale: "causal consistency",
      pr_number: pr.number,
    });
    const prop = JSON.parse(propRes.content[0].text);
    expect(prop.status).toBe("proposed");

    // merge
    const mRes = await callTool(h, "merge_pr", { pr_number: pr.number });
    const merged = JSON.parse(mRes.content[0].text);
    expect(merged.ratified_decisions).toContain(prop.id);

    // PR and decision final state
    const getPr = JSON.parse((await callTool(h, "get_pr", { pr_number: pr.number })).content[0].text);
    expect(getPr.state).toBe("merged");
    const getDec = JSON.parse((await callTool(h, "get_decision", { id: prop.id })).content[0].text);
    expect(getDec.status).toBe("active");
  });

  it("merge_pr on unknown number returns No results", async () => {
    const res = await callTool(h, "merge_pr", { pr_number: 99999 });
    expect(res.content[0].text.startsWith("No results:")).toBe(true);
  });

  it("get_pr on unknown number returns No results", async () => {
    const res = await callTool(h, "get_pr", { pr_number: 99999 });
    expect(res.content[0].text.startsWith("No results:")).toBe(true);
  });
});

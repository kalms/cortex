import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, makeIndexedRepoFixture, type HarnessContext, callTool } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";
import { rmSync } from "node:fs";

describe("PR tools contract — lifecycle", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("open_pr → add_pr_touch × 3 → propose_decision(pr_number) → merge_pr ratifies", async () => {
    // open
    const openRes = await callTool(h, "pr", { action: "open", title: "temporal subsystem", author: "mira", introduces_frame: "src/temporal" });
    expect(ResponseSchema.safeParse(openRes).success).toBe(true);
    expect(openRes.isError).toBeFalsy();
    const pr = JSON.parse(openRes.content[0].text);
    expect(typeof pr.number).toBe("number");
    expect(pr.state).toBe("open");

    // touches
    for (const touch of [
      { frame_id: "src/temporal", node_name: "timeline.ts", change: "added" as const },
      { frame_id: "src/temporal", node_name: "ordering.ts", change: "added" as const },
      { frame_id: "src/events", node_name: "emitter.ts", change: "modified" as const },
    ]) {
      const tRes = await callTool(h, "pr", { action: "touch", pr_number: pr.number, ...touch });
      expect(tRes.isError).toBeFalsy();
    }

    // propose a decision introduced by the PR
    const propRes = await callTool(h, "decision", {
      action: "propose",
      title: "causal ordering",
      problem: "need order",
      resolution: "Lamport + wall clock",
      rationale: "causal consistency",
      pr_number: pr.number,
    });
    const prop = JSON.parse(propRes.content[0].text);
    expect(prop.status).toBe("proposed");

    // merge
    const mRes = await callTool(h, "pr", { action: "merge", pr_number: pr.number });
    const merged = JSON.parse(mRes.content[0].text);
    expect(merged.ratified_decisions).toContain(prop.id);

    // PR and decision final state
    const getPr = JSON.parse((await callTool(h, "pr", { action: "get", pr_number: pr.number })).content[0].text);
    expect(getPr.state).toBe("merged");
    const getDec = JSON.parse((await callTool(h, "decision", { action: "get", id: prop.id })).content[0].text);
    expect(getDec.status).toBe("active");
  });

  it("merge_pr on unknown number returns No results", async () => {
    const res = await callTool(h, "pr", { action: "merge", pr_number: 99999 });
    expect(res.content[0].text.startsWith("No results:")).toBe(true);
  });

  it("get_pr on unknown number returns No results", async () => {
    const res = await callTool(h, "pr", { action: "get", pr_number: 99999 });
    expect(res.content[0].text.startsWith("No results:")).toBe(true);
  });
});

describe("PR tools per-call routing", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("rejects open_pr when repo_path is missing", async () => {
    const res = await callTool(h, "pr", {
      repo_path: undefined,
      action: "open",
      title: "x",
      author: "a",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/);
  });

  it("rejects add_pr_touch when repo_path is missing", async () => {
    const res = await callTool(h, "pr", {
      repo_path: undefined,
      action: "touch",
      pr_number: 1,
      frame_id: "f",
      node_name: "n",
      change: "added",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/);
  });

  it("rejects merge_pr when repo_path is missing", async () => {
    const res = await callTool(h, "pr", { repo_path: undefined, action: "merge", pr_number: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/);
  });

  it("rejects get_pr when repo_path is missing", async () => {
    const res = await callTool(h, "pr", { repo_path: undefined, action: "get", pr_number: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/repo_path required/);
  });

  it("PR lifecycle routes to addressed repo — open in repoB, get from repoB", async () => {
    // PRs live in the addressed repo's graph DB (pull_request nodes).
    // Open a PR in a second repo (repoB) and confirm get_pr against that
    // same repo returns it. If routing were broken — i.e. PRs landing in
    // the harness primary repo — get_pr against repoB would say "not found".
    const repoB = makeIndexedRepoFixture();
    try {
      const openRes = await callTool(h, "pr", {
        action: "open",
        repo_path: repoB,
        title: "routing-test",
        author: "rka",
      });
      expect(openRes.isError).toBeFalsy();
      const pr = JSON.parse(openRes.content[0].text);
      expect(typeof pr.number).toBe("number");

      // PR should be visible in repoB
      const getRes = await callTool(h, "pr", { action: "get", repo_path: repoB, pr_number: pr.number });
      expect(getRes.isError).toBeFalsy();
      const got = JSON.parse(getRes.content[0].text);
      expect(got.title).toBe("routing-test");

      // ...and NOT in the harness primary repo (because writes routed to repoB).
      const getHarness = await callTool(h, "pr", {
        action: "get",
        repo_path: h.repoPath,
        pr_number: pr.number,
      });
      // Either explicit "No results" or a record with a different title (if
      // by coincidence the harness DB has a PR with that number from a
      // previous test — but the title would differ).
      if (!getHarness.content[0].text.startsWith("No results:")) {
        const harnessPr = JSON.parse(getHarness.content[0].text);
        expect(harnessPr.title).not.toBe("routing-test");
      }
    } finally {
      try { rmSync(repoB, { recursive: true }); } catch { /* ignore */ }
    }
  });
});

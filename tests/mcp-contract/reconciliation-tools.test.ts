import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("record_reconciliation", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); process.env.CORTEX_RECONCILE = "1"; });
  afterAll(async () => { delete process.env.CORTEX_RECONCILE; await h.close(); });

  it("rejects a decision with zero GOVERNS links", async () => {
    const created = await callTool(h, "decision", { action: "create", title: "no-governs", description: "d", rationale: "r" });
    const id = JSON.parse(created.content[0].text).id;
    const res = await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "match" });
    expect(res.isError).toBeTruthy();
    expect(res.content[0].text).toMatch(/governs/i);
  });

  it("match round-trip: record → get_decision shows verdict", async () => {
    writeFileSync(join(h.repoPath, "x.ts"), "export const v = 1;\n");
    const created = await callTool(h, "decision", {
      action: "create",
      title: "governs x", description: "d", rationale: "r", resolution: "x exports v = 1",
    });
    const id = JSON.parse(created.content[0].text).id;
    await callTool(h, "decision", { action: "link", decision_id: id, target: "x.ts", relation: "GOVERNS" });
    const rec = await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "match" });
    expect(rec.isError).toBeFalsy();
    const parsed = JSON.parse((await callTool(h, "decision", { action: "get", id })).content[0].text);
    expect(parsed.reconciliation_verdict).toBe("match");
    // display_state asserted in Task 6
  });

  it("pending_reconciliations: lists active+drifted with source; excludes in-sync", async () => {
    writeFileSync(join(h.repoPath, "y.ts"), "export const y = 1;\n");
    const c = await callTool(h, "decision", { action: "create", title: "governs y", description: "d", rationale: "r", resolution: "y is 1" });
    const id = JSON.parse(c.content[0].text).id;
    await callTool(h, "decision", { action: "link", decision_id: id, target: "y.ts", relation: "GOVERNS" });
    await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "match" });

    // In sync → not pending.
    let res = await callTool(h, "decision", { action: "pending" });
    let ids = res.isError ? [] : (JSON.parse(res.content[0].text).pending as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain(id);

    // Edit the governed file → drifted → pending, with current source inlined.
    writeFileSync(join(h.repoPath, "y.ts"), "export const y = 2;\n");
    res = await callTool(h, "decision", { action: "pending" });
    const entry = (JSON.parse(res.content[0].text).pending as Array<any>).find((p) => p.id === id);
    expect(entry).toBeDefined();
    expect(entry.governed[0].source).toContain("y = 2");
  });

  it("pending_reconciliations: excludes superseded decisions", async () => {
    writeFileSync(join(h.repoPath, "z.ts"), "export const z = 1;\n");
    const c = await callTool(h, "decision", { action: "create", title: "governs z", description: "d", rationale: "r" });
    const id = JSON.parse(c.content[0].text).id;
    await callTool(h, "decision", { action: "link", decision_id: id, target: "z.ts", relation: "GOVERNS" });
    await callTool(h, "decision", { action: "update", id, status: "superseded" });
    const res = await callTool(h, "decision", { action: "pending" });
    const ids = res.isError ? [] : (JSON.parse(res.content[0].text).pending as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain(id);
  });

  it("pending_reconciliations: excludes deprecated decisions", async () => {
    writeFileSync(join(h.repoPath, "dep.ts"), "export const d = 1;\n");
    const c = await callTool(h, "decision", { action: "create", title: "governs dep", description: "d", rationale: "r" });
    const id = JSON.parse(c.content[0].text).id;
    await callTool(h, "decision", { action: "link", decision_id: id, target: "dep.ts", relation: "GOVERNS" });
    await callTool(h, "decision", { action: "update", id, status: "deprecated" });
    const res = await callTool(h, "decision", { action: "pending" });
    const ids = res.isError ? [] : (JSON.parse(res.content[0].text).pending as Array<{ id: string }>).map((p) => p.id);
    expect(ids).not.toContain(id);
  });

  it("pending_reconciliations: respects the limit", async () => {
    // Two fresh never-judged governed decisions guarantee >= 2 pending overall.
    for (const n of ["lim1.ts", "lim2.ts"]) {
      writeFileSync(join(h.repoPath, n), "x");
      const c = await callTool(h, "decision", { action: "create", title: `g ${n}`, description: "d", rationale: "r" });
      const id = JSON.parse(c.content[0].text).id;
      await callTool(h, "decision", { action: "link", decision_id: id, target: n, relation: "GOVERNS" });
    }
    const res = await callTool(h, "decision", { action: "pending", limit: 1 });
    expect(JSON.parse(res.content[0].text).pending.length).toBe(1);
  });

  it("full loop: create → judge match → drift → judge drift → fix → judge match", async () => {
    const parse = async (id: string) => JSON.parse((await callTool(h, "decision", { action: "get", id })).content[0].text);
    const file = join(h.repoPath, "loop.ts");

    writeFileSync(file, "export const v = 1;\n");
    const c = await callTool(h, "decision", { action: "create", title: "loop", description: "d", rationale: "r", resolution: "v is 1" });
    const id = JSON.parse(c.content[0].text).id;
    await callTool(h, "decision", { action: "link", decision_id: id, target: "loop.ts", relation: "GOVERNS" });

    // 1. judge match → active
    await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "match" });
    expect((await parse(id)).display_state).toBe("active");

    // 2. edit governed file → drifted ⇒ verdict treated as unknown until re-judged
    writeFileSync(file, "export const v = 2;\n");
    expect((await parse(id)).display_state).toBe("active · unreconciled");

    // 3. judge drift → stale
    await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "drift" });
    expect((await parse(id)).display_state).toBe("stale");

    // 4. re-judge match against the current content → active
    await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "match" });
    expect((await parse(id)).display_state).toBe("active");
  });
});

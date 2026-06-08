import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, callTool, type HarnessContext } from "./harness.js";

describe("record_reconciliation", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); process.env.CORTEX_RECONCILE = "1"; });
  afterAll(async () => { delete process.env.CORTEX_RECONCILE; await h.close(); });

  it("rejects a decision with zero GOVERNS links", async () => {
    const created = await callTool(h, "create_decision", { title: "no-governs", description: "d", rationale: "r" });
    const id = JSON.parse(created.content[0].text).id;
    const res = await callTool(h, "record_reconciliation", { decision_id: id, verdict: "match" });
    expect(res.isError).toBeTruthy();
    expect(res.content[0].text).toMatch(/governs/i);
  });

  it("match round-trip: record → get_decision shows verdict", async () => {
    writeFileSync(join(h.repoPath, "x.ts"), "export const v = 1;\n");
    const created = await callTool(h, "create_decision", {
      title: "governs x", description: "d", rationale: "r", resolution: "x exports v = 1",
    });
    const id = JSON.parse(created.content[0].text).id;
    await callTool(h, "link_decision", { decision_id: id, target: "x.ts", relation: "GOVERNS" });
    const rec = await callTool(h, "record_reconciliation", { decision_id: id, verdict: "match" });
    expect(rec.isError).toBeFalsy();
    const parsed = JSON.parse((await callTool(h, "get_decision", { id })).content[0].text);
    expect(parsed.reconciliation_verdict).toBe("match");
    // display_state asserted in Task 6
  });
});

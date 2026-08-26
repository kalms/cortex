import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, callTool, type HarnessContext } from "./harness.js";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("record_reconciliation", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

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

  it("moves basis_hash on a match verdict but not on drift", async () => {
    const mk = async (title: string) => {
      const c = await callTool(h, "decision", {
        action: "create", title, description: "d", rationale: "r", governs: ["x.ts"],
      });
      return JSON.parse(c.content[0].text as string).id as string;
    };
    const basisOf = (id: string): string | null => {
      const db = openDecisionsDb(resolveDecisionsDbPath(h.repoPath));
      try {
        return (db.prepare("SELECT basis_hash FROM decisions WHERE id=?").get(id) as
          { basis_hash: string | null }).basis_hash;
      } finally { db.close(); }
    };

    // The tree MUST change between create and reconcile, or both assertions
    // pass on the digest already stamped at create and prove nothing.
    writeFileSync(join(h.repoPath, "x.ts"), "export const v = 1;\n");

    // drift asserts the code has moved AWAY from the decision — adopting the
    // current tree as the new baseline would silently mark the row clean.
    const drifted = await mk("verdict drift leaves basis alone");
    const beforeDrift = basisOf(drifted);
    expect(beforeDrift).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(h.repoPath, "x.ts"), "export const v = 2;\n");
    await callTool(h, "decision", { action: "reconcile", decision_id: drifted, verdict: "drift" });
    expect(basisOf(drifted)).toBe(beforeDrift);

    // match asserts the prose describes the code as it stands, so the current
    // tree legitimately becomes the reference point.
    const matched = await mk("verdict match moves basis");
    const beforeMatch = basisOf(matched);
    writeFileSync(join(h.repoPath, "x.ts"), "export const v = 3;\n");
    await callTool(h, "decision", { action: "reconcile", decision_id: matched, verdict: "match" });
    const afterMatch = basisOf(matched);
    expect(afterMatch).toMatch(/^[0-9a-f]{64}$/);
    expect(afterMatch).not.toBe(beforeMatch);
  });

  it("refuses a match verdict while a governed ref is unresolved", async () => {
    const created = await callTool(h, "decision", {
      action: "create", title: "governs a ghost", description: "d", rationale: "r",
      governs: ["src/does-not-exist.ts"],
    });
    const id = JSON.parse(created.content[0].text as string).id as string;

    const res = await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "match" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("src/does-not-exist.ts");
  });

  // NOTE these two never reach the guard — it only fires on `match`. They are
  // evidence that the refusal is SCOPED to match, not evidence the guard
  // exists (the match test above is that). Both verdicts must stay open: a
  // decision governing code that never landed is exactly what an agent needs
  // to be able to record as drifted or partial.
  it("still allows drift while a governed ref is unresolved", async () => {
    const created = await callTool(h, "decision", {
      action: "create", title: "governs a ghost too", description: "d", rationale: "r",
      governs: ["src/also-missing.ts"],
    });
    const id = JSON.parse(created.content[0].text as string).id as string;
    const res = await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "drift" });
    expect(res.isError).toBeFalsy();
  });

  it("still allows partial while a governed ref is unresolved", async () => {
    const created = await callTool(h, "decision", {
      action: "create", title: "governs a third ghost", description: "d", rationale: "r",
      governs: ["src/still-missing.ts"],
    });
    const id = JSON.parse(created.content[0].text as string).id as string;
    const res = await callTool(h, "decision", { action: "reconcile", decision_id: id, verdict: "partial" });
    expect(res.isError).toBeFalsy();
  });
});

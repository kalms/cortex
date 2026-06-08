import { describe, it, expect } from "vitest";
import { attachDecisionReconciliation } from "../../src/mcp-server/reconciliation-attach.js";

// attachDecisionReconciliation(ctx, decisions, result): when CORTEX_RECONCILE=1
// and ≥1 active decision has a governed-source hash != its stored
// reconciled_source_hash, it pushes a NEW content block with the reconciliation
// note and adds a `reconciliation` field. content[0].text is left untouched so
// callers that JSON.parse it (get_decision returns an object; why_was_this_built
// and search_decisions return arrays) are not corrupted.
// No-op when the flag is off or nothing drifted.
// The `decisions` passed must be RAW records (carry status + reconciled_source_hash).
const fakeCtx = () => ({
  repoPath: "/nonexistent-repo",
  decisionLinksRepo: { findByDecision: () => [{ relation: "GOVERNS", target_kind: "path", target_ref: "x.ts" }] },
}) as any;

describe("attachDecisionReconciliation", () => {
  it("is a no-op when CORTEX_RECONCILE is unset", () => {
    const prev = process.env.CORTEX_RECONCILE; delete process.env.CORTEX_RECONCILE;
    try {
      const result = { content: [{ type: "text", text: "base" }] };
      const out = attachDecisionReconciliation(fakeCtx(), [{ id: "d1", status: "active", reconciled_source_hash: "old" }], result);
      expect(out.content[0].text).toBe("base");
      expect((out as any).reconciliation).toBeUndefined();
    } finally { if (prev !== undefined) process.env.CORTEX_RECONCILE = prev; }
  });

  it("attaches a block when enabled and a governed hash drifted", () => {
    const prev = process.env.CORTEX_RECONCILE; process.env.CORTEX_RECONCILE = "1";
    try {
      // hashGovernedSource over a non-existent /nonexistent-repo/x.ts yields a
      // stable hash that won't equal "old", so the decision reads as drifted.
      const result = { content: [{ type: "text", text: "base" }] };
      const out = attachDecisionReconciliation(fakeCtx(), [{ id: "d1", status: "active", reconciled_source_hash: "old" }], result);
      expect((out as any).reconciliation).toBeDefined();
      // content[0].text must remain untouched (pure JSON for callers that parse it)
      expect(out.content[0].text).toBe("base");
      // the note is emitted as a separate second content block
      expect(out.content.length).toBe(2);
      expect(out.content[1].text).toMatch(/reconcil/i);
    } finally { if (prev === undefined) delete process.env.CORTEX_RECONCILE; else process.env.CORTEX_RECONCILE = prev; }
  });

  it("does not attach for a non-active decision even when drifted", () => {
    const prev = process.env.CORTEX_RECONCILE; process.env.CORTEX_RECONCILE = "1";
    try {
      const result = { content: [{ type: "text", text: "base" }] };
      const out = attachDecisionReconciliation(fakeCtx(), [{ id: "d1", status: "superseded", reconciled_source_hash: "old" }], result);
      expect((out as any).reconciliation).toBeUndefined();
      expect(out.content[0].text).toBe("base");
    } finally { if (prev === undefined) delete process.env.CORTEX_RECONCILE; else process.env.CORTEX_RECONCILE = prev; }
  });
});

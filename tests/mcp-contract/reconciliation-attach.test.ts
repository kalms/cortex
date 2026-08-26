import { describe, it, expect } from "vitest";
import { attachDecisionReconciliation } from "../../src/mcp-server/reconciliation-attach.js";

// attachDecisionReconciliation(ctx, decisions, result): when ≥1 active decision
// has a governed-source hash != its stored reconciled_source_hash, it pushes a
// NEW content block with the reconciliation note and adds a `reconciliation`
// field. content[0].text is left untouched so callers that JSON.parse it
// (get_decision returns an object; why_was_this_built and search_decisions
// return arrays) are not corrupted.
// No-op when nothing drifted. Always on — not gated by any env flag.
// The `decisions` passed must be RAW records (carry status + reconciled_source_hash).
const fakeCtx = () => ({
  repoPath: "/nonexistent-repo",
  decisionLinksRepo: { findByDecision: () => [{ relation: "GOVERNS", target_kind: "path", target_ref: "x.ts" }] },
}) as any;

describe("attachDecisionReconciliation", () => {
  it("attaches for a drifted decision regardless of any env flag", () => {
    const prev = process.env.CORTEX_RECONCILE;
    delete process.env.CORTEX_RECONCILE;          // the flag is gone; absence must not disable
    try {
      // hashGovernedSource over a non-existent /nonexistent-repo/x.ts yields a
      // stable hash that won't equal "old", so the decision reads as drifted.
      const result = { content: [{ type: "text", text: "base" }] };
      const out = attachDecisionReconciliation(fakeCtx(), [{ id: "d1", status: "active", reconciled_source_hash: "old" }], result);
      expect((out as any).reconciliation).toBeDefined();
      // content[0].text must remain untouched (pure JSON for callers that parse it)
      expect(out.content[0].text).toBe("base");
      // the note is emitted as a separate second content block
      expect(out.content.length).toBeGreaterThan(1);
      expect(out.content[1].text).toMatch(/reconcil/i);
    } finally {
      if (prev !== undefined) process.env.CORTEX_RECONCILE = prev;
    }
  });

  it("does not attach for a non-active decision even when drifted", () => {
    const result = { content: [{ type: "text", text: "base" }] };
    const out = attachDecisionReconciliation(fakeCtx(), [{ id: "d1", status: "superseded", reconciled_source_hash: "old" }], result);
    expect((out as any).reconciliation).toBeUndefined();
    expect(out.content[0].text).toBe("base");
  });
});

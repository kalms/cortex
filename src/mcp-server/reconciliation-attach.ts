import type { RepoContext } from "./repo-context.js";
import type { DecisionRecord } from "../decisions/repository.js";
import { hashGovernedSource, displayState, type GovernedRef } from "../decisions/reconciliation.js";

type TextResult = { content: Array<{ type: string; text: string }>; [k: string]: unknown };

export function governedRefs(ctx: RepoContext, id: string): GovernedRef[] {
  return ctx.decisionLinksRepo.findByDecision(id)
    .filter((l) => l.relation === "GOVERNS")
    .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
}

/**
 * For each ACTIVE decision in `decisions`, decide whether its cached verdict is
 * stale-pending (current governed hash != reconciled_source_hash, or never
 * judged with GOVERNS links present). When ≥1 is stale-pending, append a
 * one-line note + a structured `reconciliation` block instructing the agent
 * to judge and call record_reconciliation. No-op when nothing drifted.
 * Mutates and returns `result`.
 *
 * IMPORTANT: pass RAW DecisionRecords (which carry reconciled_source_hash);
 * service Decisions strip that column.
 */
export function attachDecisionReconciliation<T extends TextResult>(
  ctx: RepoContext,
  decisions: Array<Partial<DecisionRecord> & { id: string; status: string }>,
  result: T,
): T {
  const pending: Array<{ id: string; state: string; last_verdict: string }> = [];
  for (const d of decisions) {
    if (d.status !== "active") continue;
    const refs = governedRefs(ctx, d.id);
    if (refs.length === 0) continue;
    const current = hashGovernedSource(ctx.repoPath, refs);
    if (current === d.reconciled_source_hash) continue;
    pending.push({ id: d.id, state: "stale-pending", last_verdict: d.reconciliation_verdict ?? "unknown" });
  }
  if (pending.length === 0) return result;
  const note = `↻ cortex reconciliation: ${pending.length} governed decision(s) drifted since last verdict — judge match/partial/drift and call record_reconciliation(decision_id, verdict).`;
  // Emit as a SEPARATE content block so content[0].text stays pure JSON for
  // callers that parse it (get_decision returns an object; why_was_this_built
  // and search_decisions return arrays). The structured `reconciliation` field
  // carries the machine-readable signal; this block is the agent-facing nudge.
  result.content.push({ type: "text", text: note });
  (result as TextResult).reconciliation = { pending };
  return result;
}

/** Compute display_state for a single decision (raw record). Used by get_decision. */
export function decisionDisplayState(
  ctx: RepoContext,
  d: Partial<DecisionRecord> & { id: string; status: string },
): string {
  const refs = governedRefs(ctx, d.id);
  if (refs.length === 0) return displayState(d.status, "unknown");
  const current = hashGovernedSource(ctx.repoPath, refs);
  const verdict = current === d.reconciled_source_hash ? (d.reconciliation_verdict ?? null) : null; // drifted ⇒ unknown
  return displayState(d.status, verdict);
}

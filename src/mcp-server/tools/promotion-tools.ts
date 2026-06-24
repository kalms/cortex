import { z } from "zod";
import { DecisionPromotion } from "../../decisions/promotion.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { type RepoContext } from "../repo-context.js";
import type { EventBus } from "../../events/bus.js";

// The startup-bound `promotion` parameter is gone — promote() routes per-call
// via promotionFor(ctx), so the wrapper builds a fresh DecisionPromotion from
// the addressed repo's decisions DB on every call.

const RepoPathField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "REQUIRED. Absolute path to the indexed git root this decision is about. " +
      "If you don't know it, call list_projects first.",
  );

const promoteDecisionShape = {
  repo_path: RepoPathField,
  id: z.string().describe("Decision node ID"),
  tier: z.enum(["team", "public"]).describe("Target visibility tier"),
} as const;
const promoteDecisionSchema = z.object(promoteDecisionShape);

/**
 * Extracted promote_decision handler logic. Holds the EXACT body the
 * `server.tool("promote_decision", …)` registration used to inline. Both that
 * registration and the `decision` dispatcher (action "promote") call this — one
 * source of behavior. The per-call DecisionPromotion the former `promotionFor`
 * closure built is rebuilt inline here from the same RepoContext handles, with
 * `bus` / `indexerProject` taken as params (the closure captured them).
 */
export async function promoteDecisionAction(
  ctx: RepoContext,
  args: z.infer<typeof promoteDecisionSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const { id, tier } = args;
  try {
    const promotion = new DecisionPromotion(
      ctx.decisionsRepo,
      bus ? { bus, project_id: indexerProject ?? "" } : {},
    );
    const decision = promotion.promote(id, tier);
    return ok(JSON.stringify(decision, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return empty(`promote_decision(${id})`);
    return errorResponse("internal_error", msg);
  }
}


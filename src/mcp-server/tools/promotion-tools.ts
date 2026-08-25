import { z } from "zod";
import { DecisionPromotion } from "../../decisions/promotion.js";
import { captureOrigin } from "../../git/origin.js";
import { ok } from "../response.js";
import { type RepoContext } from "../repo-context.js";
import type { EventBus } from "../../events/bus.js";
import { RepoPathField } from "./shared-fields.js";
import { execAction } from "./exec-action.js";

// The startup-bound `promotion` parameter is gone — promote() routes per-call
// via promotionFor(ctx), so the wrapper builds a fresh DecisionPromotion from
// the addressed repo's decisions DB on every call.

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
  return execAction(`promote_decision(${id})`, () => {
    const promotion = new DecisionPromotion(
      ctx.decisionsRepo,
      bus ? { bus, project_id: indexerProject ?? "" } : {},
    );
    // captureOrigin is called HERE, in the handler, on ctx.repoPath (the
    // checkout root) — never in DecisionPromotion, which stays free of git
    // dependencies (same rule Task 3 established for the service layer).
    const origin = captureOrigin(ctx.repoPath);
    const decision = promotion.promote(id, tier, origin);
    return ok(JSON.stringify(decision, null, 2));
  });
}


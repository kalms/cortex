import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionPromotion } from "../../decisions/promotion.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import type { EventBus } from "../../events/bus.js";

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

export function registerPromotionTools(
  server: McpServer,
  promotion: DecisionPromotion,
  resolver: RepoContextResolver,
  indexerProject?: string | null,
  bus?: EventBus,
): void {
  // Per-call promotion construction — promote() needs a DecisionsRepository
  // anchored to the repo addressed by ctx.repo_path so the tier flip lands
  // in the right decisions DB. Bus + project_id remain startup-bound; the
  // event pipeline is server-scoped, not repo-scoped (Phase 5 revisits).
  const promotionFor = (ctx: RepoContext): DecisionPromotion =>
    new DecisionPromotion(
      ctx.decisionsRepo,
      bus ? { bus, project_id: indexerProject ?? "" } : {},
    );

  server.tool(
    "promote_decision",
    "Promote a decision to team or public visibility tier",
    promoteDecisionShape,
    registerTool(
      "promote_decision",
      promoteDecisionSchema,
      async (ctx, args) => {
        const { id, tier } = args;
        try {
          const decision = promotionFor(ctx).promote(id, tier);
          return ok(JSON.stringify(decision, null, 2));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/not found/i.test(msg)) return empty(`promote_decision(${id})`);
          return errorResponse("internal_error", msg);
        }
      },
      { resolver },
    ),
  );
}

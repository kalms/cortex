import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionPromotion } from "../../decisions/promotion.js";
import { ok, empty, error as errorResponse } from "../response.js";

export function registerPromotionTools(server: McpServer, promotion: DecisionPromotion): void {
  server.tool(
    "promote_decision",
    "Promote a decision to team or public visibility tier",
    {
      id: z.string().describe("Decision node ID"),
      tier: z.enum(["team", "public"]).describe("Target visibility tier"),
    },
    async ({ id, tier }) => {
      try {
        const decision = promotion.promote(id, tier);
        return ok(JSON.stringify(decision, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`promote_decision(${id})`);
        return errorResponse("internal_error", msg);
      }
    }
  );
}

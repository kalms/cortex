import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DecisionPromotion } from "../../decisions/promotion.js";

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
        return { content: [{ type: "text" as const, text: JSON.stringify(decision, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(e) }) }], isError: true };
      }
    }
  );
}

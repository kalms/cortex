import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphStore } from "../graph/store.js";
import { DecisionService } from "../decisions/service.js";
import { DecisionSearch } from "../decisions/search.js";
import { DecisionPromotion } from "../decisions/promotion.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerPromotionTools } from "./tools/promotion-tools.js";
import { registerCodeTools } from "./tools/code-tools.js";
import type { EventBus } from "../events/bus.js";

export function createServer(
  store: GraphStore,
  cbmProject: string | null = null,
  bus?: EventBus,
): McpServer {
  const server = new McpServer({
    name: "cortex",
    version: "0.1.0",
  });

  const decisionService = new DecisionService(
    store,
    bus ? { bus, project_id: cbmProject ?? "" } : {},
  );
  const decisionSearch = new DecisionSearch(store);
  const decisionPromotion = new DecisionPromotion(
    store,
    bus ? { bus, project_id: cbmProject ?? "" } : {},
  );

  registerDecisionTools(server, decisionService, decisionSearch);
  registerPromotionTools(server, decisionPromotion);
  registerCodeTools(server, store, cbmProject);

  return server;
}

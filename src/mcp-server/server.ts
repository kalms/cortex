import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphStore } from "../graph/store.js";
import { DecisionService } from "../decisions/service.js";
import { DecisionSearch } from "../decisions/search.js";
import { DecisionPromotion } from "../decisions/promotion.js";
import { PRService } from "../prs/service.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerPromotionTools } from "./tools/promotion-tools.js";
import { registerCodeTools } from "./tools/code-tools.js";
import { registerPRTools } from "./tools/pr-tools.js";
import type { EventBus } from "../events/bus.js";

export function createServer(
  store: GraphStore,
  indexerProject: string | null = null,
  bus?: EventBus,
): McpServer {
  const server = new McpServer({
    name: "cortex",
    version: "0.1.0",
  });

  const decisionService = new DecisionService(
    store,
    bus ? { bus, project_id: indexerProject ?? "" } : {},
  );
  const decisionSearch = new DecisionSearch(store);
  const decisionPromotion = new DecisionPromotion(
    store,
    bus ? { bus, project_id: indexerProject ?? "" } : {},
  );
  const prService = new PRService(store, {
    bus: bus,
    default_actor: "system",
    project_id: indexerProject ?? "",
    decisions: decisionService,
  });

  registerDecisionTools(server, decisionService, decisionSearch);
  registerPromotionTools(server, decisionPromotion);
  registerCodeTools(server, store, indexerProject);
  registerPRTools(server, prService);

  return server;
}

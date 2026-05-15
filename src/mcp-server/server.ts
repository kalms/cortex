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
import { resolveDecisionsDbPath, resolveCortexDbPath } from "../db/resolve-path.js";
import { openDecisionsDb } from "../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../decisions/migration.js";
import { DecisionsRepository } from "../decisions/repository.js";
import { DecisionLinksRepository } from "../decisions/links-repository.js";
import type { EventBus } from "../events/bus.js";

export function createServer(
  store: GraphStore,
  indexerProject: string | null = null,
  bus?: EventBus,
  repoPath: string = process.cwd(),
): McpServer {
  const server = new McpServer({
    name: "cortex",
    version: "0.1.0",
  });

  // Sidecar decisions DB. Opened next to .cortex/db (the graph DB) — see
  // src/db/resolve-path.ts. The migration is idempotent: it runs once per
  // sidecar DB (gated by schema_meta) and pulls any pre-existing decisions
  // out of the graph DB. After Task 12 cleans up writes to graph.db, this
  // is the sole source of truth for decisions and their links.
  const decisionsDbPath = resolveDecisionsDbPath(repoPath);
  const graphDbPath = resolveCortexDbPath(repoPath);
  const decisionsDb = openDecisionsDb(decisionsDbPath);
  migrateDecisionsFromGraphDb(decisionsDb, graphDbPath);
  const decisionsRepo = new DecisionsRepository(decisionsDb);
  const decisionLinksRepo = new DecisionLinksRepository(decisionsDb);

  const decisionService = new DecisionService({
    decisions: decisionsRepo,
    links: decisionLinksRepo,
    bus,
    project_id: indexerProject ?? "",
  });
  const decisionSearch = new DecisionSearch(decisionsRepo, decisionLinksRepo);
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

  registerDecisionTools(server, decisionService, decisionSearch, decisionLinksRepo);
  registerPromotionTools(server, decisionPromotion);
  registerCodeTools(server, store, indexerProject);
  registerPRTools(server, prService);

  return server;
}

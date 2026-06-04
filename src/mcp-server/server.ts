import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphStore } from "../graph/store.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerPromotionTools } from "./tools/promotion-tools.js";
import { registerCodeTools } from "./tools/code-tools.js";
import { registerPRTools } from "./tools/pr-tools.js";
import { resolveDecisionsDbPath, resolveCortexDbPath } from "../db/resolve-path.js";
import { openDecisionsDb } from "../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../decisions/migration.js";
import { RepoContextResolver } from "./repo-context.js";
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

  // One-shot defensive decisions migration for the startup-bound repo.
  // After this point all tools route through the resolver, which also runs
  // the (idempotent) migration on first touch — so this is belt-and-braces
  // for the case where a CLI consumer expects the legacy startup behavior
  // (open decisions DB, migrate, close) to have completed before the first
  // tool call.
  const decisionsDbPath = resolveDecisionsDbPath(repoPath);
  const graphDbPath = resolveCortexDbPath(repoPath);
  const decisionsDb = openDecisionsDb(decisionsDbPath);
  try {
    migrateDecisionsFromGraphDb(decisionsDb, graphDbPath);
  } finally {
    decisionsDb.close();
  }

  // Per-call repo context resolver. All Phase 3 Group A + B tools route
  // through this. Phase 4 will close out list_projects + delete_project as
  // crossRepo, draining the last startup-bound handle (`store`).
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  registerDecisionTools(server, resolver, indexerProject, bus);
  registerPromotionTools(server, resolver, indexerProject, bus);
  registerCodeTools(server, store, indexerProject, resolver, graphDbPath);
  registerPRTools(server, resolver, indexerProject, bus);

  return server;
}

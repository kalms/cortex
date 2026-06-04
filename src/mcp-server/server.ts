import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDecisionTools } from "./tools/decision-tools.js";
import { registerPromotionTools } from "./tools/promotion-tools.js";
import { registerCodeTools } from "./tools/code-tools.js";
import { registerPRTools } from "./tools/pr-tools.js";
import { resolveDecisionsDbPath, resolveCortexDbPath } from "../db/resolve-path.js";
import { openDecisionsDb } from "../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../decisions/migration.js";
import { RepoContextResolver } from "./repo-context.js";
import type { EventBus } from "../events/bus.js";

/**
 * Build the MCP server. After Phase 4 every tool routes per-call through
 * the resolver, so no startup-bound GraphStore is needed here — the previous
 * `store` parameter has been dropped.
 *
 * `repoPath` is still useful for the one-shot defensive decisions migration
 * (so a CLI consumer that expects the legacy startup behavior of "open
 * decisions DB, migrate, close" still gets it), but no tool handler closes
 * over it.
 */
export function createServer(
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

  // Per-call repo context resolver — every tool routes through this.
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  registerDecisionTools(server, resolver, indexerProject, bus);
  registerPromotionTools(server, resolver, indexerProject, bus);
  registerCodeTools(server, resolver);
  registerPRTools(server, resolver, indexerProject, bus);

  return server;
}

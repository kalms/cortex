import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCodeTools } from "./tools/code-tools.js";
import { registerTodoTools } from "./tools/todo-tools.js";
import { registerDecisionDispatcher } from "./tools/decision-dispatcher.js";
import { registerPRDispatcher } from "./tools/pr-dispatcher.js";
import { RepoContextResolver } from "./repo-context.js";
import type { EventBus } from "../events/bus.js";

/**
 * Build the MCP server. After Phase 5 the server holds no repo-scoped state
 * — every tool routes per-call through {@link RepoContextResolver}, which
 * opens DB handles and runs the idempotent decisions migration on first
 * touch for each addressed repo.
 *
 * Retained server-scoped concerns:
 *   - `indexerProject`: default in-graph project name stamped into events
 *     emitted by event-bus-aware tools (decisions, PRs). The event pipeline
 *     is server-scoped, not repo-scoped — a single subscriber wants a stable
 *     id over the server's lifetime.
 *   - `bus`: event bus used by decision/promotion/PR tools to broadcast.
 *
 * Dropped over Phases 2-5:
 *   - `store`: per-tool handlers now own per-call `GraphStore` instances via
 *     `RepoContext.store` (Phase 4).
 *   - `repoPath`: the previous startup-time path served only to run an
 *     eager defensive decisions migration. The resolver runs that same
 *     migration on first touch per-repo, so a startup-time pass would only
 *     ever apply to the home repo — exactly the cwd-binding this migration
 *     set out to remove. The build of `index.ts` runs `index_repository`
 *     and other tools by `repo_path`, so any consumer that expected the
 *     legacy "open, migrate, close" sequencing for some specific repo
 *     can call `resolver.resolve(path)` (or just invoke a tool against that
 *     path) and get the same idempotent migration as a side effect.
 */
export function createServer(
  indexerProject: string | null = null,
  bus?: EventBus,
): McpServer {
  const server = new McpServer({
    name: "cortex",
    version: "0.1.0",
  });

  // Per-call repo context resolver — every tool routes through this.
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  registerCodeTools(server, resolver);
  registerTodoTools(server, resolver);
  registerDecisionDispatcher(server, resolver, indexerProject, bus);
  registerPRDispatcher(server, resolver, indexerProject, bus);

  return server;
}

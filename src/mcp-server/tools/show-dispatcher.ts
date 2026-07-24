import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { ok } from "../response.js";
import { RepoPathField } from "./shared-fields.js";
import { postToViewer } from "./viewer-post.js";

// ---------------------------------------------------------------------------
// The consolidated `show` MCP tool.
//
// One action today (`focus`) — a spotlight verb that posts a set of refs (and
// an optional note) to the local viewer's `/api/show-focus` HTTP endpoint, so
// a person looking at the Frames viewer sees exactly what the agent is
// currently pointing at. This is delivery-only: the tool never mutates the
// graph or the decisions store, and it never throws for an unreachable
// viewer — "no viewer running" is a normal, expected state, not a tool
// failure. Mirrors the `decision`/`pr` dispatcher shape (decisionShape /
// registerDecisionDispatcher in decision-dispatcher.ts) so the MCP surface
// stays one-tool-per-noun, action-dispatched.
// ---------------------------------------------------------------------------

const showShape = {
  repo_path: RepoPathField,
  action: z
    .enum(["focus"])
    .describe("focus: hold a spotlight on refs in the viewer; refs: [] clears it"),
  refs: z.array(z.string()).max(50).optional(),
  note: z.string().max(2000).optional(),
} as const;

const showSchema = z.object(showShape);

/**
 * The dispatching handler for the consolidated `show` tool. Registers with
 * `{ resolver }` only — no freshnessAware/briefAware, matching the decision
 * dispatcher's registration (this tool delivers a spotlight, it doesn't read
 * the graph or decisions store).
 */
export const showHandler = (resolver: RepoContextResolver) =>
  registerTool(
    "show",
    showSchema,
    async (ctx: RepoContext, args) => {
      switch (args.action) {
        case "focus": {
          const refs = args.refs ?? [];
          const { delivered, accepted } = await postToViewer("/api/show-focus", {
            repo_path: ctx.repoPath,
            refs,
            note: args.note,
          });
          if (!delivered) {
            return ok("No viewer reachable (start the MCP server / check CORTEX_VIEWER_PORT)");
          }
          if (!accepted) {
            return ok("Viewer rejected (different repo owns the viewer)");
          }
          return ok(
            refs.length > 0
              ? `Spotlight set (${refs.length} refs) — clear with refs: []`
              : "Spotlight cleared",
          );
        }
      }
    },
    { resolver },
  );

/**
 * Register the consolidated `show` tool on an MCP server. Mirrors
 * `registerDecisionDispatcher`'s registration shape.
 */
export function registerShowDispatcher(server: McpServer, resolver: RepoContextResolver): void {
  server.tool(
    "show",
    "Show: focus. Post a spotlight (refs + optional note) to the local viewer's " +
      "show-focus endpoint. `refs: []` clears the spotlight. Never throws for " +
      "an unreachable viewer.",
    showShape,
    showHandler(resolver),
  );
}

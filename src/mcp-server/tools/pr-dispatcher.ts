import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { error as errorResponse } from "../response.js";
import type { EventBus } from "../../events/bus.js";
import { openPRAction, addPRTouchAction, mergePRAction, getPRAction } from "./pr-tools.js";
import { RepoPathField } from "./shared-fields.js";

// ---------------------------------------------------------------------------
// Consolidated `pr` MCP dispatcher (Task 3.3).
//
// One tool, one `action` enum, four actions — a behavior-preserving facade
// over the per-action handler functions extracted into pr-tools.ts. There is
// exactly one source of behavior per action.
//
// The `touch` action renames the inner `action` field to `change` to free
// the `action` key for the dispatch discriminator. The dispatcher translates
// back before forwarding to addPRTouchAction (which expects `action` on the
// args object, matching the original PRService.addTouch contract).
// ---------------------------------------------------------------------------

const prShape = {
  repo_path: RepoPathField,
  action: z.enum(["open", "touch", "merge", "get"]).describe("Which PR operation to perform."),
  // open
  title: z.string().optional(),
  author: z.string().optional(),
  description: z.string().optional(),
  branch: z.string().optional(),
  state: z.enum(["draft", "open", "merged", "closed"]).optional(),
  introduces_frame: z.string().optional(),
  additions: z.number().int().optional(),
  source: z.enum(["native", "mirror", "scenario"]).optional(),
  external_ref: z
    .object({
      provider: z.string(),
      repo: z.string(),
      number: z.number().int(),
      url: z.string(),
    })
    .optional(),
  // touch / merge / get
  pr_number: z.number().int().optional(),
  frame_id: z.string().optional(),
  node_name: z.string().optional(),
  // `change` is the touch discriminator — was the inner `action` field on
  // add_pr_touch. Renamed here to free `action` for dispatch.
  change: z.enum(["added", "modified"]).optional(),
} as const;

const prSchema = z.object(prShape);

/**
 * The dispatching handler for the consolidated `pr` tool. Registers with
 * `{ resolver }` only (no freshnessAware — PR reads are not freshness-aware).
 *
 * The `touch` branch translates `change` back to `action` before forwarding
 * to addPRTouchAction, ensuring PRService.addTouch receives the field name it
 * expects while keeping the dispatcher surface clean.
 */
export const prHandler = (
  resolver: RepoContextResolver,
  bus?: EventBus,
  indexerProject?: string | null,
) =>
  registerTool(
    "pr",
    prSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (ctx: RepoContext, args) => {
      switch (args.action) {
        case "open":
          return openPRAction(ctx, args as any, bus, indexerProject);
        case "touch":
          // Translate `change` → `action` to match the original add_pr_touch
          // contract. Do NOT spread `args` — that would leak the `change` and
          // dispatch `action` fields into the response echo (which must only
          // contain pr_number/frame_id/node_name/action).
          return addPRTouchAction(
            ctx,
            {
              repo_path: args.repo_path,
              pr_number: args.pr_number as number,
              frame_id: args.frame_id as string,
              node_name: args.node_name as string,
              action: args.change as "added" | "modified",
            },
            bus,
            indexerProject,
          );
        case "merge":
          return mergePRAction(ctx, args as any, bus, indexerProject);
        case "get":
          return getPRAction(ctx, args as any, bus, indexerProject);
        default:
          // Unreachable when the action enum is exhaustive; Zod already
          // rejects unknown actions. `malformed_input` is a valid ErrorReason
          // (response.ts) — `invalid_request` is NOT.
          return errorResponse(
            "malformed_input",
            `unknown pr action '${String((args as { action?: unknown }).action)}'`,
          );
      }
    },
    { resolver },
  );

/**
 * Register the consolidated `pr` tool on an MCP server. Mirrors the
 * registration arg order of the legacy registerPRTools function
 * (server, resolver, indexerProject?, bus?).
 *
 * NOTE (Task 3.3): this module only ADDS the dispatcher. It is intentionally
 * NOT called from server.ts / the contract harness yet, and the legacy
 * single-purpose `server.tool` registrations remain in place. Wiring the
 * dispatcher in and removing the old registrations is Task 3.4.
 */
export function registerPRDispatcher(
  server: McpServer,
  resolver: RepoContextResolver,
  indexerProject?: string | null,
  bus?: EventBus,
): void {
  server.tool(
    "pr",
    "Pull requests: open/touch/merge/get. " +
      "Pass `action` plus that action's fields. " +
      "For touch, use `change`: added|modified (the old inner `action` field, renamed to free the dispatch key). " +
      "See docs/mcp-tools.md for per-action params.",
    prShape,
    prHandler(resolver, bus, indexerProject),
  );
}

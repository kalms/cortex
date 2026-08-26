import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { RepoPathField } from "./shared-fields.js";
import { postToViewer, discoverViewerPort } from "./viewer-post.js";
import { StoryService } from "../../stories/service.js";
import { captureOrigin } from "../../git/origin.js";

// ---------------------------------------------------------------------------
// The consolidated `show` MCP tool.
//
// Two families of verbs behind one action-dispatched tool, mirroring the
// `decision`/`pr` dispatcher shape (decisionShape / registerDecisionDispatcher
// in decision-dispatcher.ts):
//
//  - `focus` — delivery-only spotlight (2a, unchanged): posts refs (+ an
//    optional note) to the local viewer's `/api/show-focus` HTTP endpoint.
//    Never mutates the graph or the decisions store, and never throws for an
//    unreachable viewer — "no viewer running" is a normal, expected state.
//
//  - `story` / `advance` / `get` / `list` / `close` / `delete` — durable
//    story walkthroughs (Task 9), backed by StoryService (src/stories). Each
//    storage verb constructs its own `StoryService({ db: ctx.decisionsDb })`
//    — stories need no event bus, mirroring the service's own dependency
//    shape. `advance` additionally pages a live viewer via `postToViewer`,
//    same delivery-only semantics as `focus`: an unreachable viewer is
//    reported back as text, never thrown as an error — the story itself
//    already persisted by the time `advance` posts.
// ---------------------------------------------------------------------------

const StoryStepInputSchema = z.object({
  caption: z.string().min(1).max(2000),
  refs: z.array(z.string().min(1).max(500)).max(50),
  emphasis_edges: z.array(z.tuple([z.string().min(1).max(500), z.string().min(1).max(500)])).max(20).optional(),
  layout_hint: z.enum(["network", "organic"]).optional(),
});

const showShape = {
  repo_path: RepoPathField,
  action: z
    .enum(["focus", "story", "advance", "get", "list", "close", "delete"])
    .describe(
      "focus: hold a spotlight (refs: [] clears) · story: persist a walkthrough · " +
        "advance: page the live viewer · get/list/close/delete: manage stories",
    ),
  // focus
  refs: z.array(z.string().min(1).max(500)).max(50).optional(),
  note: z.string().max(2000).optional(),
  // story
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(5000).optional(),
  steps: z.array(StoryStepInputSchema).min(1).max(20).optional(),
  links: z
    .object({ decision_ids: z.array(z.string()).max(20).optional(), pr_number: z.number().int().optional() })
    .optional(),
  closed: z.boolean().optional(), // create already-closed (explain-architecture)
  // advance / get / close / delete
  story_id: z.string().min(1).max(200).optional(),
  step: z.number().int().min(1).max(9999).optional(),
  // story
  thread: z.string().optional().describe("story: caller-supplied thread/session id for origin provenance"),
} as const;

const showSchema = z.object(showShape);
type ShowArgs = z.infer<typeof showSchema>;

function need<T>(v: T | undefined, action: string, field: string): T {
  if (v === undefined) throw new Error(`show(${action}) requires '${field}'`);
  return v;
}

/**
 * The `show` tool's dispatching switch, wrapped in a single try/catch
 * mirroring the `todo` dispatcher's idiom (todo-tools.ts): a StoryService
 * "not found" throw becomes an empty envelope, a validation throw (`need()`,
 * or StoryService's "is closed" / "out of range" / "at least one step")
 * becomes `malformed_input`, anything else is `internal_error`.
 *
 * Exported separately from {@link showHandler} (which wraps this with
 * `registerTool`'s repo_path pre-check + Zod validation) so the T-7e5b
 * default arm — genuinely unreachable through the validated Zod `action`
 * enum, same as every other consolidated dispatcher — is still exercisable
 * directly in tests by casting an invalid action past TypeScript.
 */
export async function showAction(ctx: RepoContext, args: ShowArgs) {
  try {
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
      case "story": {
        const svc = new StoryService({ db: ctx.decisionsDb });
        const created = svc.create({
          title: need(args.title, "story", "title"),
          description: args.description,
          steps: need(args.steps, "story", "steps"),
          links: args.links,
          closed: args.closed,
          // captureOrigin is called HERE, in the handler, on ctx.repoPath
          // (the checkout root) — never in the service, which stays free
          // of git dependencies.
          origin: captureOrigin(ctx.repoPath, args.thread ?? null),
        });
        const port = (await discoverViewerPort()) ?? process.env.CORTEX_VIEWER_PORT ?? "3333";
        return ok(
          JSON.stringify({
            story_id: created.id,
            step_count: created.step_count,
            status: created.status,
            viewer_url: `http://localhost:${port}/viewer?story=${created.id}`,
          }),
        );
      }
      case "advance": {
        const svc = new StoryService({ db: ctx.decisionsDb });
        const storyId = need(args.story_id, "advance", "story_id");
        const step = need(args.step, "advance", "step");
        const resolved = svc.checkAdvance(storyId, step);
        const { delivered, accepted } = await postToViewer("/api/show-advance", {
          repo_path: ctx.repoPath,
          story_id: resolved.id,
          step,
        });
        if (!delivered) {
          return ok("No viewer reachable — story persists; open it via its viewer_url");
        }
        if (!accepted) {
          return ok("Viewer rejected (different repo owns the viewer)");
        }
        return ok(`Story ${resolved.id} → step ${step}/${resolved.step_count} pushed to viewer`);
      }
      case "get": {
        const svc = new StoryService({ db: ctx.decisionsDb });
        const storyId = need(args.story_id, "get", "story_id");
        const story = svc.get(storyId);
        return story ? ok(JSON.stringify(story, null, 2)) : empty(`show(get ${storyId})`);
      }
      case "list": {
        const svc = new StoryService({ db: ctx.decisionsDb });
        const list = svc.list();
        return list.length ? ok(JSON.stringify(list, null, 2)) : empty("show(list)");
      }
      case "close": {
        const svc = new StoryService({ db: ctx.decisionsDb });
        const storyId = need(args.story_id, "close", "story_id");
        // captureOrigin is called HERE, in the handler, on ctx.repoPath (the
        // checkout root) — never in the service. Closing a story rewrites
        // last_touched_* only; origin is immutable.
        return ok(JSON.stringify(svc.close(storyId, captureOrigin(ctx.repoPath))));
      }
      case "delete": {
        const svc = new StoryService({ db: ctx.decisionsDb });
        const storyId = need(args.story_id, "delete", "story_id");
        const deleted = svc.delete(storyId);
        return deleted ? ok(`Deleted ${storyId}`) : empty(`show(delete ${storyId})`);
      }
      default:
        // T-7e5b: unreachable through the validated Zod `action` enum (same as
        // every other consolidated dispatcher — see decision-dispatcher.ts) —
        // a defensive backstop, exercised directly via showAction in tests.
        return errorResponse("malformed_input", `Unknown show action: ${(args as { action?: string }).action}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return empty(`show(${args.action} ${args.story_id ?? ""})`);
    if (/requires '|closed|out of range|at least one step/.test(msg)) return errorResponse("malformed_input", msg);
    return errorResponse("internal_error", msg);
  }
}

/**
 * The dispatching handler for the consolidated `show` tool. Registers with
 * `{ resolver }` only — no freshnessAware/briefAware, matching the decision
 * dispatcher's registration (this tool delivers spotlights and durable
 * story reads/writes, it doesn't read the code graph).
 */
export const showHandler = (resolver: RepoContextResolver) =>
  registerTool("show", showSchema, showAction, { resolver });

/**
 * Register the consolidated `show` tool on an MCP server. Mirrors
 * `registerDecisionDispatcher`'s registration shape.
 */
export function registerShowDispatcher(server: McpServer, resolver: RepoContextResolver): void {
  server.tool(
    "show",
    "Show: focus | story | advance | get | list | close | delete. Spotlights and durable " +
      "story walkthroughs in the local viewer. See docs/mcp-tools.md.",
    showShape,
    showHandler(resolver),
  );
}

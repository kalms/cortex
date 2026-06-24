import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PRService } from "../../prs/service.js";
import { DecisionService } from "../../decisions/service.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import type { EventBus } from "../../events/bus.js";

// ---------------------------------------------------------------------------
// PR tools — per-call repo routing (Phase 3 Group B-2).
//
// Audit: PR data (pull_request nodes + their touches) lives in a specific
// repo's graph DB. The merge flow also ratifies decisions in that same
// repo's decisions sidecar. Both edges of the dependency graph (PRService
// → GraphStore, DecisionService → decisionsRepo/decisionLinksRepo) are
// repo-scoped, so PR tools are unambiguously per-repo.
//
// Per-call construction: `prServiceFor(ctx)` builds a fresh PRService from
// the addressed repo's graph DB + decisions repos. PRService is stateless
// apart from its handles, so the construction cost is negligible.
// ---------------------------------------------------------------------------

const RepoPathField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "REQUIRED. Absolute path to the indexed git root this PR belongs to. " +
      "If you don't know it, call list_projects first.",
  );

const openPRShape = {
  repo_path: RepoPathField,
  title: z.string(),
  author: z.string(),
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
} as const;
const openPRSchema = z.object(openPRShape);

const addPRTouchShape = {
  repo_path: RepoPathField,
  pr_number: z.number().int(),
  frame_id: z.string(),
  node_name: z.string(),
  action: z.enum(["added", "modified"]),
} as const;
const addPRTouchSchema = z.object(addPRTouchShape);

const mergePRShape = {
  repo_path: RepoPathField,
  pr_number: z.number().int(),
} as const;
const mergePRSchema = z.object(mergePRShape);

const getPRShape = {
  repo_path: RepoPathField,
  pr_number: z.number().int(),
} as const;
const getPRSchema = z.object(getPRShape);

// ---------------------------------------------------------------------------
// Extracted action functions — one per PR operation.
//
// These are the single source of behavior for each action. Both the legacy
// per-tool `server.tool(...)` registrations below AND the consolidated `pr`
// dispatcher (pr-dispatcher.ts) delegate to these functions. Keeping the
// bodies here ensures the legacy tools remain unchanged while the dispatcher
// reuses the exact same logic with zero duplication.
// ---------------------------------------------------------------------------

/** Shared PRService factory — mirrors the per-call construction in the original. */
function makePrService(ctx: RepoContext, bus?: EventBus, indexerProject?: string | null): PRService {
  const decisions = new DecisionService({
    db: ctx.decisionsDb,
    decisions: ctx.decisionsRepo,
    links: ctx.decisionLinksRepo,
    bus,
    project_id: indexerProject ?? "",
  });
  return new PRService(ctx.store, {
    bus,
    default_actor: "system",
    project_id: indexerProject ?? "",
    decisions,
    links: ctx.decisionLinksRepo,
  });
}

export async function openPRAction(
  ctx: RepoContext,
  args: z.infer<typeof openPRSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  try {
    const { repo_path: _repoPath, ...openArgs } = args;
    const pr = makePrService(ctx, bus, indexerProject).open(openArgs);
    return ok(JSON.stringify(pr, null, 2));
  } catch (e) {
    return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
  }
}

export async function addPRTouchAction(
  ctx: RepoContext,
  args: z.infer<typeof addPRTouchSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  try {
    const { repo_path: _repoPath, ...touchArgs } = args;
    makePrService(ctx, bus, indexerProject).addTouch(touchArgs);
    return ok(JSON.stringify({ ok: true, ...touchArgs }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return empty(`add_pr_touch(#${args.pr_number})`);
    return errorResponse("internal_error", msg);
  }
}

export async function mergePRAction(
  ctx: RepoContext,
  args: z.infer<typeof mergePRSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  try {
    const result = makePrService(ctx, bus, indexerProject).merge(args.pr_number);
    return ok(JSON.stringify(result, null, 2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) return empty(`merge_pr(#${args.pr_number})`);
    return errorResponse("internal_error", msg);
  }
}

export async function getPRAction(
  ctx: RepoContext,
  args: z.infer<typeof getPRSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const pr = makePrService(ctx, bus, indexerProject).getWithRefs(args.pr_number);
  if (!pr) return empty(`get_pr(#${args.pr_number})`);
  return ok(JSON.stringify(pr, null, 2));
}

export function registerPRTools(
  server: McpServer,
  resolver: RepoContextResolver,
  indexerProject?: string | null,
  bus?: EventBus,
): void {
  server.tool(
    "open_pr",
    "Create a pull request entity in the graph.",
    openPRShape,
    registerTool(
      "open_pr",
      openPRSchema,
      async (ctx, args) => openPRAction(ctx, args, bus, indexerProject),
      { resolver },
    ),
  );

  server.tool(
    "add_pr_touch",
    "Record that a PR touches (adds or modifies) a file.",
    addPRTouchShape,
    registerTool(
      "add_pr_touch",
      addPRTouchSchema,
      async (ctx, args) => addPRTouchAction(ctx, args, bus, indexerProject),
      { resolver },
    ),
  );

  server.tool(
    "merge_pr",
    "Mark a PR merged. Ratifies any introduced decisions from proposed to active.",
    mergePRShape,
    registerTool(
      "merge_pr",
      mergePRSchema,
      async (ctx, args) => mergePRAction(ctx, args, bus, indexerProject),
      { resolver },
    ),
  );

  server.tool(
    "get_pr",
    "Fetch a PR with resolved decision refs and linked PRs.",
    getPRShape,
    registerTool(
      "get_pr",
      getPRSchema,
      async (ctx, args) => getPRAction(ctx, args, bus, indexerProject),
      { resolver },
    ),
  );
}

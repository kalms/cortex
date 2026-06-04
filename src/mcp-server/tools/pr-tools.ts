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

export function registerPRTools(
  server: McpServer,
  resolver: RepoContextResolver,
  indexerProject?: string | null,
  bus?: EventBus,
): void {
  // Build a fresh PRService anchored to the addressed repo. The service is
  // stateless apart from its handles (GraphStore + decisions repos), so this
  // is a cheap per-call construction. Mirrors decision-tools.ts's serviceFor.
  const prServiceFor = (ctx: RepoContext): PRService => {
    const decisions = new DecisionService({
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
  };

  server.tool(
    "open_pr",
    "Create a pull request entity in the graph.",
    openPRShape,
    registerTool(
      "open_pr",
      openPRSchema,
      async (ctx, args) => {
        try {
          const { repo_path: _repoPath, ...openArgs } = args;
          const pr = prServiceFor(ctx).open(openArgs);
          return ok(JSON.stringify(pr, null, 2));
        } catch (e) {
          return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
        }
      },
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
      async (ctx, args) => {
        try {
          const { repo_path: _repoPath, ...touchArgs } = args;
          prServiceFor(ctx).addTouch(touchArgs);
          return ok(JSON.stringify({ ok: true, ...touchArgs }));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/not found/i.test(msg)) return empty(`add_pr_touch(#${args.pr_number})`);
          return errorResponse("internal_error", msg);
        }
      },
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
      async (ctx, args) => {
        try {
          const result = prServiceFor(ctx).merge(args.pr_number);
          return ok(JSON.stringify(result, null, 2));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (/not found/i.test(msg)) return empty(`merge_pr(#${args.pr_number})`);
          return errorResponse("internal_error", msg);
        }
      },
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
      async (ctx, args) => {
        const pr = prServiceFor(ctx).getWithRefs(args.pr_number);
        if (!pr) return empty(`get_pr(#${args.pr_number})`);
        return ok(JSON.stringify(pr, null, 2));
      },
      { resolver },
    ),
  );
}

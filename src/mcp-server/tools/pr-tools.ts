import { z } from "zod";
import { PRService } from "../../prs/service.js";
import { DecisionService } from "../../decisions/service.js";
import { ok, empty } from "../response.js";
import { type RepoContext } from "../repo-context.js";
import type { EventBus } from "../../events/bus.js";
import { RepoPathField } from "./shared-fields.js";
import { execAction } from "./exec-action.js";

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
  return execAction(null, () => {
    const { repo_path: _repoPath, ...openArgs } = args;
    const pr = makePrService(ctx, bus, indexerProject).open(openArgs);
    return ok(JSON.stringify(pr, null, 2));
  });
}

export async function addPRTouchAction(
  ctx: RepoContext,
  args: z.infer<typeof addPRTouchSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  return execAction(`add_pr_touch(#${args.pr_number})`, () => {
    const { repo_path: _repoPath, ...touchArgs } = args;
    makePrService(ctx, bus, indexerProject).addTouch(touchArgs);
    return ok(JSON.stringify({ ok: true, ...touchArgs }));
  });
}

export async function mergePRAction(
  ctx: RepoContext,
  args: z.infer<typeof mergePRSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  return execAction(`merge_pr(#${args.pr_number})`, () => {
    const result = makePrService(ctx, bus, indexerProject).merge(args.pr_number);
    return ok(JSON.stringify(result, null, 2));
  });
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


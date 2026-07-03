import { z } from "zod";
import { DecisionService } from "../../decisions/service.js";
import { DecisionSearch } from "../../decisions/search.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { validateDecisionFields } from "./decision-input-validation.js";
import { resolveInput } from "../../shared/resolve-input.js";
import { frameCandidates } from "../../decisions/seed/frame-candidates.js";
import { type RepoContext } from "../repo-context.js";
import { freshnessForContext, attachFreshness } from "../freshness.js";
import type { EventBus } from "../../events/bus.js";
import { attachDecisionReconciliation, decisionDisplayState } from "../reconciliation-attach.js";
import { RECONCILE_ENABLED } from "../../decisions/reconciliation.js";
import { RepoPathField, AlternativeSchema, ProvenanceSchema } from "./shared-fields.js";
import { execAction } from "./exec-action.js";

// ---------------------------------------------------------------------------
// Per-call repo routing schemas
//
// Each migrated tool exports both a raw-shape constant (consumed by
// `server.tool(name, description, SHAPE, handler)` — the MCP SDK requires
// raw shapes, not z.object instances) and a paired z.object wrapping the
// same shape (consumed by `registerTool` which calls `.parse(rawArgs)`).
//
// `repo_path` comes from shared-fields.ts — see that module for why it is
// optional at the Zod layer despite being REQUIRED for routing.
// ---------------------------------------------------------------------------

const createDecisionShape = {
  repo_path: RepoPathField,
  title: z.string().describe("Short name for the decision"),
  description: z.string().describe("What was decided"),
  rationale: z.string().describe("Why this decision was made"),
  alternatives: z.array(AlternativeSchema).optional().describe("Rejected alternatives with reasons"),
  governs: z.array(z.string()).optional().describe("Node IDs or file paths this decision governs"),
  references: z.array(z.string()).optional().describe("Node IDs of external reference nodes"),
  problem: z.string().optional().describe("Narrative: what question this decision answers"),
  resolution: z.string().optional().describe("Narrative: what was decided"),
} as const;
const createDecisionSchema = z.object(createDecisionShape);

const linkDecisionShape = {
  repo_path: RepoPathField,
  decision_id: z.string().describe("Decision node ID"),
  target: z.string().describe("Target node ID or file path"),
  relation: z.enum(["GOVERNS", "REFERENCES", "RELATED_TO", "DEPENDS_ON"])
    .optional()
    .describe("Edge type (default: GOVERNS)"),
} as const;
const linkDecisionSchema = z.object(linkDecisionShape);

const searchDecisionsShape = {
  repo_path: RepoPathField,
  query: z.string().describe("Search query (FTS5 syntax)"),
  scope: z.string().optional().describe("Qualified name or file path to scope results"),
} as const;
const searchDecisionsSchema = z.object(searchDecisionsShape);

const getDecisionShape = {
  repo_path: RepoPathField,
  id: z.string().describe("Decision node ID"),
} as const;
const getDecisionSchema = z.object(getDecisionShape);

const deleteDecisionShape = {
  repo_path: RepoPathField,
  id: z.string().describe("Decision node ID"),
} as const;
const deleteDecisionSchema = z.object(deleteDecisionShape);

const updateDecisionShape = {
  repo_path: RepoPathField,
  id: z.string().describe("Decision node ID"),
  title: z.string().optional(),
  description: z.string().optional(),
  rationale: z.string().optional(),
  alternatives: z.array(AlternativeSchema).optional(),
  status: z.enum(["active", "superseded", "deprecated"]).optional(),
  superseded_by: z.string().optional().describe("ID of the superseding decision"),
  problem: z.string().nullable().optional().describe("Narrative: what question this decision answers"),
  resolution: z.string().nullable().optional().describe("Narrative: what was decided"),
  governs: z.array(z.string()).optional().describe("Full set replacement of GOVERNS targets. [] clears all."),
  references: z.array(z.string()).optional().describe("Full set replacement of REFERENCES targets. [] clears all."),
} as const;
const updateDecisionSchema = z.object(updateDecisionShape);

const supersedeDecisionShape = {
  repo_path: RepoPathField,
  old_decision_id: z.string(),
  title: z.string(),
  problem: z.string(),
  resolution: z.string(),
  rationale: z.string(),
  alternatives: z.array(AlternativeSchema).optional(),
  governs: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
} as const;
const supersedeDecisionSchema = z.object(supersedeDecisionShape);

const proposeDecisionShape = {
  repo_path: RepoPathField,
  title: z.string(),
  problem: z.string(),
  resolution: z.string(),
  rationale: z.string(),
  alternatives: z.array(AlternativeSchema).optional(),
  governs: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  pr_number: z.number().int().optional(),
  author: z.string().optional().describe("Author marker; seeded candidates use 'cortex:seed'"),
  provenance: ProvenanceSchema.optional().describe("Machine-derived source (commits/docs) for review verification"),
} as const;
const proposeDecisionSchema = z.object(proposeDecisionShape);

const whyWasThisBuiltShape = {
  repo_path: RepoPathField,
  qualified_name: z.string().describe("Qualified name, file path, or bare symbol name of the code entity"),
} as const;
const whyWasThisBuiltSchema = z.object(whyWasThisBuiltShape);

const decisionCandidatesShape = {
  repo_path: RepoPathField,
  max_candidates: z.number().int().positive().optional().describe("Cap on returned candidates (default 20)"),
} as const;
const decisionCandidatesSchema = z.object(decisionCandidatesShape);

// ---------------------------------------------------------------------------
// Extracted per-action handler logic.
//
// Each function below holds the EXACT body that the corresponding
// `server.tool(...)` registration used to inline. Both the (temporary) old
// registration in registerDecisionTools and the new `decision` dispatcher call
// these — one source of behavior. The per-call services these used to obtain
// from the `serviceFor` / `searchFor` closures are rebuilt inline here from the
// same RepoContext handles, taking `bus` / `indexerProject` as params (the
// closures used to capture them at registration time).
// ---------------------------------------------------------------------------

/** Build a per-call DecisionService anchored to the repo addressed by `ctx`. */
function serviceForCtx(
  ctx: RepoContext,
  bus?: EventBus,
  indexerProject?: string | null,
): DecisionService {
  return new DecisionService({
    db: ctx.decisionsDb,
    decisions: ctx.decisionsRepo,
    links: ctx.decisionLinksRepo,
    bus,
    project_id: indexerProject ?? "",
  });
}

/** Build a per-call DecisionSearch anchored to the repo addressed by `ctx`. */
function searchForCtx(ctx: RepoContext): DecisionSearch {
  return new DecisionSearch(ctx.decisionsRepo, ctx.decisionLinksRepo);
}

export async function createDecisionAction(
  ctx: RepoContext,
  args: z.infer<typeof createDecisionSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const bad = validateDecisionFields(args as Record<string, unknown>);
  if (bad) {
    return errorResponse(
      "malformed_input",
      `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
    );
  }
  return execAction(null, () => {
    // Strip repo_path before forwarding to the service — it's a routing
    // concern, not a decision field. The remaining args shape is the
    // legacy CreateDecisionInput contract.
    const { repo_path: _repoPath, ...createArgs } = args;
    const decision = serviceForCtx(ctx, bus, indexerProject).create(createArgs);
    return ok(JSON.stringify(decision, null, 2));
  });
}

export async function proposeDecisionAction(
  ctx: RepoContext,
  args: z.infer<typeof proposeDecisionSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const bad = validateDecisionFields(args as Record<string, unknown>);
  if (bad) {
    return errorResponse(
      "malformed_input",
      `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
    );
  }
  return execAction(null, () => {
    const { repo_path: _repoPath, ...proposeArgs } = args;
    const d = serviceForCtx(ctx, bus, indexerProject).propose(proposeArgs);
    return ok(JSON.stringify(d, null, 2));
  });
}

export async function supersedeDecisionAction(
  ctx: RepoContext,
  args: z.infer<typeof supersedeDecisionSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const bad = validateDecisionFields(args as Record<string, unknown>);
  if (bad) {
    return errorResponse(
      "malformed_input",
      `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
    );
  }
  return execAction(`supersede_decision(${args.old_decision_id})`, () => {
    const { repo_path: _repoPath, ...supersedeArgs } = args;
    const d = serviceForCtx(ctx, bus, indexerProject).supersede(supersedeArgs);
    return ok(JSON.stringify(d, null, 2));
  });
}

export async function updateDecisionAction(
  ctx: RepoContext,
  args: z.infer<typeof updateDecisionSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const bad = validateDecisionFields(args as Record<string, unknown>);
  if (bad) {
    return errorResponse(
      "malformed_input",
      `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. This usually means caller-side XML serialization leaked into the field. Re-send with the field as a plain string.`,
    );
  }
  const { repo_path: _repoPath, id, ...updates } = args;
  return execAction(`update_decision(${id})`, () => {
    const decision = serviceForCtx(ctx, bus, indexerProject).update(id, updates);
    return ok(JSON.stringify(decision, null, 2));
  });
}

export async function deleteDecisionAction(
  ctx: RepoContext,
  args: z.infer<typeof deleteDecisionSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const { id } = args;
  return execAction(`delete_decision(${id})`, () => {
    serviceForCtx(ctx, bus, indexerProject).delete(id);
    return ok(JSON.stringify({ deleted: id }));
  });
}

export async function getDecisionAction(
  ctx: RepoContext,
  args: z.infer<typeof getDecisionSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const { id } = args;
  // Per-call repo-scoped service + links — read from the repo addressed
  // by ctx.repo_path, not the server's startup-bound handles.
  const scopedService = serviceForCtx(ctx, bus, indexerProject);
  const scopedLinks = ctx.decisionLinksRepo;

  const dec = scopedService.get(id);
  if (!dec) return empty(`get_decision(${id})`);

  // Raw record carries reconciliation columns (verdict, hash, etc.) that
  // toDecision() strips. Fetch it so we can merge those into the response.
  const rawRec = ctx.decisionsRepo.get(id);

  // Compose the "with refs" shape from the sidecar links table. The legacy
  // shape included full NodeRow objects for governs/references and full
  // Decision objects for related_decisions/depends_on; in the sidecar model
  // we only have target refs (qns/paths/decision-ids/pr-numbers), so we
  // surface those as `{ target_kind, target_ref }` and let the caller
  // resolve full node info via search_graph / get_decision as needed.
  const all = scopedLinks.findByDecision(id);
  const pick = (relation: string) =>
    all
      .filter((l) => l.relation === relation)
      .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));

  // Decision-typed back-refs resolve to full Decision objects so callers
  // can read `.id`, `.title`, etc. directly (legacy contract).
  const pickDecisions = (relation: string) =>
    all
      .filter((l) => l.relation === relation && l.target_kind === "decision")
      .map((l) => scopedService.get(l.target_ref))
      .filter((d): d is NonNullable<typeof d> => d !== null);

  // PR back-refs: in the sidecar model, PR <-> decision relations live on
  // decision_links where target_kind="pr" (target_ref = PR number as string).
  const prLinks = (relation: string) =>
    all
      .filter((l) => l.relation === relation && l.target_kind === "pr")
      .map((l) => ({ pr_number: Number(l.target_ref) }));

  const withRefs = {
    ...dec,
    // Reconciliation fields — null until first judged (Task 4 onwards).
    reconciliation_verdict: rawRec?.reconciliation_verdict ?? null,
    reconciled_at: rawRec?.reconciled_at ?? null,
    reconciled_source_hash: rawRec?.reconciled_source_hash ?? null,
    reconciled_by: rawRec?.reconciled_by ?? null,
    nonconformant_nodes: rawRec?.nonconformant_nodes
      ? JSON.parse(rawRec.nonconformant_nodes)
      : null,
    reconciliation_note: rawRec?.reconciliation_note ?? null,
    display_state: rawRec ? decisionDisplayState(ctx, rawRec) : dec.status,
    governs: pick("GOVERNS"),
    references: pick("REFERENCES"),
    related_decisions: pickDecisions("DECISION_RELATED_TO"),
    depends_on: pickDecisions("DECISION_DEPENDS_ON"),
    introduced_in: prLinks("PR_INTRODUCES_DECISION")[0] ?? null,
    implemented_by: prLinks("PR_IMPLEMENTS_DECISION"),
    challenged_by: prLinks("PR_CHALLENGES_DECISION"),
    discussed_in: prLinks("PR_DISCUSSES_DECISION"),
  };
  return attachDecisionReconciliation(ctx, rawRec ? [rawRec] : [], ok(JSON.stringify(withRefs, null, 2)));
}

export async function searchDecisionsAction(
  ctx: RepoContext,
  args: z.infer<typeof searchDecisionsSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const { query, scope } = args;
  return execAction(null, () => {
    let results = serviceForCtx(ctx, bus, indexerProject).search(query);
    if (scope) {
      // Filter to decisions whose links table mentions `scope` as a governs
      // target (qn or path). This preserves the old MCP contract without
      // re-implementing the directory walk that DecisionSearch.findGoverning
      // does — `scope` here is a literal match filter.
      const governing = searchForCtx(ctx).findGoverning(scope);
      const allowed = new Set(governing.map((d) => d.id));
      results = results.filter((d) => allowed.has(d.id));
    }
    if (results.length === 0) return empty(`search_decisions(${query})`);
    const okResult = ok(JSON.stringify(results, null, 2));
    if (!RECONCILE_ENABLED()) return okResult;
    const rawForAttach = results
      .map((r) => ctx.decisionsRepo.get(r.id))
      .filter((d): d is NonNullable<typeof d> => d != null);
    return attachDecisionReconciliation(ctx, rawForAttach, okResult);
  });
}

export async function whyWasThisBuiltAction(
  ctx: RepoContext,
  args: z.infer<typeof whyWasThisBuiltSchema>,
  _bus?: EventBus,
  _indexerProject?: string | null,
) {
  const { qualified_name } = args;
  try {
    // Resolve bare names → concrete qn/path before calling findGoverning.
    // findGoverning already handles file paths and qns via its own walk;
    // the resolver fills the bare-name gap.
    //
    // Skip the resolver for inputs that already look like file paths (contain
    // '/' or end in a source extension) or qn separators ('::') — those are
    // passed directly to findGoverning for its own path/hierarchy walk.
    const SOURCE_EXT = /\.(vue|tsx?|jsx?|py|go|rs|java|cs|cpp|c|h|rb|php|swift|kt)$/;
    const looksLikeFilePath = qualified_name.includes("/") || SOURCE_EXT.test(qualified_name);
    const looksLikeQn = qualified_name.includes("::");

    let target = qualified_name;
    if (!looksLikeFilePath && !looksLikeQn) {
      // resolveInput() needs (input, project, dbPath):
      //   - project: a string used to match canonical qns of the form
      //     `<project>.<rest>`. Per the spec's `listKnownRepos()` naming
      //     convention, derive it from the absolute repo path by stripping
      //     the leading slash and replacing path separators with dashes.
      //     This is a heuristic for the dotted-qn branch (#2); other
      //     branches (file path, bare name) ignore the project arg.
      //   - dbPath: the graph DB file ('.cortex/db' under the repo). The
      //     function opens its own GraphStore on this path.
      const project = ctx.repoPath.replace(/^\//, "").replace(/\//g, "-");
      // Use the resolver's chosen store (populated .cortex/db / graph.db /
      // cache slot), not a re-derived .cortex/db that may be empty.
      const resolved = resolveInput(qualified_name, project, ctx.graphDbPath);
      if (resolved.kind === "multi") {
        const candidatesList = resolved.candidates
          .map((c, i) => `  ${i + 1}. ${c.qn}  (${c.kind}, ${c.file_path})`)
          .join("\n");
        return attachWhyFreshness(
          ctx,
          errorResponse(
            "ambiguous_input",
            `Multiple matches for '${qualified_name}'. Pick one and re-call:\n${candidatesList}`,
          ),
        );
      }
      if (resolved.kind === "single") {
        // Prefer file_path for path-walk semantics; fall back to qn.
        target = resolved.symbol.file_path || resolved.symbol.qn;
      }
      // 'none' falls through to findGoverning with the original input,
      // preserving back-compat for non-symbol inputs.
    }
    const results = searchForCtx(ctx).findGoverning(target);
    if (!results || results.length === 0) {
      return attachWhyFreshness(ctx, empty(`why_was_this_built(${qualified_name})`));
    }
    const okResult = ok(JSON.stringify(results, null, 2));
    if (!RECONCILE_ENABLED()) return attachWhyFreshness(ctx, okResult);
    const rawForAttach = results
      .map((r) => ctx.decisionsRepo.get(r.id))
      .filter((d): d is NonNullable<typeof d> => d != null);
    return attachWhyFreshness(ctx, attachDecisionReconciliation(ctx, rawForAttach, okResult));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return attachWhyFreshness(ctx, errorResponse("internal_error", msg));
  }
}

/**
 * Apply the freshness verdict to a why_was_this_built result. This is the ONLY
 * freshness-aware decision action; mirroring exactly what the registerTool
 * freshnessAware wrapper does (attach only when the result carries `content`).
 *
 * Living here — rather than in the registerTool `{ freshnessAware: true }`
 * wrapper — keeps freshness applied EXACTLY ONCE for `why` whether the call
 * arrives via the old `why_was_this_built` tool or the new `decision`
 * dispatcher, and keeps it OFF every other decision action (get_decision /
 * search_decisions were never freshness-aware). See the freshness-parity note
 * in decision-dispatcher.ts.
 */
function attachWhyFreshness<T extends { content?: Array<{ type: string; text: string }> }>(
  ctx: RepoContext,
  result: T,
): T {
  if (!result || typeof result !== "object" || !("content" in result)) return result;
  const f = freshnessForContext({ repoPath: ctx.repoPath, graphDb: ctx.graphDb, canonical: ctx.canonical });
  return attachFreshness(result as any, f) as T;
}

export async function linkDecisionAction(
  ctx: RepoContext,
  args: z.infer<typeof linkDecisionSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
) {
  const { decision_id, target, relation } = args;
  return execAction(`link_decision(${decision_id})`, () => {
    const rel = relation ?? "GOVERNS";
    const scopedService = serviceForCtx(ctx, bus, indexerProject);
    if (rel === "GOVERNS") scopedService.linkGoverns(decision_id, target);
    else if (rel === "REFERENCES") scopedService.linkReference(decision_id, target);
    else if (rel === "RELATED_TO") scopedService.linkRelatedTo(decision_id, target);
    else if (rel === "DEPENDS_ON") scopedService.linkDependsOn(decision_id, target);
    return ok(JSON.stringify({ linked: true, decision_id, target, relation: rel }));
  });
}

export async function decisionCandidatesAction(
  ctx: RepoContext,
  args: z.infer<typeof decisionCandidatesSchema>,
) {
  return execAction(null, () => {
    // frameCandidates walks `repo_path`'s git history + ADR docs. With
    // per-call routing, `ctx.repoPath` IS the repo to scan — no more
    // dbPath-to-repo-root inference required. The function is read-only:
    // it never touches the decisions DB, just spawns `git log` under
    // ctx.repoPath and reads files via the filesystem.
    const manifest = frameCandidates({
      repo_path: ctx.repoPath,
      max_candidates: args.max_candidates,
    });
    return ok(JSON.stringify(manifest, null, 2));
  });
}


/**
 * INVARIANT — resolve before use. `ctx.decisionsRepo` and `ctx.decisionLinksRepo`
 * accept CANONICAL ids only (`D-<token>`). A ref arriving from a caller may be
 * canonical, `D-<seq>`, or a bare seq. Handlers must therefore resolve through
 * `DecisionService` — `getWithRefs()` for reads, `resolveId()` when a canonical
 * id is needed for a direct repository call — and must never pass a raw caller
 * ref to a repository or links lookup. Doing so does not error: it silently
 * returns an empty/degraded record. Enforced by
 * tests/mcp-server/decision-ref-parity.test.ts.
 */
import { z } from "zod";
import { captureOrigin } from "../../git/origin.js";
import { DecisionService } from "../../decisions/service.js";
import { DecisionSearch } from "../../decisions/search.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { validateDecisionFields } from "./decision-input-validation.js";
import { resolveInput } from "../../shared/resolve-input.js";
import { frameCandidates } from "../../decisions/seed/frame-candidates.js";
import { type RepoContext, type RepoContextResolver, deriveProjectName } from "../repo-context.js";
import { freshnessForContext, attachFreshness } from "../freshness.js";
import type { EventBus } from "../../events/bus.js";
import { attachDecisionReconciliation, decisionDisplayState, governedRefs } from "../reconciliation-attach.js";
import { RECONCILE_ENABLED, hashGovernedSource } from "../../decisions/reconciliation.js";
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
  thread: z.string().optional().describe("Caller-supplied thread/session id for origin provenance"),
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
  cross_repo: z.boolean().optional()
    .describe("Fan out over every registered repo; results grouped per repo"),
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
  thread: z.string().optional().describe("Caller-supplied thread/session id for origin provenance"),
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
  base: z.string().min(1).optional()
    .describe("Git ref: scope candidates to base..HEAD (warm path, e.g. after a merge). Omit for whole-history cold start"),
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
export function serviceForCtx(
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
    // Strip repo_path (routing concern) and thread (folded into origin
    // below) before forwarding to the service — the remaining args shape is
    // the legacy CreateDecisionInput contract. captureOrigin is called HERE,
    // in the handler, on ctx.repoPath (the checkout root) — never in the
    // service, which stays free of git dependencies.
    const { repo_path: _repoPath, thread, ...createArgs } = args;
    const origin = captureOrigin(ctx.repoPath, thread ?? null);
    const decision = serviceForCtx(ctx, bus, indexerProject).create({ ...createArgs, origin });
    // basis_hash must be computed AFTER the GOVERNS links created above have
    // landed (create() writes them synchronously) — otherwise governedRefs
    // returns [] and every decision gets the same meaningless digest.
    // ctx.repoPath is the CHECKOUT root (2.0.0 two-axis split) — never the
    // canonical root. See tests/decisions/basis-anchoring.test.ts.
    const refs = governedRefs(ctx, decision.id);
    if (refs.length > 0) {
      ctx.decisionsRepo.update(decision.id, { basis_hash: hashGovernedSource(ctx.repoPath, refs) });
    }
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
    const { repo_path: _repoPath, thread, ...proposeArgs } = args;
    const origin = captureOrigin(ctx.repoPath, thread ?? null);
    const d = serviceForCtx(ctx, bus, indexerProject).propose({ ...proposeArgs, origin });
    // Same ordering + anchoring rules as createDecisionAction above:
    // propose() writes GOVERNS links synchronously before returning, and
    // ctx.repoPath is the checkout root the basis must be anchored to.
    const refs = governedRefs(ctx, d.id);
    if (refs.length > 0) {
      ctx.decisionsRepo.update(d.id, { basis_hash: hashGovernedSource(ctx.repoPath, refs) });
    }
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
  // Per-call repo-scoped service — reads the repo addressed by ctx.repo_path,
  // not the server's startup-bound handles. The service resolves the ref ONCE
  // and keys its link lookups on the resolved canonical id; this handler must
  // NOT touch ctx.decisionsRepo / ctx.decisionLinksRepo with the raw `id`,
  // which is canonical-only and silently returns empty refs for `D-<seq>`.
  const dec = serviceForCtx(ctx, bus, indexerProject).getWithRefs(id);
  if (!dec) return empty(`get_decision(${id})`);

  // Rebuild in the original key order: display_state sits between the
  // reconciliation columns and the link refs, so the emitted JSON stays
  // byte-identical to what this handler produced before.
  const {
    governs, references, related_decisions, depends_on,
    introduced_in, implemented_by, challenged_by, discussed_in,
    ...head
  } = dec;
  // Both reconciliation helpers take the RECORD shape (alternatives as raw
  // JSON), while DecisionWithRefs carries the parsed domain shape — so hand
  // them exactly the four columns they read rather than casting.
  const recView = {
    id: dec.id,
    status: dec.status,
    reconciled_source_hash: dec.reconciled_source_hash,
    reconciliation_verdict: dec.reconciliation_verdict,
  };
  const withRefs = {
    ...head,
    display_state: decisionDisplayState(ctx, recView),
    governs, references, related_decisions, depends_on,
    introduced_in, implemented_by, challenged_by, discussed_in,
  };
  return attachDecisionReconciliation(ctx, [recView], ok(JSON.stringify(withRefs, null, 2)));
}

export async function searchDecisionsAction(
  ctx: RepoContext,
  args: z.infer<typeof searchDecisionsSchema>,
  bus?: EventBus,
  indexerProject?: string | null,
  resolver?: RepoContextResolver,
) {
  const { query, scope } = args;
  if (args.cross_repo) {
    if (scope) {
      return errorResponse(
        "malformed_input",
        "scope cannot be combined with cross_repo — scope is a single-repo governs filter",
      );
    }
    return execAction(null, () =>
      crossRepoSearch(ctx, query, bus, indexerProject, resolver));
  }
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

/**
 * cross_repo search body: FTS the addressed repo, then every other repo the
 * resolver knows (pooled + master registry), grouping hits per repo. Repos
 * that fail to resolve (deleted path, not a git repo, not indexed) are
 * reported in `skipped` — a broken registry row must never fail the search.
 *
 * Deliberate limits: results stay GROUPED per repo (FTS5 rank values are not
 * comparable across databases, so no merged ranking), and reconciliation
 * attach is single-repo-only (verdict hashing walks a working tree; doing
 * that across N repos per search is not worth the read cost).
 *
 * Checkouts, not repos. The registry now carries one row per CHECKOUT — a
 * linked worktree gets its own graph index and its own row — but every
 * worktree of a repo shares ONE decisions store (repoId lives on the
 * repo-identity axis, in the committed `cortex.json`). Fanning out over rows
 * naively therefore searches the same store once per checkout and reports the
 * same decision under N different names. Two guards, one per direction:
 *   - a row that carries `worktree_of` is skipped ONLY when its canonical
 *     parent is covered elsewhere — already `seen`, or itself present among
 *     the registry's known paths. Per-worktree indexing means a repo's ONLY
 *     registered checkout can be a linked worktree (main checkout never
 *     indexed at all), so skipping every `worktree_of` row unconditionally
 *     would silently drop that repo from cross-repo search instead of just
 *     deduping it. The known-paths set is computed once, before the loop, so
 *     the skip decision does not depend on registry row iteration order (a
 *     worktree row can be seen before its canonical row);
 *   - when the ADDRESSED repo is itself a worktree, its canonical root is
 *     pre-seeded into `seen`, because the home search already covered that
 *     repo's shared store.
 */
function crossRepoSearch(
  ctx: RepoContext,
  query: string,
  bus?: EventBus,
  indexerProject?: string | null,
  resolver?: RepoContextResolver,
) {
  const repos: Array<{ repo: string; path: string; decisions: unknown[] }> = [];
  const skipped: Array<{ repo: string; path: string; reason: string }> = [];

  const seen = new Set<string>([ctx.repoPath]);
  // Addressed repo is itself a linked worktree: the home search already read
  // the repo's shared decisions store, so its canonical row must not fan out.
  if (ctx.worktreeOf) seen.add(ctx.worktreeOf);
  const home = serviceForCtx(ctx, bus, indexerProject).search(query);
  if (home.length > 0) {
    // Same naming convention as the fan-out entries (registry rows use
    // deriveProjectName too), so one repo never appears under two names.
    repos.push({ repo: deriveProjectName(ctx.repoPath), path: ctx.repoPath, decisions: home });
  }

  const knownRepos = resolver?.listKnownRepos() ?? [];
  // Precomputed up front so the worktree skip-check below is independent of
  // registry row order (a worktree row can arrive before its canonical row).
  const knownPaths = new Set(knownRepos.map((r) => r.path));

  for (const known of knownRepos) {
    if (known.worktree_of) {
      // A linked checkout of a repo whose canonical row is covered
      // elsewhere — same decisions store, so searching it again only
      // duplicates hits. "Covered elsewhere" means: already searched
      // (`seen`), or itself registered (`knownPaths`) — NOT "carries
      // worktree_of", which would drop a repo whose only registered
      // checkout is this worktree.
      if (seen.has(known.worktree_of) || knownPaths.has(known.worktree_of)) continue;
      // No row anywhere covers the canonical parent — this worktree row is
      // the sole route to this repo's shared store. Claim the parent's
      // identity in `seen` so a sibling worktree of the same (unregistered)
      // parent doesn't search the same store again.
      seen.add(known.worktree_of);
    }
    if (seen.has(known.path)) continue;
    seen.add(known.path);
    try {
      const other = resolver!.resolve(known.path);
      if (seen.has(other.repoPath) && other.repoPath !== known.path) continue; // symlink/canonical dup
      seen.add(other.repoPath);
      const hits = serviceForCtx(other, bus, indexerProject).search(query);
      if (hits.length > 0) repos.push({ repo: known.name, path: known.path, decisions: hits });
    } catch (e) {
      skipped.push({
        repo: known.name,
        path: known.path,
        reason: e instanceof Error ? e.constructor.name : String(e),
      });
    }
  }

  // Zero hits with a clean fan-out is a plain no-results; zero hits with
  // skipped repos is NOT — the caller must see that the answer is partial.
  if (repos.length === 0 && skipped.length === 0) {
    return empty(`search_decisions(${query}, cross_repo)`);
  }
  return ok(JSON.stringify({ query, repos, skipped }, null, 2));
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
    try {
      const manifest = frameCandidates({
        repo_path: ctx.repoPath,
        max_candidates: args.max_candidates,
        base: args.base,
      });
      return ok(JSON.stringify(manifest, null, 2));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("invalid base ref")) {
        return errorResponse("malformed_input", e.message);
      }
      throw e;
    }
  });
}


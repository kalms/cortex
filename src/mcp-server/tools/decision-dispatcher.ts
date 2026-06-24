import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { error as errorResponse } from "../response.js";
import type { EventBus } from "../../events/bus.js";
import {
  createDecisionAction,
  proposeDecisionAction,
  supersedeDecisionAction,
  updateDecisionAction,
  deleteDecisionAction,
  getDecisionAction,
  searchDecisionsAction,
  whyWasThisBuiltAction,
  linkDecisionAction,
  decisionCandidatesAction,
} from "./decision-tools.js";
import { promoteDecisionAction } from "./promotion-tools.js";
import { recordReconciliationAction, pendingReconciliationsAction } from "./reconciliation-tools.js";

// ---------------------------------------------------------------------------
// The consolidated `decision` MCP tool.
//
// One tool, one `action` enum, 13 actions — a behavior-preserving facade over
// the per-action handler logic extracted into decision-tools.ts /
// promotion-tools.ts / reconciliation-tools.ts. The dispatcher rebuilds NO
// services itself: every branch calls the matching extracted *Action function,
// which is the SAME function the legacy single-purpose `server.tool`
// registrations call. There is exactly one source of behavior per action.
//
// Freshness parity (CRITICAL):
//   Today ONLY why_was_this_built is freshness-aware; get_decision /
//   search_decisions / the rest are NOT. A blanket `freshnessAware: true` on
//   this tool would attach freshness to ALL decision reads → behavior change →
//   parity break. So the dispatcher registers with `{ resolver }` ONLY (no
//   freshnessAware), and freshness is applied INSIDE whyWasThisBuiltAction
//   (via its private attachWhyFreshness). The legacy `why_was_this_built`
//   registration likewise dropped `freshnessAware: true` for the same reason.
//   Net: `why` behaves identically; every other action returns exactly what it
//   did before, with no freshness penalty.
// ---------------------------------------------------------------------------

const RepoPathField = z
  .string()
  .min(1)
  .optional()
  .describe(
    "REQUIRED. Absolute path to the indexed git root this decision is about. " +
      "If you don't know it, call list_projects first.",
  );

const AlternativeSchema = z.object({
  name: z.string(),
  reason_rejected: z.string(),
});

const ProvenanceSchema = z.object({
  source: z.enum(["adr", "prose", "commits"]),
  doc_path: z.string().optional(),
  commit_shas: z.array(z.string()).optional(),
  confidence: z.enum(["high", "medium", "low"]),
});

// Superset shape — every field any of the 13 actions needs, all optional
// except `action`. Per-action required-field enforcement still happens inside
// each extracted *Action function (which receives the same validated args the
// legacy handler did), so making everything optional here only relaxes the
// SDK-level surface — it does not change handler behavior.
const decisionShape = {
  repo_path: RepoPathField,
  action: z.enum([
    "create",
    "update",
    "delete",
    "get",
    "search",
    "why",
    "candidates",
    "link",
    "promote",
    "propose",
    "supersede",
    "reconcile",
    "pending",
  ]).describe("Which decision operation to perform."),
  // create / update / supersede / propose
  id: z.string().optional().describe("Decision node ID (get/update/delete/promote)"),
  title: z.string().optional(),
  description: z.string().optional(),
  rationale: z.string().optional(),
  alternatives: z.array(AlternativeSchema).optional(),
  governs: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  problem: z.string().nullable().optional(),
  resolution: z.string().nullable().optional(),
  status: z.enum(["active", "superseded", "deprecated"]).optional(),
  superseded_by: z.string().optional(),
  old_decision_id: z.string().optional(),
  pr_number: z.number().int().optional(),
  author: z.string().optional(),
  provenance: ProvenanceSchema.optional(),
  // search
  query: z.string().optional(),
  scope: z.string().optional(),
  // why
  qualified_name: z.string().optional(),
  // candidates
  max_candidates: z.number().int().positive().optional(),
  // link
  decision_id: z.string().optional(),
  target: z.string().optional(),
  relation: z.enum(["GOVERNS", "REFERENCES", "RELATED_TO", "DEPENDS_ON"]).optional(),
  // promote
  tier: z.enum(["team", "public"]).optional(),
  // reconcile
  verdict: z.enum(["match", "partial", "drift"]).optional(),
  nonconformant: z.array(z.object({ ref: z.string(), note: z.string() })).optional(),
  note: z.string().optional(),
  // pending
  limit: z.number().int().positive().optional(),
} as const;

const decisionSchema = z.object(decisionShape);

/**
 * The dispatching handler for the consolidated `decision` tool. Registers with
 * `{ resolver }` only — NO blanket `freshnessAware` (see the freshness-parity
 * note above). Each branch hands the validated args (cast to the corresponding
 * action's arg type — the superset shape is a structural superset of every
 * per-action shape) to the matching extracted function.
 */
export const decisionHandler = (
  resolver: RepoContextResolver,
  bus?: EventBus,
  indexerProject?: string | null,
) =>
  registerTool(
    "decision",
    decisionSchema,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (ctx: RepoContext, args) => {
      switch (args.action) {
        case "create":
          return createDecisionAction(ctx, args as any, bus, indexerProject);
        case "update":
          return updateDecisionAction(ctx, args as any, bus, indexerProject);
        case "delete":
          return deleteDecisionAction(ctx, args as any, bus, indexerProject);
        case "get":
          return getDecisionAction(ctx, args as any, bus, indexerProject);
        case "search":
          return searchDecisionsAction(ctx, args as any, bus, indexerProject);
        case "why":
          return whyWasThisBuiltAction(ctx, args as any, bus, indexerProject);
        case "candidates":
          return decisionCandidatesAction(ctx, args as any);
        case "link":
          return linkDecisionAction(ctx, args as any, bus, indexerProject);
        case "promote":
          return promoteDecisionAction(ctx, args as any, bus, indexerProject);
        case "propose":
          return proposeDecisionAction(ctx, args as any, bus, indexerProject);
        case "supersede":
          return supersedeDecisionAction(ctx, args as any, bus, indexerProject);
        case "reconcile":
          return recordReconciliationAction(ctx, args as any);
        case "pending":
          return pendingReconciliationsAction(ctx, args as any);
        default:
          // Unreachable when the action enum is exhaustive; the Zod enum already
          // rejects unknown actions. `malformed_input` is a valid ErrorReason
          // (response.ts) — `invalid_request` is NOT.
          return errorResponse(
            "malformed_input",
            `unknown decision action '${String((args as { action?: unknown }).action)}'`,
          );
      }
    },
    { resolver },
  );

/**
 * Register the consolidated `decision` tool on an MCP server. Mirrors the
 * registration arg order of the legacy register* functions
 * (server, resolver, indexerProject?, bus?).
 *
 * NOTE (Task 3.2): this module only ADDS the dispatcher. It is intentionally
 * NOT called from server.ts / the contract harness yet, and the legacy
 * single-purpose `server.tool` registrations remain in place. Wiring the
 * dispatcher in and removing the old registrations is Task 3.4.
 */
export function registerDecisionDispatcher(
  server: McpServer,
  resolver: RepoContextResolver,
  indexerProject?: string | null,
  bus?: EventBus,
): void {
  server.tool(
    "decision",
    "Decisions: create/update/delete/get/search/why/candidates/link/promote/propose/supersede/reconcile/pending. " +
      "Pass `action` plus that action's fields. See docs/mcp-tools.md for per-action params.",
    decisionShape,
    decisionHandler(resolver, bus, indexerProject),
  );
}

import { z } from "zod";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ok, empty, error as errorResponse } from "../response.js";
import { captureOrigin } from "../../git/origin.js";
import { type RepoContext } from "../repo-context.js";
import { hashGovernedSource, refToFile, resolveGovernedRefs, type GovernedRef } from "../../decisions/reconciliation.js";
import { governedRefs } from "../reconciliation-attach.js";
import { serviceForCtx } from "./decision-tools.js";
import { RepoPathField } from "./shared-fields.js";

const recordReconciliationShape = {
  repo_path: RepoPathField,
  decision_id: z.string().describe("Decision id to record a verdict for"),
  verdict: z.enum(["match", "partial", "drift"]).describe("Code-alignment judgment"),
  nonconformant: z.array(z.object({ ref: z.string(), note: z.string() })).optional()
    .describe("Specific governed refs that drifted, with a short note each"),
  note: z.string().optional().describe("One-line human summary of the drift"),
} as const;
const recordReconciliationSchema = z.object(recordReconciliationShape);

const MAX_INLINE_BYTES = 16 * 1024; // per-file cap on inlined source

function inlineSource(repoPath: string, ref: GovernedRef): string {
  const rel = refToFile(ref);
  if (rel == null) return "<unresolved>";
  const abs = isAbsolute(rel) ? rel : join(repoPath, rel);
  if (!existsSync(abs)) return "<missing>";
  if (statSync(abs).isDirectory()) return "<directory>";
  const buf = readFileSync(abs);
  return buf.length > MAX_INLINE_BYTES
    ? buf.subarray(0, MAX_INLINE_BYTES).toString("utf8") + "\n…<truncated>"
    : buf.toString("utf8");
}

const pendingReconciliationsShape = {
  repo_path: RepoPathField,
  limit: z.number().int().positive().optional().describe("Max decisions to return (default 25)"),
} as const;
const pendingReconciliationsSchema = z.object(pendingReconciliationsShape);

/**
 * Extracted record_reconciliation handler logic. Holds the EXACT body the
 * `server.tool("record_reconciliation", …)` registration used to inline. Both
 * that registration and the `decision` dispatcher (action "reconcile") call
 * this — one source of behavior. Neither bus nor indexerProject is needed here;
 * reconciliation writes only the per-call repo's decisions DB.
 */
export async function recordReconciliationAction(
  ctx: RepoContext,
  args: z.infer<typeof recordReconciliationSchema>,
) {
  // Resolve the caller's ref ONCE. Everything downstream — the governed-refs
  // lookup, the reconciliation write, the response — keys on the canonical id,
  // because those paths are canonical-only and would silently miss `D-<seq>`.
  const canonicalId = serviceForCtx(ctx).resolveId(args.decision_id);
  if (!canonicalId) return empty(`record_reconciliation(${args.decision_id})`);
  const refs = governedRefs(ctx, canonicalId);
  if (refs.length === 0) {
    return errorResponse(
      "not_reconcilable",
      `Decision ${canonicalId} has no GOVERNS links — it is declarative (process-level) and cannot be reconciled against code.`,
    );
  }
  if (args.verdict === "match") {
    const unresolved = resolveGovernedRefs(ctx.repoPath, refs).filter((r) => r.state !== "resolved");
    if (unresolved.length > 0) {
      // A `match` here would freeze the <missing> sentinel into the stored hash:
      // the row would compare equal forever and go permanently quiet, even
      // though it governs code that does not exist. `partial` and `drift` stay open.
      return errorResponse(
        "not_reconcilable",
        `Cannot record 'match': ${unresolved.length} governed ref(s) do not resolve — ` +
          unresolved.map((r) => `${r.ref.target_ref} (${r.state})`).join(", ") +
          `. Use 'partial' or 'drift', or correct the decision's governs list.`,
      );
    }
  }
  const hash = hashGovernedSource(ctx.repoPath, refs);
  const nowIso = new Date().toISOString();
  // captureOrigin is called HERE, in the handler, on ctx.repoPath (the
  // checkout root) — never in the repository, which stays free of git
  // dependencies (same rule Task 3 established for the service layer).
  const origin = captureOrigin(ctx.repoPath);
  ctx.decisionsRepo.recordReconciliation(canonicalId, {
    reconciliation_verdict: args.verdict,
    reconciled_at: nowIso,
    reconciled_source_hash: hash,
    reconciled_by: process.env.CORTEX_AGENT_ID ?? "agent",
    nonconformant_nodes: args.nonconformant ? JSON.stringify(args.nonconformant) : null,
    reconciliation_note: args.note ?? null,
    reconciled_branch: origin.branch,
    reconciled_commit: origin.commit,
    last_touched_branch: origin.branch,
    last_touched_commit: origin.commit,
    last_touched_thread: origin.thread,
  });
  // Move the basis ONLY on `match`. That verdict asserts the decision's prose
  // describes the code as it stands, so the current tree legitimately becomes
  // the reference point drift is measured from. `partial` and `drift` assert
  // the opposite — re-stamping there would adopt divergent code as the new
  // baseline and silently mark the row clean, the same harm the never-backfill
  // rule prevents. (`hash` is already anchored to ctx.repoPath above.)
  if (args.verdict === "match") {
    ctx.decisionsRepo.update(canonicalId, { basis_hash: hash });
  }
  return ok(JSON.stringify({ decision_id: canonicalId, verdict: args.verdict, reconciled_at: nowIso }, null, 2));
}

/**
 * Extracted pending_reconciliations handler logic. Holds the EXACT body the
 * `server.tool("pending_reconciliations", …)` registration used to inline. Both
 * that registration and the `decision` dispatcher (action "pending") call this.
 */
export async function pendingReconciliationsAction(
  ctx: RepoContext,
  args: z.infer<typeof pendingReconciliationsSchema>,
) {
  const limit = args.limit ?? 25;
  const out: unknown[] = [];
  for (const d of ctx.decisionsRepo.list()) {
    if (out.length >= limit) break;
    if (d.status !== "active") continue;
    const refs = governedRefs(ctx, d.id);
    if (refs.length === 0) continue; // declarative — not reconcilable
    const current = hashGovernedSource(ctx.repoPath, refs);
    if (current === d.reconciled_source_hash) continue; // verdict current
    out.push({
      id: d.id,
      title: d.title,
      problem: d.problem,
      resolution: d.resolution,
      rationale: d.rationale,
      last_verdict: d.reconciliation_verdict ?? "unknown",
      governed: refs.map((r) => ({ ref: r.target_ref, source: inlineSource(ctx.repoPath, r) })),
    });
  }
  return ok(JSON.stringify({ pending: out }, null, 2));
}


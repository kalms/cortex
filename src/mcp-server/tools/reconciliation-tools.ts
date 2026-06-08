import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, empty, error as errorResponse } from "../response.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { hashGovernedSource, type GovernedRef } from "../../decisions/reconciliation.js";

const RepoPathField = z
  .string().min(1).optional()
  .describe("REQUIRED. Absolute path to the indexed git root this decision is about.");

const recordReconciliationShape = {
  repo_path: RepoPathField,
  decision_id: z.string().describe("Decision id to record a verdict for"),
  verdict: z.enum(["match", "partial", "drift"]).describe("Code-alignment judgment"),
  nonconformant: z.array(z.object({ ref: z.string(), note: z.string() })).optional()
    .describe("Specific governed refs that drifted, with a short note each"),
  note: z.string().optional().describe("One-line human summary of the drift"),
} as const;
const recordReconciliationSchema = z.object(recordReconciliationShape);

/** GOVERNS links for a decision, as GovernedRef[]. */
function governedRefs(ctx: RepoContext, decisionId: string): GovernedRef[] {
  return ctx.decisionLinksRepo
    .findByDecision(decisionId)
    .filter((l) => l.relation === "GOVERNS")
    .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
}

export function registerReconciliationTools(server: McpServer, resolver: RepoContextResolver): void {
  server.tool(
    "record_reconciliation",
    "Record a code-alignment verdict (match/partial/drift) for a decision after judging its prose against its governed source. The server recomputes the governed-source hash itself.",
    recordReconciliationShape,
    registerTool(
      "record_reconciliation",
      recordReconciliationSchema,
      async (ctx, args) => {
        const dec = ctx.decisionsRepo.get(args.decision_id);
        if (!dec) return empty(`record_reconciliation(${args.decision_id})`);
        const refs = governedRefs(ctx, args.decision_id);
        if (refs.length === 0) {
          return errorResponse(
            "not_reconcilable",
            `Decision ${args.decision_id} has no GOVERNS links — it is declarative (process-level) and cannot be reconciled against code.`,
          );
        }
        const hash = hashGovernedSource(ctx.repoPath, refs);
        const nowIso = new Date().toISOString();
        ctx.decisionsRepo.recordReconciliation(args.decision_id, {
          reconciliation_verdict: args.verdict,
          reconciled_at: nowIso,
          reconciled_source_hash: hash,
          reconciled_by: process.env.CORTEX_AGENT_ID ?? "agent",
          nonconformant_nodes: args.nonconformant ? JSON.stringify(args.nonconformant) : null,
          reconciliation_note: args.note ?? null,
        });
        return ok(JSON.stringify({ decision_id: args.decision_id, verdict: args.verdict, reconciled_at: nowIso }, null, 2));
      },
      { resolver },
    ),
  );
}

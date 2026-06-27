import type { RepoContext } from "./repo-context.js";
import { composeBriefing } from "../briefing/compose.js";
import { DecisionSearch } from "../decisions/search.js";
import { projectFromCtx } from "./tools/code-tools-shared.js";

type TextResult = { content: Array<{ type: string; text: string }>; [k: string]: unknown };

/**
 * Study-time briefing enrichment. Mirrors attachFreshness: append a note to
 * the first text block when the target is gated; otherwise return unchanged.
 * Never throws — any error degrades gracefully to the unmodified result.
 */
export function attachBriefing<T extends TextResult>(
  result: T,
  ctx: RepoContext,
  target: string | undefined,
): T {
  if (process.env.CORTEX_BRIEF === "0" || !target) return result;
  try {
    const search = new DecisionSearch(ctx.decisionsRepo, ctx.decisionLinksRepo);
    const project = projectFromCtx(ctx) ?? "";
    const b = composeBriefing(
      {
        search,
        decisions: ctx.decisionsRepo,
        store: ctx.store,
        project,
      },
      target,
      { fanoutThreshold: Number(process.env.CORTEX_BRIEF_FANOUT ?? 12) || 12 },
    );
    if (!b.gated || !b.headline) return result;
    const first = result.content?.find((c) => c.type === "text");
    if (first) first.text += `\n\n${b.headline}`;
    (result as TextResult).briefing = { gated: b.gated, escalate: b.escalate };
    return result;
  } catch {
    return result; // degrade-safe — never break a tool response
  }
}

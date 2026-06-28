import type { Briefing, BriefingDeps, Verdict } from "./types.js";
import { formatHeadline } from "./format.js";
import { blastRadius } from "./blast-radius.js";
import { displayState } from "../decisions/reconciliation.js";

const DEFAULT_FANOUT = 12;

function normalizeVerdict(v: string | null | undefined): Verdict {
  return v === "match" || v === "partial" || v === "drift" ? v : "unreconciled";
}

/** Ordering: drift (worst=0) > partial > unreconciled > match (best=3). */
const VERDICT_RANK: Record<Verdict, number> = {
  drift: 0,
  partial: 1,
  unreconciled: 2,
  match: 3,
};

export function composeBriefing(
  deps: BriefingDeps,
  target: string,
  opts?: { fanoutThreshold?: number },
): Briefing {
  const threshold = opts?.fanoutThreshold ?? DEFAULT_FANOUT;

  // 1. Filter governing decisions to active only (drop superseded/deprecated/etc).
  const activeGoverning = deps.search.findGoverning(target).filter((d) => d.status === "active");

  // 2. Among active, pick the worst-verdict decision (ties: keep earliest in list).
  let decision: { id: string; title: string; displayState: string; verdict: Verdict } | undefined;
  let worstRank = Infinity;
  for (const d of activeGoverning) {
    const rec = deps.decisions.get(d.id);
    const rawVerdict = rec?.reconciliation_verdict ?? null;
    const verdict = normalizeVerdict(rawVerdict);
    const rank = VERDICT_RANK[verdict];
    if (rank < worstRank) {
      worstRank = rank;
      decision = {
        id: d.id,
        title: d.title,
        verdict,
        displayState: displayState(d.status, rawVerdict),
      };
    }
  }

  const callerCount = blastRadius(deps.store, deps.project, target);
  const gated = Boolean(decision) || callerCount >= threshold;
  if (!gated) return { gated: false, escalate: false, headline: "" };

  const escalate = Boolean(decision) && decision!.verdict !== "match";
  const headline = formatHeadline({ target, decision, callerCount, fanoutThreshold: threshold });
  return { gated, escalate, headline };
}

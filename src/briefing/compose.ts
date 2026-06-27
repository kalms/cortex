import type { Briefing, BriefingDeps, Verdict } from "./types.js";
import { formatHeadline } from "./format.js";
import { blastRadius } from "./blast-radius.js";
import { displayState } from "../decisions/reconciliation.js";

const DEFAULT_FANOUT = 12;

function normalizeVerdict(v: string | null | undefined): Verdict {
  return v === "match" || v === "partial" || v === "drift" ? v : "unreconciled";
}

export function composeBriefing(
  deps: BriefingDeps,
  target: string,
  opts?: { fanoutThreshold?: number },
): Briefing {
  const threshold = opts?.fanoutThreshold ?? DEFAULT_FANOUT;

  const governing = deps.search.findGoverning(target);
  const top = governing[0];
  let decision: { id: string; title: string; displayState: string; verdict: Verdict } | undefined;
  if (top) {
    const rec = deps.decisions.get(top.id);
    const verdict = normalizeVerdict(rec?.reconciliation_verdict);
    decision = {
      id: top.id,
      title: top.title,
      verdict,
      displayState: displayState(top.status, rec?.reconciliation_verdict ?? null),
    };
  }

  const callerCount = blastRadius(deps.store, deps.project, target);
  const gated = Boolean(decision) || callerCount >= threshold;
  if (!gated) return { gated: false, escalate: false, headline: "" };

  const escalate = Boolean(decision) && decision!.verdict !== "match";
  const headline = formatHeadline({ target, decision, callerCount, fanoutThreshold: threshold });
  return { gated, escalate, headline };
}

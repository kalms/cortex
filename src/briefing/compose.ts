import type { Briefing, BriefingDeps, Verdict } from "./types.js";
import { formatHeadline } from "./format.js";
import { blastRadius } from "./blast-radius.js";
import { displayState, hashGovernedSource, type GovernedRef } from "../decisions/reconciliation.js";

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
  let chosenBasis: string | null = null;
  let worstRank = Infinity;
  for (const d of activeGoverning) {
    const rec = deps.decisions.get(d.id);
    const rawVerdict = rec?.reconciliation_verdict ?? null;
    const verdict = normalizeVerdict(rawVerdict);
    const rank = VERDICT_RANK[verdict];
    if (rank < worstRank) {
      worstRank = rank;
      chosenBasis = rec?.basis_hash ?? null;
      decision = {
        id: d.id,
        title: d.title,
        verdict,
        displayState: displayState(d.status, rawVerdict),
      };
    }
  }

  // 3. Basis check for the CHOSEN decision only — one bounded file read, not
  //    one per governing decision. A `match` verdict whose basis has since
  //    moved is the row that reads clean while being wrong, so this is a
  //    separate fact from the verdict, never a substitute for it.
  let basisMoved = false;
  if (decision && chosenBasis) {
    try {
      const refs: GovernedRef[] = deps.links.findByDecision(decision.id)
        .filter((l) => l.relation === "GOVERNS")
        .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
      basisMoved = refs.length > 0 && hashGovernedSource(deps.repoPath, refs) !== chosenBasis;
    } catch {
      basisMoved = false; // degrade quiet — a briefing must never break a read
    }
  }

  const callerCount = blastRadius(deps.store, deps.project, target);
  const gated = Boolean(decision) || callerCount >= threshold;
  if (!gated) return { gated: false, escalate: false, headline: "" };

  const escalate = Boolean(decision) && (decision!.verdict !== "match" || basisMoved);
  const headline = formatHeadline({ target, decision, callerCount, fanoutThreshold: threshold, basisMoved });
  return { gated, escalate, headline };
}

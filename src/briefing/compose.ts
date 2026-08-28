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

  // 2. Among active, pick the worst-verdict decision (ties: prefer one that
  //    needs re-judging, else keep earliest in list), and decide — across ALL
  //    of them, not just the chosen one — whether anything needs re-judging.
  //
  //    Checking only the chosen decision made the signal order-dependent: with
  //    two `match` decisions governing one file, the ranks tie, the first wins,
  //    and if that one's basis is current the other's moved basis is invisible
  //    at read time while the index sweep itemizes it. The governing set for a
  //    target is typically one to three rows, and refs are hashed once each via
  //    `hashFor`, so the cost is bounded in practice.
  const stalenessOn = process.env.CORTEX_STALENESS !== "0";
  const hashCache = new Map<string, string>();
  const hashFor = (refs: GovernedRef[]): string => {
    const key = refs.map((r) => `${r.target_kind}\u0000${r.target_ref}`).sort().join("\u0001");
    let h = hashCache.get(key);
    if (h === undefined) {
      h = hashGovernedSource(deps.repoPath, refs);
      hashCache.set(key, h);
    }
    return h;
  };

  let decision: { id: string; title: string; displayState: string; verdict: Verdict } | undefined;
  let worstRank = Infinity;
  let chosenNeedsRejudge = false;
  let needsRejudge = false;
  for (const d of activeGoverning) {
    const rec = deps.decisions.get(d.id);
    const rawVerdict = rec?.reconciliation_verdict ?? null;
    const verdict = normalizeVerdict(rawVerdict);
    const rank = VERDICT_RANK[verdict];

    // Does this decision's governed source differ from what it was last judged
    // against? Mirrors the sweep's rule exactly, so the read-time surface and
    // the index-time surface can never disagree about the same row:
    //   - a verdict recorded against THIS tree settles it, whatever the basis
    //     says (reconciliation moves the basis only on `match`, so an honest
    //     `drift` would otherwise re-fire forever);
    //   - otherwise a moved basis OR a verdict recorded against a different
    //     tree means it needs looking at.
    let rowNeedsRejudge = false;
    if (stalenessOn) {
      try {
        const refs: GovernedRef[] = deps.links.findByDecision(d.id)
          .filter((l) => l.relation === "GOVERNS")
          .map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
        if (refs.length > 0) {
          const current = hashFor(refs);
          const judgedAtThisTree = rec?.reconciled_source_hash != null
            && rec.reconciled_source_hash === current;
          const movedBasis = rec?.basis_hash != null && rec.basis_hash !== current;
          const staleVerdict = rec?.reconciled_source_hash != null
            && rec.reconciled_source_hash !== current;
          rowNeedsRejudge = !judgedAtThisTree && (movedBasis || staleVerdict);
        }
      } catch {
        rowNeedsRejudge = false; // degrade quiet — a briefing must never break a read
      }
    }
    if (rowNeedsRejudge) needsRejudge = true;

    // Tie-break toward the row that needs attention, so a `match` decision with
    // a current basis can never hide a `match` decision whose basis moved.
    if (rank < worstRank || (rank === worstRank && rowNeedsRejudge && !chosenNeedsRejudge)) {
      worstRank = rank;
      chosenNeedsRejudge = rowNeedsRejudge;
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

  const escalate = Boolean(decision) && (decision!.verdict !== "match" || needsRejudge);
  const headline = formatHeadline({ target, decision, callerCount, fanoutThreshold: threshold, needsRejudge });
  return { gated, escalate, headline };
}

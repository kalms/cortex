// src/frame-extraction/frame-diversity.ts
/**
 * Deterministic, stateful ambient-set selector (taxonomy step 3b — the
 * `× diversity` term). Given frames already scored by the ranker (with their
 * layer attached) and an ambient budget, returns the set of frame_ids that
 * should be ambient.
 *
 * Two phases:
 *   1. greedy fill with geometric repeat-decay + ceremony cap
 *   2. bounded coverage repair (added in a later task)
 *
 * Pure: same input + budget → same set. All tie-breaks are on the stringified
 * frame_id, matching frame-ranker.ts (spec §8.6). No I/O.
 */
import type { FrameLayer } from "./frame-kind.js";

/** One frame's input to diversity selection. */
export interface DiversityInput {
  frame_id: number;
  /** Raw ranker score (nameability × structural × kind_weight). */
  score: number;
  layer: FrameLayer;
}

/** Per-repeat multiplier: effective = score × DECAY ^ (same-layer count already selected). */
export const DIVERSITY_DECAY = 0.6;
/** At most this many `ceremony` frames may be ambient (relaxed only to fill budget). */
export const CEREMONY_CAP = 1;
/** Phase 2: promote a coverage candidate only if its score ≥ FLOOR × displaced score. */
export const PROMOTION_FLOOR = 0.5;
/** Layers whose presence the ambient set guarantees (when the repo has them).
 *  Also the canonical coverage-repair order. */
export const REQUIRED_LAYERS: readonly FrameLayer[] = ["domain", "interface", "data"];

/** Ascending tie-break on stringified frame_id (matches the ranker). */
function byIdAsc(a: DiversityInput, b: DiversityInput): number {
  return String(a.frame_id).localeCompare(String(b.frame_id));
}

export function selectAmbientByDiversity(
  frames: readonly DiversityInput[],
  budget: number,
): Set<number> {
  if (budget <= 0 || frames.length === 0) return new Set();
  if (budget >= frames.length) return new Set(frames.map((x) => x.frame_id));

  // Deterministic working order: raw score desc, then id asc.
  const byScore = [...frames].sort((a, b) => b.score - a.score || byIdAsc(a, b));

  const selected: DiversityInput[] = [];
  const counts = new Map<FrameLayer, number>();
  const used = new Set<number>();

  // Phase 1 — greedy fill with decay + ceremony cap.
  while (selected.length < budget) {
    let best: DiversityInput | null = null;
    let bestEff = -Infinity;
    for (const cand of byScore) {
      if (used.has(cand.frame_id)) continue;
      if (cand.layer === "ceremony" && (counts.get("ceremony") ?? 0) >= CEREMONY_CAP) continue;
      const k = counts.get(cand.layer) ?? 0;
      const eff = cand.score * DIVERSITY_DECAY ** k;
      if (eff > bestEff || (best !== null && eff === bestEff && byIdAsc(cand, best) < 0)) {
        bestEff = eff;
        best = cand;
      }
    }
    // Only capped ceremony candidates remain → relax the cap to fill the budget.
    if (best === null) best = byScore.find((x) => !used.has(x.frame_id)) ?? null;
    if (best === null) break;
    selected.push(best);
    used.add(best.frame_id);
    counts.set(best.layer, (counts.get(best.layer) ?? 0) + 1);
  }

  return new Set(selected.map((x) => x.frame_id));
}

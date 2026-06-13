// src/frame-extraction/frame-ranker.ts
/**
 * Deterministic, taxonomy-free frame ranker (Path 1).
 *
 * score = nameability × structural_weight
 *   nameability      = scoreLabel F1 (label-quality.ts) × genericPenalty
 *   structural_weight = sqrt(member_count)
 *
 * The ambient set is the top `ambientBudget(extracted_count)` frames by score;
 * ties break lexicographically on the (stringified) frame_id (spec §8.6).
 * Every frame is ranked; only ambient ones get rendered on the first map.
 *
 * PURE module: inputs in, ranked frames out. No I/O.
 */
import { scoreLabel, type CorpusIndex } from "./label-quality.js";
import { genericPenalty } from "./inject-frames.js";

/** Ambient set size: max(4, min(10, ceil(n × 0.7))). 0 frames → 0. */
export function ambientBudget(extractedCount: number): number {
  if (extractedCount <= 0) return 0;
  return Math.max(4, Math.min(10, Math.ceil(extractedCount * 0.7)));
}

/** Input record per extracted frame. */
export interface FrameRecord {
  frame_id: number;
  frame_label: string;
  member_paths: string[];
  /** Non-reclaimed (topical core) members. Nameability scores against these;
   *  defaults to `member_paths` when omitted. structural_weight always uses
   *  the full `member_paths`. */
  core_member_paths?: string[];
  /** Per-layer ranking multiplier (taxonomy). Omitted (≡ 1) when the
   *  kind-weight feature is off → ranking is byte-identical to pre-slice. */
  kind_weight?: number;
}

/** Explainability breakdown — kept so the viewer can answer "why is X ambient
 *  and Y not". */
export interface RankComponents {
  /** F1 × generic_penalty. */
  nameability: number;
  /** sqrt(member_count). */
  structural_weight: number;
  /** Raw label-quality F1. */
  f1: number;
  /** Fraction of label tokens that are topic-bearing. */
  generic_penalty: number;
  /** Per-layer multiplier applied to the score (1 when the feature is off). */
  kind_weight: number;
}

export interface RankedFrame {
  frame_id: number;
  frame_label: string;
  member_count: number;
  score: number;
  /** 1-based, score descending. */
  rank: number;
  ambient: boolean;
  components: RankComponents;
}

/**
 * Rank every frame by `score = nameability × structural_weight` and mark the
 * top `ambientBudget(records.length)` as ambient. Deterministic: ties on score
 * break lexicographically on the stringified frame_id (spec §8.6).
 */
export function rankFrames(records: readonly FrameRecord[], corpus: CorpusIndex): RankedFrame[] {
  const budget = ambientBudget(records.length);

  const scored = records.map((r) => {
    const labelPaths = r.core_member_paths ?? r.member_paths;
    const f1 = scoreLabel(r.frame_label, labelPaths, corpus).f1;
    const generic_penalty = genericPenalty(r.frame_label);
    const nameability = f1 * generic_penalty;
    const structural_weight = Math.sqrt(r.member_paths.length);
    const kind_weight = r.kind_weight ?? 1;
    const score = nameability * structural_weight * kind_weight;
    return {
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_count: r.member_paths.length,
      score,
      components: { nameability, structural_weight, f1, generic_penalty, kind_weight },
    };
  });

  scored.sort(
    (a, b) => b.score - a.score || String(a.frame_id).localeCompare(String(b.frame_id)),
  );

  return scored.map((s, i) => ({ ...s, rank: i + 1, ambient: i < budget }));
}

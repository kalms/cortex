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

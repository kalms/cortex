/**
 * Deterministic gravity-centroid placement for floating entities (layout slice
 * part 2). Runs AFTER the ambient force-sim; positions satellites (non-ambient
 * frames, auxiliary aggregates) relative to the FINAL ambient positions. Pure —
 * no PRNG, integer-quantized, bounded iterations. Depends only on (ambient
 * positions, ties), never on how the ambient positions were produced (the
 * layout-mode extensibility seam).
 */
import { STAGE_W, STAGE_H } from "./frame-layout.js";
import type { FramePairWeight } from "./frame-pair-rollup.js";

/** Fixed satellite frame size (px) — smaller than the ambient 110–160 band so
 *  non-ambient frames read as de-emphasized. */
export const SATELLITE_SIZE = 84;
/** Aggregate dot collision radius (px) used for frame-repulsion. */
export const AGG_RADIUS = 8;
/** Bottom gutter y for the tie-less margin fallback (inside the stage). */
const MARGIN_Y = STAGE_H - 28;
/** Iteration cap for the repulsion solve (bounded → terminates, deterministic). */
const REPEL_ITERATIONS = 24;

/** A rectangular frame box: integer center x/y, width w, and height h. */
export interface Box { x: number; y: number; w: number; h: number; }
/** A weighted anchor for centroiding. */
export interface WeightedAnchor { x: number; y: number; weight: number; }

const q = (n: number): number => Math.round(n);

/**
 * Weighted centroid of anchors; null when there are none or total weight ≤ 0.
 *
 * Floating-point accumulation proceeds in input order, so callers wanting
 * order-independent output should pass anchors in a stable (e.g. sorted) order.
 * The module's contract is same-input → same-output.
 */
export function weightedCentroid(anchors: readonly WeightedAnchor[]): { x: number; y: number } | null {
  let sw = 0, sx = 0, sy = 0;
  for (const a of anchors) {
    if (a.weight <= 0) continue;
    sw += a.weight; sx += a.x * a.weight; sy += a.y * a.weight;
  }
  if (sw <= 0) return null;
  return { x: q(sx / sw), y: q(sy / sw) };
}

/**
 * Push a point of the given square size out of any overlapping box, along the
 * axis of lesser penetration. Anchored boxes never move. Bounded + clamped.
 *
 * If the bounded loop hits the iteration cap without fully converging
 * (pathological overlapping boxes), it returns the last position clamped
 * on-stage — no error, no signal.
 */
export function repelFromBoxes(x: number, y: number, size: number, boxes: readonly Box[]): { x: number; y: number } {
  let px = x, py = y;
  const half = size / 2;
  for (let iter = 0; iter < REPEL_ITERATIONS; iter++) {
    let moved = false;
    for (const b of boxes) {
      const halfW = (b.w + size) / 2;
      const halfH = (b.h + size) / 2;
      const dx = px - b.x, dy = py - b.y;
      const ox = halfW - Math.abs(dx);
      const oy = halfH - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        if (ox < oy) px = b.x + (dx >= 0 ? halfW : -halfW); // dx===0 (center) is pushed positive (deterministic)
        // ox >= oy → push on y (equal penetration deterministically prefers the y-axis).
        else py = b.y + (dy >= 0 ? halfH : -halfH);
        moved = true;
      }
    }
    if (!moved) break;
  }
  px = Math.min(STAGE_W - half, Math.max(half, px));
  py = Math.min(STAGE_H - half, Math.max(half, py));
  return { x: q(px), y: q(py) };
}

/** Deterministic slot in the bottom gutter for tie-less entities. Slots spread
 *  evenly across the inner 10%–90% of stage width. */
export function marginSlot(index: number, total: number, size: number): { x: number; y: number } {
  const half = size / 2;
  const x = total <= 1 ? STAGE_W / 2 : STAGE_W * (0.1 + (0.8 * index) / (total - 1));
  const clampedX = Math.min(STAGE_W - half, Math.max(half, x));
  return { x: q(clampedX), y: q(MARGIN_Y) };
}

/** Position each aggregate via the edge→path→margin tie cascade, relative to the
 *  AMBIENT frame positions. Aggregates tie only to ambient frames (stable
 *  anchors). Returns aggregate id → integer center {x, y}. */
export function placeAggregates(
  aggregates: readonly { id: string; member_count: number }[],
  edgeTies: Map<string, Map<number, number>>,
  aggregateDirs: Map<string, string>,
  frameRepDirs: Map<number, string>,
  ambientPositions: readonly { id: number; x: number; y: number }[],
  ambientBoxes: readonly Box[],
): Map<string, { x: number; y: number }> {
  const ambientPos = new Map(ambientPositions.map((p) => [p.id, p]));
  const ordered = [...aggregates].sort((a, b) => a.id.localeCompare(b.id));

  const edgeCentroid = (id: string): { x: number; y: number } | null => {
    const ties = edgeTies.get(id);
    if (!ties) return null;
    const anchors: WeightedAnchor[] = [];
    for (const [fid, w] of ties) {
      const p = ambientPos.get(fid);
      if (p) anchors.push({ x: p.x, y: p.y, weight: w });
    }
    return weightedCentroid(anchors);
  };
  const pathCentroid = (id: string): { x: number; y: number } | null => {
    const host = aggregateDirs.get(id);
    if (!host) return null;
    const anchors: WeightedAnchor[] = [];
    for (const p of ambientPositions) {
      if (frameRepDirs.get(p.id) === host) anchors.push({ x: p.x, y: p.y, weight: 1 });
    }
    return weightedCentroid(anchors);
  };

  const seeds = new Map<string, { x: number; y: number } | null>();
  for (const a of ordered) seeds.set(a.id, edgeCentroid(a.id) ?? pathCentroid(a.id));
  const tieless = ordered.filter((a) => seeds.get(a.id) === null).map((a) => a.id);
  const tielessIndex = new Map(tieless.map((id, i) => [id, i]));

  const out = new Map<string, { x: number; y: number }>();
  for (const a of ordered) {
    const seed = seeds.get(a.id) ?? marginSlot(tielessIndex.get(a.id)!, tieless.length, AGG_RADIUS * 2);
    out.set(a.id, repelFromBoxes(seed.x, seed.y, AGG_RADIUS * 2, ambientBoxes));
  }
  return out;
}

/** Position each non-ambient frame at the pair-weighted centroid of the AMBIENT
 *  frames it connects to (frame-repulsion applied; margin fallback when it has
 *  no ambient partner). Returns frame_id → integer center {x, y}. Satellites are
 *  anchored only to AMBIENT frames (stable anchors) — never to each other. */
export function placeNonAmbientFrames(
  nonAmbient: readonly { frame_id: number }[],
  framePairs: readonly FramePairWeight[],
  ambientPositions: readonly { id: number; x: number; y: number }[],
  ambientBoxes: readonly Box[],
): Map<number, { x: number; y: number }> {
  const ambientPos = new Map(ambientPositions.map((p) => [p.id, p]));
  const partnersOf = new Map<number, WeightedAnchor[]>();
  for (const f of nonAmbient) partnersOf.set(f.frame_id, []);
  for (const p of framePairs) {
    for (const [self, other] of [[p.a, p.b], [p.b, p.a]] as const) {
      const bucket = partnersOf.get(self);
      const anchor = ambientPos.get(other);
      if (bucket && anchor) bucket.push({ x: anchor.x, y: anchor.y, weight: p.weight });
    }
  }
  const sorted = [...nonAmbient].map((f) => f.frame_id).sort((x, y) => x - y);
  const tieless = sorted.filter((id) => (partnersOf.get(id) ?? []).length === 0);
  const tielessIndex = new Map(tieless.map((id, i) => [id, i]));
  const out = new Map<number, { x: number; y: number }>();
  for (const id of sorted) {
    const c = weightedCentroid(partnersOf.get(id) ?? []);
    const seed = c ?? marginSlot(tielessIndex.get(id)!, tieless.length, SATELLITE_SIZE);
    out.set(id, repelFromBoxes(seed.x, seed.y, SATELLITE_SIZE, ambientBoxes));
  }
  return out;
}

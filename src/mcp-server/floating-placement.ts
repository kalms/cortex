/**
 * Deterministic gravity-centroid placement for floating entities (layout slice
 * part 2). Runs AFTER the ambient force-sim; positions satellites (non-ambient
 * frames, auxiliary aggregates) relative to the FINAL ambient positions. Pure —
 * no PRNG, integer-quantized, bounded iterations. Depends only on (ambient
 * positions, ties), never on how the ambient positions were produced (the
 * layout-mode extensibility seam).
 */
import { STAGE_W, STAGE_H } from "./frame-layout.js";

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

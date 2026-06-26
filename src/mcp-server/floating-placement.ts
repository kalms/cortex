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
/** Grid step (px) for the outward free-slot search in separateMovables. Integer
 *  offsets only → cross-platform deterministic (no trig). */
const SEARCH_STEP = 20;
/** Breathing room (px) between the furthest ambient frame corner and the cloud
 *  keep-out circle — the clearance auxiliaries are pushed beyond. */
export const CLOUD_GAP = 14;
/** Deterministic fallback rays for pushing a point that sits EXACTLY on the
 *  cloud centroid (no gravity direction). Integer components, normalized via
 *  sqrt (cross-platform deterministic — no trig). Eight compass+diagonal
 *  directions, indexed by the caller so co-incident points fan out instead of
 *  stacking on one ray. */
const FALLBACK_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
];

/** A rectangular frame box: integer center x/y, width w, and height h. */
export interface Box { x: number; y: number; w: number; h: number; }
/** A weighted anchor for centroiding. */
export interface WeightedAnchor { x: number; y: number; weight: number; }
/** The ambient cloud's keep-out circle: centroid (cx, cy) + radius r. Auxiliary
 *  items (satellites, aggregate dots) are kept OUTSIDE this circle so they ring
 *  the cloud on its outskirts instead of landing in its visual middle. */
export interface Cloud { cx: number; cy: number; r: number; }

/**
 * Keep-out circle for the ambient cloud: centroid = mean of box centers; radius
 * = the furthest box CORNER from that centroid (so the circle fully encloses
 * every ambient frame), plus CLOUD_GAP breathing room. Returns null for an
 * empty cloud. Pure + deterministic (mean + sqrt only — no trig).
 */
export function ambientCloud(boxes: readonly Box[], gap = CLOUD_GAP): Cloud | null {
  if (boxes.length === 0) return null;
  let sx = 0, sy = 0;
  for (const b of boxes) { sx += b.x; sy += b.y; }
  const cx = sx / boxes.length, cy = sy / boxes.length;
  let r = 0;
  for (const b of boxes) {
    const halfDiag = Math.hypot(b.w, b.h) / 2; // furthest corner of this box from its center
    r = Math.max(r, Math.hypot(b.x - cx, b.y - cy) + halfDiag);
  }
  return { cx, cy, r: r + gap };
}

/**
 * If a square of side `size` centered at (x, y) sits inside the cloud keep-out
 * circle, push it radially OUTWARD (away from the cloud center) along the
 * seed→outward ray until its near edge clears the circle — i.e. its center
 * reaches `cloud.r + size/2` from the centroid. Points already outside are
 * returned unchanged, so a satellite keeps the position gravity gave it whenever
 * gravity already put it on the outskirts. A point sitting EXACTLY on the
 * centroid has no gravity ray, so it uses FALLBACK_DIRS[fallbackIndex % 8] — a
 * deterministic ray that fans co-incident points apart. Pure; no PRNG, no trig.
 */
export function pushOutsideCloud(x: number, y: number, size: number, cloud: Cloud, fallbackIndex: number): { x: number; y: number } {
  const half = size / 2;
  const target = cloud.r + half; // center distance at which the box's near edge clears the circle
  const dx = x - cloud.cx, dy = y - cloud.cy;
  const dist = Math.hypot(dx, dy);
  if (dist >= target) return { x, y };
  let ux: number, uy: number;
  if (dist < 1e-9) {
    const [fx, fy] = FALLBACK_DIRS[((fallbackIndex % FALLBACK_DIRS.length) + FALLBACK_DIRS.length) % FALLBACK_DIRS.length];
    const flen = Math.hypot(fx, fy);
    ux = fx / flen; uy = fy / flen;
  } else {
    ux = dx / dist; uy = dy / dist;
  }
  return { x: cloud.cx + ux * target, y: cloud.cy + uy * target };
}

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
 *
 * NOTE: retained as a standalone single-point utility. The placement passes
 * (placeNonAmbientFrames / placeAggregates) no longer use it — they use
 * separateMovables, which also resolves satellite-vs-satellite collisions.
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

/** A movable satellite: integer center x/y + square size. `id` is opaque (carried
 *  through so the caller can re-key the result). */
export interface Movable { id: number | string; x: number; y: number; size: number; }

/** Two boxes overlap iff their centers are within the summed half-extents on
 *  BOTH axes (touching edges = not overlapping). */
function boxesOverlap(ax: number, ay: number, asz: number, b: Box): boolean {
  return Math.abs(ax - b.x) < (b.w + asz) / 2 && Math.abs(ay - b.y) < (b.h + asz) / 2;
}

/**
 * Place movable satellites so NONE overlaps a fixed (ambient) box OR another
 * movable — the hard "frames never sit on top of each other" invariant. Greedy +
 * deterministic: each satellite (in the caller's order) keeps its seed if that
 * spot is already free; otherwise it takes the nearest free spot found by
 * scanning OUTWARD from the seed in expanding integer grid rings. Already-placed
 * satellites join the occupied set, so later satellites avoid earlier ones too.
 *
 * Unlike a force-relaxation pass (which deadlocks when a seed is buried deep in a
 * dense ambient cluster — pushing a satellite off one frame drops it onto the
 * next), the outward ring scan migrates a satellite all the way to genuine free
 * space, so the invariant holds by construction whenever the stage has room. The
 * scan uses integer offsets only (no trig) → cross-platform deterministic. If no
 * free slot is found within the stage (saturated), the satellite falls back to
 * its clamped seed (best effort). Mutates + returns `movables`; no PRNG.
 *
 * Within a ring the candidate order is top→bottom→left→right, so ties resolve
 * toward −y first — a deterministic (not radially-symmetric) bias, which is fine
 * for the non-overlap invariant.
 */
export function separateMovables(movables: Movable[], fixed: readonly Box[]): Movable[] {
  const placed: Box[] = [...fixed.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))];
  const onStage = (x: number, y: number, half: number) =>
    x >= half && x <= STAGE_W - half && y >= half && y <= STAGE_H - half;
  const free = (x: number, y: number, size: number) =>
    onStage(x, y, size / 2) && !placed.some((b) => boxesOverlap(x, y, size, b));

  for (const m of movables) {
    const half = m.size / 2;
    let sx = q(Math.min(STAGE_W - half, Math.max(half, m.x)));
    let sy = q(Math.min(STAGE_H - half, Math.max(half, m.y)));
    if (!free(sx, sy, m.size)) {
      let found = false;
      // Expanding square rings around the seed; SEARCH_STEP-px grid, nearest first.
      const maxR = Math.ceil(Math.max(STAGE_W, STAGE_H) / SEARCH_STEP);
      for (let r = 1; r <= maxR && !found; r++) {
        const d = r * SEARCH_STEP;
        for (let off = -d; off <= d && !found; off += SEARCH_STEP) {
          // top & bottom edges of the ring, then left & right edges
          const cand: Array<[number, number]> = [
            [sx + off, sy - d], [sx + off, sy + d], [sx - d, sy + off], [sx + d, sy + off],
          ];
          for (const [cx, cy] of cand) {
            if (free(cx, cy, m.size)) { sx = cx; sy = cy; found = true; break; }
          }
        }
      }
      // If saturated (no free slot anywhere), keep the clamped seed (best effort).
    }
    m.x = sx; m.y = sy;
    placed.push({ x: sx, y: sy, w: m.size, h: m.size });
  }
  return movables;
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
    // sort by frameId so the weighted-centroid accumulation is insertion-order-independent (determinism).
    for (const [fid, w] of [...ties].sort((x, y) => x[0] - y[0])) {
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

  // Seed at the tie centroid (or margin), push any seed that landed inside the
  // cloud out to its outskirts, then separate the aggregate dots against the
  // ambient anchors AND each other so dots don't stack either.
  const cloud = ambientCloud(ambientBoxes);
  const movables: Movable[] = ordered.map((a, i) => {
    const raw = seeds.get(a.id) ?? marginSlot(tielessIndex.get(a.id)!, tieless.length, AGG_RADIUS * 2);
    const seed = cloud ? pushOutsideCloud(raw.x, raw.y, AGG_RADIUS * 2, cloud, i) : raw;
    return { id: a.id, x: seed.x, y: seed.y, size: AGG_RADIUS * 2 };
  });
  separateMovables(movables, ambientBoxes);
  const out = new Map<string, { x: number; y: number }>();
  for (const m of movables) out.set(m.id as string, { x: m.x, y: m.y });
  return out;
}

/** Position each non-ambient frame at the pair-weighted centroid of the AMBIENT
 *  frames it connects to (margin fallback when it has no ambient partner), then
 *  separate all satellites so none overlaps an ambient frame OR another satellite
 *  (separateMovables). Returns frame_id → integer center {x, y}. Satellites are
 *  *anchored* only to AMBIENT frames (stable anchors), but the separation pass
 *  also resolves satellite-vs-satellite collisions — co-anchored frames that
 *  share a centroid no longer stack. */
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
  // Seed at the centroid (or margin), push any seed that landed inside the cloud
  // out to its outskirts, then separate the whole satellite set against the
  // ambient anchors AND each other in one deterministic pass.
  const cloud = ambientCloud(ambientBoxes);
  const movables: Movable[] = sorted.map((id, i) => {
    const c = weightedCentroid(partnersOf.get(id) ?? []);
    const raw = c ?? marginSlot(tielessIndex.get(id)!, tieless.length, SATELLITE_SIZE);
    const seed = cloud ? pushOutsideCloud(raw.x, raw.y, SATELLITE_SIZE, cloud, i) : raw;
    return { id, x: seed.x, y: seed.y, size: SATELLITE_SIZE };
  });
  separateMovables(movables, ambientBoxes);
  const out = new Map<number, { x: number; y: number }>();
  for (const m of movables) out.set(m.id as number, { x: m.x, y: m.y });
  return out;
}

// src/mcp-server/frame-layout.ts
/**
 * Deterministic force-directed gravity layout for ambient frames (Path 1).
 *
 * Determinism (spec §B): a mulberry32 PRNG seeded from SHA-256 of the sorted
 * frame records drives both the initial scatter and d3-force's internal jiggle
 * (via `simulation.randomSource`); the sim runs a fixed 300 iterations; final
 * coordinates are quantized to integer pixels in a fixed virtual stage. Same
 * frames in → byte-identical positions out.
 *
 * PURE — no I/O.
 */
import { createHash } from "node:crypto";
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
import type { FramePairWeight } from "./frame-pair-rollup.js";

/** Fixed virtual coordinate space. The viewer normalizes by these. */
export const STAGE_W = 1000;
export const STAGE_H = 800;

export interface LayoutInputFrame {
  frame_id: number;
  frame_label: string;
  member_count: number;
  /** Effective sink ratio in [0,1] (surface 0 → substrate 1). When present on
   *  ANY frame, the vertical stratification force is applied; omitted on EVERY
   *  frame (default) → layout takes the exact pre-slice forceCenter path
   *  (byte-identical). In a stratified layout, a frame that omits `sink` is
   *  assigned 0.5 (band midpoint). */
  sink?: number;
}

/** Mulberry32 — a small, fast, fully-deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed = first 32 bits of SHA-256 over the frame records, sorted by frame_id.
 *  Record = `frame_id:member_count:frame_label` (spec §B determinism). */
export function seedFromFrames(frames: readonly LayoutInputFrame[]): number {
  const sorted = [...frames].sort((x, y) => x.frame_id - y.frame_id);
  const rec = sorted.map((f) => `${f.frame_id}:${f.member_count}:${f.frame_label}`).join("|");
  return createHash("sha256").update(rec).digest().readUInt32BE(0) >>> 0;
}

/** Frame size band (px), mapped from member_count via sqrt. */
const FRAME_MIN = 110;
const FRAME_MAX = 160;
/** Fixed iteration count — no convergence check, for cross-run determinism. */
const ITERATIONS = 300;
/** Padding added to each frame's collision radius (px). */
const COLLIDE_PAD = 10;
/** Extra collision-only ticks after the main sim to enforce non-overlap. */
const RELAX_ITERATIONS = 120;
/** Vertical band the stratification force targets (px), inside stage margins. */
const TOP_Y = STAGE_H * 0.14;     // 112
const BOTTOM_Y = STAGE_H * 0.86;  // 688
/** forceY pull strength — stratifies vertically while the pair-link force still
 *  groups connected frames horizontally. Weak enough that the link spring can
 *  override it for strongly-connected co-layer frames; strong enough to produce
 *  visible stratification within the fixed 300 ticks. */
const STRENGTH_Y = 0.18;
/** Horizontal recentre strength (stratify path only) — replaces forceCenter's
 *  vertical pull; weak so it nudges the cloud to mid-stage on x without
 *  clustering unlinked frames. */
const STRENGTH_X = 0.05;

/** Target y for a frame from its sink ratio (clamped to [0,1]). */
function yTargetFor(sink: number): number {
  const s = Math.max(0, Math.min(1, sink));
  return TOP_Y + s * (BOTTOM_Y - TOP_Y);
}

export interface PositionedFrame {
  id: number;
  name: string;
  count: number;
  /** Integer px, virtual-stage coordinates (center). */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SimNode extends SimulationNodeDatum {
  id: number;
  name: string;
  count: number;
  size: number;
  /** Normalized mass 0..1 for inertia damping. */
  mass: number;
  /** Effective sink ratio carried from the input (default 0.5). */
  sink: number;
}

/** sqrt-bounded size in the [FRAME_MIN, FRAME_MAX] band. Degenerate (all equal
 *  counts, or a single frame) → band midpoint. */
function sizeFor(count: number, minC: number, maxC: number): number {
  if (maxC <= minC) return (FRAME_MIN + FRAME_MAX) / 2;
  const t = (Math.sqrt(count) - Math.sqrt(minC)) / (Math.sqrt(maxC) - Math.sqrt(minC));
  return FRAME_MIN + t * (FRAME_MAX - FRAME_MIN);
}

/**
 * Lay out ambient frames with d3-force:
 *  - link force: attraction ∝ rolled-up frame-pair weight (heavier → closer).
 *  - charge (many-body): mutual repulsion so frames spread.
 *  - center: gentle pull to the stage center.
 *  - collide: hard non-overlap on the size-derived radius.
 *  - frame mass → inertia: per-tick velocity damping scaled by member_count.
 */
export function layoutFrames(
  frames: readonly LayoutInputFrame[],
  pairs: readonly FramePairWeight[],
): PositionedFrame[] {
  if (frames.length === 0) return [];

  const counts = frames.map((f) => f.member_count);
  const minC = Math.min(...counts);
  const maxC = Math.max(...counts);
  const seed = seedFromFrames(frames);
  const init = mulberry32(seed);

  const nodes: SimNode[] = frames.map((f) => ({
    id: f.frame_id,
    name: f.frame_label,
    count: f.member_count,
    size: sizeFor(f.member_count, minC, maxC),
    mass: maxC <= minC ? 0.5 : (f.member_count - minC) / (maxC - minC),
    sink: f.sink ?? 0.5,
    // Deterministic initial scatter around the center.
    x: STAGE_W / 2 + (init() - 0.5) * STAGE_W * 0.5,
    y: STAGE_H / 2 + (init() - 0.5) * STAGE_H * 0.5,
  }));

  const present = new Set(nodes.map((n) => n.id));
  const links = pairs
    .filter((p) => present.has(p.a) && present.has(p.b))
    .map((p) => ({ source: p.a, target: p.b, weight: p.weight }));
  const maxW = Math.max(1, ...links.map((l) => l.weight));

  // Stratify when the caller attached sink data (the CORTEX_LAYER_LAYOUT gate is
  // read at the call site, not here — this module stays layer-agnostic).
  const stratify = frames.some((f) => f.sink !== undefined);

  const sim = forceSimulation<SimNode>(nodes)
    // Inject the deterministic PRNG so d3's coincident-node jiggle is reproducible.
    .randomSource(mulberry32((seed ^ 0x9e3779b9) >>> 0))
    .force("charge", forceManyBody<SimNode>().strength(-320));

  if (stratify) {
    // Vertical axis owned by the sink force; centering becomes horizontal-only so
    // forceCenter's mean-recentering doesn't fight the vertical distribution.
    sim
      .force("x", forceX<SimNode>(STAGE_W / 2).strength(STRENGTH_X))
      .force("y", forceY<SimNode>((d) => yTargetFor(d.sink)).strength(STRENGTH_Y));
  } else {
    sim.force("center", forceCenter(STAGE_W / 2, STAGE_H / 2));
  }

  sim
    .force(
      "link",
      forceLink<SimNode, (typeof links)[number]>(links)
        .id((d) => d.id)
        // Heavier pair weight → shorter target distance, stronger spring.
        .distance((l) => 220 - 150 * (l.weight / maxW))
        .strength((l) => 0.1 + 0.8 * (l.weight / maxW)),
    )
    .force("collide", forceCollide<SimNode>((d) => d.size / 2 + COLLIDE_PAD).strength(1).iterations(4))
    .stop();

  for (let i = 0; i < ITERATIONS; i++) {
    sim.tick();
    // Frame mass → inertia: heavier frames bleed velocity faster, so they move
    // less while lighter satellites settle around them.
    for (const n of nodes) {
      const damp = 1 - 0.6 * n.mass;
      n.vx = (n.vx ?? 0) * damp;
      n.vy = (n.vy ?? 0) * damp;
    }
  }

  // Collision-relaxation tail: drop attraction + charge so the hard non-overlap
  // constraint wins where the link force was fighting it. Deterministic — no
  // randomness, fixed iteration count, collision is a pure positional solve.
  //
  // d3's forceCollide uses circular separation (Euclidean distance), which can
  // leave axis-aligned bounding boxes (AABBs) overlapping when two frames sit at
  // a diagonal (circles clear but corners still touch). We therefore run a direct
  // AABB separation pass: for each overlapping pair, push the two nodes apart
  // along the axis of lesser penetration (minimum separation vector), splitting
  // the correction 50/50. RELAX_ITERATIONS sweeps guarantee convergence for any
  // realistic frame count. The pass is purely positional and references no PRNG.
  sim.force("link", null).force("charge", null);
  for (let i = 0; i < RELAX_ITERATIONS; i++) {
    sim.tick();
    // Direct AABB separation — resolves residual rectangular overlap that the
    // circular forceCollide misses at diagonal frame positions.
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const na = nodes[a], nb = nodes[b];
        const ax = na.x ?? 0, ay = na.y ?? 0;
        const bx = nb.x ?? 0, by = nb.y ?? 0;
        const halfSumW = (na.size + nb.size) / 2;
        const halfSumH = halfSumW; // square frames
        const dx = bx - ax, dy = by - ay;
        const ox = halfSumW - Math.abs(dx); // overlap on x-axis (positive = overlap)
        const oy = halfSumH - Math.abs(dy); // overlap on y-axis (positive = overlap)
        if (ox > 0 && oy > 0) {
          // Push along the axis of lesser penetration, splitting 50/50.
          if (ox < oy) {
            const push = ox / 2 + 0.5;
            const sign = dx >= 0 ? 1 : -1;
            na.x = ax - sign * push;
            nb.x = bx + sign * push;
          } else {
            const push = oy / 2 + 0.5;
            const sign = dy >= 0 ? 1 : -1;
            na.y = ay - sign * push;
            nb.y = by + sign * push;
          }
        }
      }
    }
  }

  // Horizontal recenter (stratify path only). The stratify path replaces
  // forceCenter (which recenters the cloud's mean every tick) with a weak
  // forceX, which pulls each node toward mid-stage but does NOT recenter the
  // mean — so the equilibrium can settle off-center and read as a left/right
  // "lean". Translate every node on x so the frame bounding box is centered on
  // the stage. Deterministic (a pure positional shift), and applied ONLY when
  // stratifying so the non-stratify path stays byte-identical to pre-slice
  // output (its forceCenter already centers the cloud). Y is left to the
  // sink-driven stratification bands (symmetric about mid-stage by construction).
  if (stratify && nodes.length > 0) {
    let minX = Infinity, maxX = -Infinity;
    for (const n of nodes) {
      const h = n.size / 2;
      minX = Math.min(minX, (n.x ?? 0) - h);
      maxX = Math.max(maxX, (n.x ?? 0) + h);
    }
    const dx = STAGE_W / 2 - (minX + maxX) / 2;
    for (const n of nodes) n.x = (n.x ?? 0) + dx;
  }

  return nodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((n) => {
      const w = Math.round(n.size);
      const h = w;
      // Use ceil(w/2) as the clamp half so the bounds invariant x ± w/2 ∈
      // [0, STAGE] holds for ODD w too: with an integer center x and a
      // fractional w/2, x must stay ≤ STAGE - ceil(w/2) (and ≥ ceil(w/2)) to
      // keep both edges inside. floor(w/2) would leave a 0.5px overhang.
      const half = Math.ceil(w / 2);
      const x = Math.round(Math.min(STAGE_W - half, Math.max(half, n.x ?? STAGE_W / 2)));
      const y = Math.round(Math.min(STAGE_H - half, Math.max(half, n.y ?? STAGE_H / 2)));
      return { id: n.id, name: n.name, count: n.count, x, y, w, h };
    });
}

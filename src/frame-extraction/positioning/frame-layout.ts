// src/frame-extraction/positioning/frame-layout.ts
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

/** Reference virtual coordinate space. The viewer normalizes positions by the
 *  stage the server actually used (returned on the frame map) and rescales sizes
 *  back to THIS reference — so growing the stage is a layout-resolution decision
 *  and never changes what the viewer draws per unit of stage. */
export const STAGE_W = 1000;
export const STAGE_H = 800;

export interface Stage { w: number; h: number; }
export const REFERENCE_STAGE: Stage = { w: STAGE_W, h: STAGE_H };

/** Ratio of total frame area to stage area the layout aims for. The reference
 *  10-frame layout settles at ~0.24 and reads well, so hold occupancy there as
 *  the frame count grows rather than letting a fixed stage saturate — past ~0.5
 *  the collision solver stops finding free space and frames jam into whatever
 *  bands remain. */
const TARGET_OCCUPANCY = 0.25;

/**
 * Smallest stage holding `sizes` at TARGET_OCCUPANCY, scaled uniformly from the
 * reference stage so the aspect ratio is preserved (the viewer rescales sizes by
 * a single factor). Never smaller than the reference, so small repos keep
 * exactly today's stage and today's layout.
 *
 * PURE and deterministic: a function of the frame sizes alone — shared state, so
 * every viewer computes the same stage. Deliberately NOT viewport-derived: the
 * stage is the shared coordinate space, and keying it to the viewport would give
 * two users on different monitors different maps (spec §8.6 shared truth). The
 * viewport is handled downstream, in the viewer's fit transform.
 */
export function stageFor(sizes: readonly number[]): Stage {
  let area = 0;
  for (const s of sizes) area += s * s;
  const k = Math.max(1, Math.sqrt(area / TARGET_OCCUPANCY / (STAGE_W * STAGE_H)));
  return { w: Math.round(STAGE_W * k), h: Math.round(STAGE_H * k) };
}

export interface LayoutInputFrame {
  frame_id: number;
  frame_label: string;
  member_count: number;
  /** Explicit frame side (px). Omitted → the member-count sqrt band (the
   *  pre-change behaviour). Supplied when frame size carries emphasis rather
   *  than raw member count. */
  size?: number;
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

/** Frame size band (px), mapped from member_count via sqrt. Sized for the
 *  ambient-only layout, where the band spans ~10 frames of similar magnitude. */
const FRAME_MIN = 110;
const FRAME_MAX = 160;
/** Frame size band for the full-sim layout. Much wider than the ambient band
 *  because a whole-repo map carries the whole member-count spread (openpencil:
 *  5–74 members, ~15x) and the narrow band flattens it to visual noise — a
 *  74-member frame rendered the same as a 5-member one. The extra range is
 *  affordable because `stageFor` grows the stage with total frame area, so a
 *  wider band buys space rather than crowding. */
export const FULL_FRAME_MIN = 70;
export const FULL_FRAME_MAX = 220;
/** Fixed iteration count — no convergence check, for cross-run determinism. */
const ITERATIONS = 300;
/** Padding added to each frame's collision radius (px). */
const COLLIDE_PAD = 10;
/** Extra collision-only ticks after the main sim to enforce non-overlap. */
const RELAX_ITERATIONS = 120;
/** Vertical band the stratification force targets, as a fraction of stage
 *  height (0.14–0.86 → 112–688 on the reference stage). Fractions, not absolute
 *  px, so the bands stretch with a scaled stage instead of stranding every frame
 *  in the top sliver of a tall one. */
const TOP_FRAC = 0.14;
const BOTTOM_FRAC = 0.86;
/** forceY pull strength — stratifies vertically while the pair-link force still
 *  groups connected frames horizontally. Weak enough that the link spring can
 *  override it for strongly-connected co-layer frames; strong enough to produce
 *  visible stratification within the fixed 300 ticks. */
const STRENGTH_Y = 0.18;
/** Decision-governance spring (frame-layout-design.md force 4). The design calls
 *  it "tertiary", and a literal reading of that — strength ~0.03–0.20 — measured
 *  as pure noise on the cortex corpus (61 co-governed pairs: 31 pulled closer,
 *  30 pushed farther, mean distance −0.4%). Charge repulsion and the code-edge
 *  spring simply swamp it. These values are calibrated to move the pairs the
 *  force EXISTS for — the ones with no code edge — while staying below the code
 *  spring (0.1–0.9) so the call graph still owns the layout's primary structure. */
const GOV_STRENGTH = 0.12;
const GOV_STRENGTH_SPAN = 0.38;
const GOV_DISTANCE = 240;
const GOV_DISTANCE_SPAN = 120;
/** Horizontal recentre strength (stratify path only) — replaces forceCenter's
 *  vertical pull; weak so it nudges the cloud to mid-stage on x without
 *  clustering unlinked frames. */
const STRENGTH_X = 0.05;

/** Target y for a frame from its sink ratio (clamped to [0,1]), in the given
 *  stage's band. */
function yTargetFor(sink: number, stageH: number): number {
  const s = Math.max(0, Math.min(1, sink));
  const top = stageH * TOP_FRAC, bottom = stageH * BOTTOM_FRAC;
  return top + s * (bottom - top);
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
export function sizeFor(
  count: number, minC: number, maxC: number,
  lo: number = FRAME_MIN, hi: number = FRAME_MAX,
): number {
  if (maxC <= minC) return (lo + hi) / 2;
  const t = (Math.sqrt(count) - Math.sqrt(minC)) / (Math.sqrt(maxC) - Math.sqrt(minC));
  return lo + t * (hi - lo);
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
  stage: Stage = REFERENCE_STAGE,
  governance: readonly FramePairWeight[] = [],
): PositionedFrame[] {
  if (frames.length === 0) return [];

  const stageW = stage.w, stageH = stage.h;
  const counts = frames.map((f) => f.member_count);
  const minC = Math.min(...counts);
  const maxC = Math.max(...counts);
  const seed = seedFromFrames(frames);
  const init = mulberry32(seed);

  const nodes: SimNode[] = frames.map((f) => ({
    id: f.frame_id,
    name: f.frame_label,
    count: f.member_count,
    size: f.size ?? sizeFor(f.member_count, minC, maxC),
    mass: maxC <= minC ? 0.5 : (f.member_count - minC) / (maxC - minC),
    sink: f.sink ?? 0.5,
    // Deterministic initial scatter around the center.
    x: stageW / 2 + (init() - 0.5) * stageW * 0.5,
    y: stageH / 2 + (init() - 0.5) * stageH * 0.5,
  }));

  const present = new Set(nodes.map((n) => n.id));
  const links = pairs
    .filter((p) => present.has(p.a) && present.has(p.b))
    .map((p) => ({ source: p.a, target: p.b, weight: p.weight }));
  const maxW = Math.max(1, ...links.map((l) => l.weight));
  // Governance links get their OWN array — d3's forceLink mutates `source`/
  // `target` in place when it resolves ids, so two forces must never share one.
  const govLinks = governance
    .filter((p) => present.has(p.a) && present.has(p.b))
    .map((p) => ({ source: p.a, target: p.b, weight: p.weight }));
  const maxG = Math.max(1, ...govLinks.map((l) => l.weight));

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
      .force("x", forceX<SimNode>(stageW / 2).strength(STRENGTH_X))
      .force("y", forceY<SimNode>((d) => yTargetFor(d.sink, stageH)).strength(STRENGTH_Y));
  } else {
    sim.force("center", forceCenter(stageW / 2, stageH / 2));
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
    .force("collide", forceCollide<SimNode>((d) => d.size / 2 + COLLIDE_PAD).strength(1).iterations(4));

  // Decision-governance force (the sixth force in frame-layout-design.md's table,
  // and the last one still unimplemented): frames sharing a governing decision
  // attract. Without it, co-governed frames cluster only by accident of their
  // code edges, so a decision's pills scatter across the map and the governance
  // relation is unreadable — the wider the layout spreads, the worse it gets.
  //
  // Deliberately TERTIARY, per the design: weaker and longer than the code-edge
  // spring, so it biases placement without overriding the call graph. Inert when
  // no governance is supplied (default), keeping every existing caller
  // byte-identical.
  if (govLinks.length > 0) {
    sim.force(
      "governance",
      forceLink<SimNode, (typeof govLinks)[number]>(govLinks)
        .id((d) => d.id)
        .distance((l) => GOV_DISTANCE - GOV_DISTANCE_SPAN * (l.weight / maxG))
        .strength((l) => GOV_STRENGTH + GOV_STRENGTH_SPAN * (l.weight / maxG)),
    );
  }

  sim.stop();

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
  sim.force("link", null).force("charge", null).force("governance", null);
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

  // Recenter on BOTH axes (stratify path only) — D-vmhy. The stratify path
  // replaces forceCenter (which recenters the cloud's mean every tick) with a
  // weak forceX plus a sink-targeted forceY. Neither pins the MEAN, so the
  // link/charge equilibrium drifts the whole cloud off-center on both axes: a
  // left/right lean on x, and on y a drift that tracks link structure rather
  // than the layer mix. Translate every node so the frame bounding box is
  // centered on the stage. Deterministic (a pure positional shift), and applied
  // ONLY when stratifying so the non-stratify path stays byte-identical to
  // pre-slice output (its forceCenter already centers the cloud).
  //
  // The y half closes T-whyh: D-vmhy was corrected to recenter both axes after
  // private-monorepo (surface-heavy yet leaning DOWN) disproved the earlier claim
  // that the sink bands leave y "symmetric by construction". A uniform translate
  // preserves the relative top→bottom depth ordering; only the absolute vertical
  // offset is lost, and that signal is already dominated by the link springs.
  if (stratify && nodes.length > 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const h = n.size / 2;
      minX = Math.min(minX, (n.x ?? 0) - h);
      maxX = Math.max(maxX, (n.x ?? 0) + h);
      minY = Math.min(minY, (n.y ?? 0) - h);
      maxY = Math.max(maxY, (n.y ?? 0) + h);
    }
    const dx = stageW / 2 - (minX + maxX) / 2;
    const dy = stageH / 2 - (minY + maxY) / 2;
    for (const n of nodes) { n.x = (n.x ?? 0) + dx; n.y = (n.y ?? 0) + dy; }
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
      const x = Math.round(Math.min(stageW - half, Math.max(half, n.x ?? stageW / 2)));
      const y = Math.round(Math.min(stageH - half, Math.max(half, n.y ?? stageH / 2)));
      return { id: n.id, name: n.name, count: n.count, x, y, w, h };
    });
}

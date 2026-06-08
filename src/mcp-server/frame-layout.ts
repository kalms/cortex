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
    // Deterministic initial scatter around the center.
    x: STAGE_W / 2 + (init() - 0.5) * STAGE_W * 0.5,
    y: STAGE_H / 2 + (init() - 0.5) * STAGE_H * 0.5,
  }));

  const present = new Set(nodes.map((n) => n.id));
  const links = pairs
    .filter((p) => present.has(p.a) && present.has(p.b))
    .map((p) => ({ source: p.a, target: p.b, weight: p.weight }));
  const maxW = Math.max(1, ...links.map((l) => l.weight));

  const sim = forceSimulation<SimNode>(nodes)
    // Inject the deterministic PRNG so d3's coincident-node jiggle is reproducible.
    .randomSource(mulberry32((seed ^ 0x9e3779b9) >>> 0))
    .force("charge", forceManyBody<SimNode>().strength(-320))
    .force("center", forceCenter(STAGE_W / 2, STAGE_H / 2))
    .force(
      "link",
      forceLink<SimNode, (typeof links)[number]>(links)
        .id((d) => d.id)
        // Heavier pair weight → shorter target distance, stronger spring.
        .distance((l) => 220 - 150 * (l.weight / maxW))
        .strength((l) => 0.1 + 0.8 * (l.weight / maxW)),
    )
    .force("collide", forceCollide<SimNode>((d) => d.size / 2 + COLLIDE_PAD).strength(1))
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

  return nodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((n) => {
      const w = Math.round(n.size);
      const h = w;
      const half = Math.floor(w / 2);
      const x = Math.round(Math.min(STAGE_W - half, Math.max(half, n.x ?? STAGE_W / 2)));
      const y = Math.round(Math.min(STAGE_H - half, Math.max(half, n.y ?? STAGE_H / 2)));
      return { id: n.id, name: n.name, count: n.count, x, y, w, h };
    });
}

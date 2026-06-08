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

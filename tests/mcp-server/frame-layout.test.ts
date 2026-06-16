import { describe, it, expect } from "vitest";
import { mulberry32, seedFromFrames, layoutFrames, STAGE_W, STAGE_H, type LayoutInputFrame } from "../../src/mcp-server/frame-layout.js";
import type { FramePairWeight } from "../../src/mcp-server/frame-pair-rollup.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces values in [0, 1)", () => {
    const r = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("seedFromFrames", () => {
  const frames: LayoutInputFrame[] = [
    { frame_id: 2, frame_label: "viewer", member_count: 3 },
    { frame_id: 0, frame_label: "checkout", member_count: 2 },
  ];

  it("is order-independent (sorts by frame_id before hashing)", () => {
    const reversed = [...frames].reverse();
    expect(seedFromFrames(frames)).toBe(seedFromFrames(reversed));
  });

  it("changes when a frame's label or count changes", () => {
    const base = seedFromFrames(frames);
    const mutated = seedFromFrames([{ ...frames[0], member_count: 99 }, frames[1]]);
    expect(mutated).not.toBe(base);
  });

  it("returns an unsigned 32-bit integer", () => {
    const s = seedFromFrames(frames);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("layoutFrames", () => {
  const frames: LayoutInputFrame[] = [
    { frame_id: 0, frame_label: "checkout", member_count: 30 },
    { frame_id: 1, frame_label: "viewer", member_count: 10 },
    { frame_id: 2, frame_label: "graph", member_count: 5 },
  ];
  const pairs: FramePairWeight[] = [{ a: 0, b: 1, weight: 12 }];

  it("returns one positioned frame per input", () => {
    const out = layoutFrames(frames, pairs);
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.id).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("preserves id, name, and count", () => {
    const out = layoutFrames(frames, pairs);
    const checkout = out.find((f) => f.id === 0)!;
    expect(checkout.name).toBe("checkout");
    expect(checkout.count).toBe(30);
  });

  it("emits integer-pixel coordinates", () => {
    for (const f of layoutFrames(frames, pairs)) {
      expect(Number.isInteger(f.x)).toBe(true);
      expect(Number.isInteger(f.y)).toBe(true);
      expect(Number.isInteger(f.w)).toBe(true);
      expect(Number.isInteger(f.h)).toBe(true);
    }
  });

  it("sizes frames within the 110–160px band", () => {
    for (const f of layoutFrames(frames, pairs)) {
      expect(f.w).toBeGreaterThanOrEqual(110);
      expect(f.w).toBeLessThanOrEqual(160);
      expect(f.w).toBe(f.h); // square frames
    }
    // The 30-member frame should be at least as large as the 5-member one.
    const out = layoutFrames(frames, pairs);
    const big = out.find((f) => f.id === 0)!;
    const small = out.find((f) => f.id === 2)!;
    expect(big.w).toBeGreaterThanOrEqual(small.w);
  });

  it("keeps frame centers within the virtual stage", () => {
    for (const f of layoutFrames(frames, pairs)) {
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w / 2).toBeLessThanOrEqual(STAGE_W);
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(0);
      expect(f.y + f.h / 2).toBeLessThanOrEqual(STAGE_H);
    }
  });

  it("is byte-identical across repeated runs (determinism)", () => {
    expect(layoutFrames(frames, pairs)).toEqual(layoutFrames(frames, pairs));
  });

  it("returns [] for empty input", () => {
    expect(layoutFrames([], [])).toEqual([]);
  });

  it("handles a single frame", () => {
    const [only] = layoutFrames([frames[0]], []);
    expect(only.id).toBe(0);
    expect(only.x).toBeGreaterThan(0);
    expect(only.y).toBeGreaterThan(0);
  });

  it("ignores pairs referencing frames not in the input set", () => {
    // pair references frame 99 which isn't laid out — must not throw
    const out = layoutFrames(frames, [{ a: 0, b: 99, weight: 5 }]);
    expect(out).toHaveLength(3);
  });

  it("keeps odd-sized frames within bounds (sub-pixel clamp regression)", () => {
    // Two frames with different counts → sizes span the band and can be odd.
    // Many strongly-weighted frames push some to the stage edges; assert the
    // bounds invariant holds with real (non-integer) half-widths.
    const odd: LayoutInputFrame[] = Array.from({ length: 8 }, (_, i) => ({
      frame_id: i,
      frame_label: `f${i}`,
      member_count: 1 + i * 3, // varied counts → varied (incl. odd) sizes
    }));
    const heavyPairs: FramePairWeight[] = odd.slice(1).map((f) => ({ a: 0, b: f.frame_id, weight: 50 }));
    for (const f of layoutFrames(odd, heavyPairs)) {
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w / 2).toBeLessThanOrEqual(STAGE_W);
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(0);
      expect(f.y + f.h / 2).toBeLessThanOrEqual(STAGE_H);
    }
  });

  it("produces non-overlapping ambient frames even under strong attraction", () => {
    // Many frames all strongly pulled toward frame 0 — the case that overlapped
    // before the collision-relaxation tail.
    const many: LayoutInputFrame[] = Array.from({ length: 8 }, (_, i) => ({
      frame_id: i,
      frame_label: `f${i}`,
      member_count: 5 + (i % 4) * 8,
    }));
    const pulls: FramePairWeight[] = many.slice(1).map((f) => ({ a: 0, b: f.frame_id, weight: 80 }));
    const out = layoutFrames(many, pulls);
    // No two frame axis-aligned bounding boxes (AABB) overlap.
    // AABB non-overlap is the precise definition for axis-aligned squares and
    // is more correct than center-distance alone (which can reject valid diagonal
    // packing). Two AABBs overlap iff they overlap on BOTH axes simultaneously.
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
        const overlapX = dx < (a.w + b.w) / 2 - 1;
        const overlapY = dy < (a.h + b.h) / 2 - 1;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });
});

describe("layoutFrames — vertical stratification (layer-adjacency force)", () => {
  // The exact output of the PRE-CHANGE layoutFrames on this fixture (captured via
  // the tsx one-liner). The flag-off path (no `sink`) must reproduce it byte-for-byte.
  const GOLD_FRAMES = [
    { frame_id: 0, frame_label: "checkout", member_count: 30 },
    { frame_id: 1, frame_label: "viewer", member_count: 10 },
    { frame_id: 2, frame_label: "graph", member_count: 5 },
  ];
  const GOLD_PAIRS = [{ a: 0, b: 1, weight: 12 }];
  const GOLDEN = [{"id":0,"name":"checkout","count":30,"x":612,"y":377,"w":160,"h":160},{"id":1,"name":"viewer","count":10,"x":634,"y":216,"w":124,"h":124},{"id":2,"name":"graph","count":5,"x":254,"y":606,"w":110,"h":110}];

  it("is byte-identical to pre-slice output when no frame carries a sink (inert guard)", () => {
    expect(layoutFrames(GOLD_FRAMES, GOLD_PAIRS)).toEqual(GOLDEN);
  });

  const stratFrames: LayoutInputFrame[] = [
    { frame_id: 0, frame_label: "surface", member_count: 10, sink: 0.0 },
    { frame_id: 1, frame_label: "substrate", member_count: 10, sink: 1.0 },
  ];

  it("places a low-sink (source) frame above a high-sink (substrate) frame", () => {
    const out = layoutFrames(stratFrames, []);
    const surface = out.find((f) => f.id === 0)!;
    const substrate = out.find((f) => f.id === 1)!;
    expect(surface.y).toBeLessThan(substrate.y);
  });

  it("is deterministic with the sink force on (byte-identical across runs)", () => {
    expect(layoutFrames(stratFrames, [])).toEqual(layoutFrames(stratFrames, []));
  });

  it("keeps stratified frames within the virtual stage", () => {
    for (const f of layoutFrames(stratFrames, [])) {
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w / 2).toBeLessThanOrEqual(STAGE_W);
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(0);
      expect(f.y + f.h / 2).toBeLessThanOrEqual(STAGE_H);
    }
  });

  it("in a mixed-sink layout, a sink=0 frame sits above a sinkless (→0.5 mid-band) frame", () => {
    // Stratify fires because one frame carries sink; the sinkless frame defaults
    // to 0.5 (band midpoint), so the sink=0 (surface) frame lands above it.
    const mixed: LayoutInputFrame[] = [
      { frame_id: 0, frame_label: "surface", member_count: 10, sink: 0.0 },
      { frame_id: 1, frame_label: "unclassified", member_count: 10 }, // no sink → 0.5
    ];
    const out = layoutFrames(mixed, []);
    const surface = out.find((f) => f.id === 0)!;
    const mid = out.find((f) => f.id === 1)!;
    expect(surface.y).toBeLessThan(mid.y);
  });
});

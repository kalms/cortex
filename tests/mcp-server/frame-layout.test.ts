import { describe, it, expect } from "vitest";
import { mulberry32, seedFromFrames, layoutFrames, stageFor, STAGE_W, STAGE_H, type LayoutInputFrame } from "../../src/frame-extraction/positioning/frame-layout.js";
import type { FramePairWeight } from "../../src/frame-extraction/positioning/frame-pair-rollup.js";

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

  it("horizontally centers the cloud in the stratify path (no left/right lean)", () => {
    // The stratify path's weak forceX doesn't recenter the cloud's mean, so the
    // equilibrium can settle off-center. A post-layout recenter must put the
    // frame bounding box's horizontal center on the stage center for any seed.
    const leany: LayoutInputFrame[] = [
      { frame_id: 0, frame_label: "interface", member_count: 8, sink: 0.1 },
      { frame_id: 1, frame_label: "orchestration", member_count: 12, sink: 0.3 },
      { frame_id: 2, frame_label: "domain", member_count: 20, sink: 0.5 },
      { frame_id: 3, frame_label: "data", member_count: 6, sink: 0.7 },
      { frame_id: 4, frame_label: "infra", member_count: 30, sink: 0.9 },
    ];
    const pairs = [
      { a: 0, b: 1, weight: 9 },
      { a: 1, b: 2, weight: 5 },
      { a: 2, b: 4, weight: 7 },
    ];
    const out = layoutFrames(leany, pairs);
    const minX = Math.min(...out.map((f) => f.x - f.w / 2));
    const maxX = Math.max(...out.map((f) => f.x + f.w / 2));
    const bboxCenterX = (minX + maxX) / 2;
    // Allow 1px slack for integer quantization.
    expect(Math.abs(bboxCenterX - STAGE_W / 2)).toBeLessThanOrEqual(1);
  });
});

describe("stageFor — count-scaled stage", () => {
  const sizes = (n: number, side: number) => Array.from({ length: n }, () => side);

  it("clamps to the reference stage for a small frame set", () => {
    // 10 x 135px frames ≈ 182k px² against 800k — well under target occupancy,
    // so a small repo keeps exactly today's stage (and today's layout).
    expect(stageFor(sizes(10, 135))).toEqual({ w: STAGE_W, h: STAGE_H });
  });

  it("never returns less than the reference stage", () => {
    expect(stageFor([])).toEqual({ w: STAGE_W, h: STAGE_H });
    expect(stageFor([10])).toEqual({ w: STAGE_W, h: STAGE_H });
  });

  it("grows so occupancy lands at the target once the reference saturates", () => {
    const many = sizes(120, 90);
    const stage = stageFor(many);
    const area = many.reduce((s, x) => s + x * x, 0);
    expect(stage.w).toBeGreaterThan(STAGE_W);
    expect(area / (stage.w * stage.h)).toBeCloseTo(0.25, 2);
  });

  it("preserves the reference aspect ratio, so sizes rescale by one factor", () => {
    const stage = stageFor(sizes(200, 100));
    expect(stage.w / stage.h).toBeCloseTo(STAGE_W / STAGE_H, 2);
  });

  it("scales with total AREA, not frame count", () => {
    // Four 50px frames occupy the same area as one 100px frame.
    expect(stageFor(sizes(4, 50))).toEqual(stageFor([100]));
  });

  it("is deterministic and order-independent (shared state → same stage)", () => {
    const a = [110, 160, 84, 84, 130];
    expect(stageFor(a)).toEqual(stageFor([...a].reverse()));
  });
});

describe("layoutFrames — scaled stage + explicit sizes", () => {
  const mk = (n: number): LayoutInputFrame[] =>
    Array.from({ length: n }, (_, i) => ({
      frame_id: i, frame_label: `f${i}`, member_count: 5 + (i % 7),
      size: i % 4 === 0 ? 140 : 84, sink: (i % 10) / 10,
    }));

  it("honours an explicit per-frame size over the member-count band", () => {
    const out = layoutFrames(mk(8), [], stageFor(mk(8).map((f) => f.size!)));
    for (const f of out) expect([140, 84]).toContain(f.w);
  });

  it("keeps every frame inside the scaled stage", () => {
    const frames = mk(120);
    const stage = stageFor(frames.map((f) => f.size!));
    for (const f of layoutFrames(frames, [], stage)) {
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(0);
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w / 2).toBeLessThanOrEqual(stage.w);
      expect(f.y + f.h / 2).toBeLessThanOrEqual(stage.h);
    }
  });

  it("separates 120 frames on a scaled stage (sub-px rounding slack only)", () => {
    const frames = mk(120);
    const out = layoutFrames(frames, [], stageFor(frames.map((f) => f.size!)));
    for (let a = 0; a < out.length; a++) {
      for (let b = a + 1; b < out.length; b++) {
        const ox = (out[a].w + out[b].w) / 2 - Math.abs(out[a].x - out[b].x);
        const oy = (out[a].h + out[b].h) / 2 - Math.abs(out[a].y - out[b].y);
        // Integer centers against possibly-odd widths leave at most 1px; the
        // hard invariant is that nothing genuinely stacks.
        expect(Math.min(ox, oy)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("gives every frame a distinct position (no 1-D collapse)", () => {
    const frames = mk(120);
    const out = layoutFrames(frames, [], stageFor(frames.map((f) => f.size!)));
    expect(new Set(out.map((f) => `${f.x},${f.y}`)).size).toBe(out.length);
  });

  it("is deterministic on a scaled stage", () => {
    const frames = mk(60);
    const stage = stageFor(frames.map((f) => f.size!));
    expect(layoutFrames(frames, [], stage)).toEqual(layoutFrames(frames, [], stage));
  });

  it("centers the cloud on BOTH axes in the stratify path (D-vmhy)", () => {
    const frames = mk(40);
    const stage = stageFor(frames.map((f) => f.size!));
    const out = layoutFrames(frames, [], stage);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of out) {
      minX = Math.min(minX, f.x - f.w / 2); maxX = Math.max(maxX, f.x + f.w / 2);
      minY = Math.min(minY, f.y - f.h / 2); maxY = Math.max(maxY, f.y + f.h / 2);
    }
    expect(Math.abs((minX + maxX) / 2 - stage.w / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs((minY + maxY) / 2 - stage.h / 2)).toBeLessThanOrEqual(1);
  });
});

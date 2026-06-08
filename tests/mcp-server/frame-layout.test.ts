import { describe, it, expect } from "vitest";
import { mulberry32, seedFromFrames, type LayoutInputFrame } from "../../src/mcp-server/frame-layout.js";

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

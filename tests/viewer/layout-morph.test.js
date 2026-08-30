import { describe, it, expect } from "vitest";
import {
  LAYOUT_MORPH_DURATION, captureGeometry, geometryChanged, beginMorph,
  morphProgress, morphActive, morphGeom,
} from "../../src/viewer/canvas/layout-morph.js";

const linear = (t) => t;
const frame = (id, x, y, w = 100, h = 100) => ({ id, x, y, w, h });

describe("captureGeometry", () => {
  it("snapshots id → geometry", () => {
    const g = captureGeometry([frame("a", 0.1, 0.2), frame("b", 0.3, 0.4)]);
    expect(g.get("a")).toEqual({ x: 0.1, y: 0.2, w: 100, h: 100 });
    expect(g.size).toBe(2);
  });

  it("tolerates an empty/absent frame list", () => {
    expect(captureGeometry([]).size).toBe(0);
    expect(captureGeometry(undefined).size).toBe(0);
  });
});

describe("geometryChanged", () => {
  const from = captureGeometry([frame("a", 0.1, 0.2)]);

  it("is false when nothing moved", () => {
    expect(geometryChanged(from, [frame("a", 0.1, 0.2)])).toBe(false);
  });

  it("detects a moved frame", () => {
    expect(geometryChanged(from, [frame("a", 0.9, 0.2)])).toBe(true);
  });

  it("detects a resized frame", () => {
    expect(geometryChanged(from, [frame("a", 0.1, 0.2, 140, 140)])).toBe(true);
  });

  it("ignores pure arrivals — a new frame has nothing to morph FROM", () => {
    expect(geometryChanged(from, [frame("a", 0.1, 0.2), frame("b", 0.5, 0.5)])).toBe(false);
  });

  it("ignores pure departures", () => {
    expect(geometryChanged(from, [])).toBe(false);
  });
});

describe("beginMorph", () => {
  const from = captureGeometry([frame("a", 0.1, 0.2)]);

  it("starts a morph when a surviving frame moved", () => {
    const m = beginMorph(from, [frame("a", 0.8, 0.2)], 1000);
    expect(m).toEqual({ t0: 1000, from });
  });

  it("returns null on first load (nothing to come from)", () => {
    expect(beginMorph(captureGeometry([]), [frame("a", 0.1, 0.2)], 1000)).toBeNull();
    expect(beginMorph(null, [frame("a", 0.1, 0.2)], 1000)).toBeNull();
  });

  it("returns null for a no-op resync, so an unchanged map stays inert", () => {
    expect(beginMorph(from, [frame("a", 0.1, 0.2)], 1000)).toBeNull();
  });

  it("returns null under reduced motion (snap, like every other transition)", () => {
    expect(beginMorph(from, [frame("a", 0.8, 0.2)], 1000, { reducedMotion: true })).toBeNull();
  });
});

describe("morphProgress / morphActive", () => {
  const m = { t0: 1000, from: new Map() };

  it("runs 0 → 1 across the window and clamps", () => {
    expect(morphProgress(m, 1000)).toBe(0);
    expect(morphProgress(m, 1000 + LAYOUT_MORPH_DURATION / 2)).toBeCloseTo(0.5);
    expect(morphProgress(m, 1000 + LAYOUT_MORPH_DURATION)).toBe(1);
    expect(morphProgress(m, 99999)).toBe(1);
    expect(morphProgress(m, 0)).toBe(0); // clock skew can't go negative
  });

  it("a null morph reads as settled", () => {
    expect(morphProgress(null, 1000)).toBe(1);
    expect(morphActive(null, 1000)).toBe(false);
  });

  it("is active only inside the window", () => {
    expect(morphActive(m, 1000)).toBe(true);
    expect(morphActive(m, 1000 + LAYOUT_MORPH_DURATION - 1)).toBe(true);
    expect(morphActive(m, 1000 + LAYOUT_MORPH_DURATION)).toBe(false);
  });
});

describe("morphGeom", () => {
  const from = captureGeometry([frame("a", 0, 0, 100, 100)]);
  const m = { t0: 1000, from };
  const next = frame("a", 1, 0.5, 200, 300);

  it("interpolates every geometry field", () => {
    const half = morphGeom(m, next, 1000 + LAYOUT_MORPH_DURATION / 2, linear);
    expect(half).toEqual({ x: 0.5, y: 0.25, w: 150, h: 200 });
  });

  it("starts at the old geometry and ends at the new", () => {
    expect(morphGeom(m, next, 1000, linear)).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(morphGeom(m, next, 1000 + LAYOUT_MORPH_DURATION, linear)).toBe(next);
  });

  it("returns the frame ITSELF when there is nothing to interpolate", () => {
    // Identity, not just equality: the settled path must stay allocation-free.
    expect(morphGeom(null, next, 1000, linear)).toBe(next);
    expect(morphGeom(m, frame("brand-new", 0.4, 0.4), 1000, linear)).not.toHaveProperty("interpolated");
    const fresh = frame("brand-new", 0.4, 0.4);
    expect(morphGeom(m, fresh, 1000, linear)).toBe(fresh);
  });

  it("applies the caller's easing curve", () => {
    const easeOut = (t) => t * (2 - t); // 0.5 → 0.75
    const g = morphGeom(m, next, 1000 + LAYOUT_MORPH_DURATION / 2, easeOut);
    expect(g.x).toBeCloseTo(0.75);
  });

  it("never mutates the frame or the snapshot", () => {
    morphGeom(m, next, 1000 + 10, linear);
    expect(next).toEqual({ id: "a", x: 1, y: 0.5, w: 200, h: 300 });
    expect(from.get("a")).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });
});

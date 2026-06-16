import { describe, it, expect } from "vitest";
import { weightedCentroid, repelFromBoxes, marginSlot, SATELLITE_SIZE } from "../../src/mcp-server/floating-placement.js";

describe("weightedCentroid", () => {
  it("returns null for no anchors", () => {
    expect(weightedCentroid([])).toBeNull();
  });
  it("returns null when total weight is zero", () => {
    expect(weightedCentroid([{ x: 10, y: 10, weight: 0 }])).toBeNull();
  });
  it("lands 3/4 of the way toward the heavier anchor", () => {
    const c = weightedCentroid([{ x: 0, y: 0, weight: 1 }, { x: 100, y: 0, weight: 3 }]);
    expect(c).toEqual({ x: 75, y: 0 });
  });
  it("skips non-positive weights", () => {
    expect(weightedCentroid([{ x: 0, y: 0, weight: -5 }, { x: 100, y: 0, weight: 1 }])).toEqual({ x: 100, y: 0 });
  });
});

describe("repelFromBoxes", () => {
  it("leaves a point already clear untouched", () => {
    const boxes = [{ x: 500, y: 400, w: 100, h: 100 }];
    expect(repelFromBoxes(100, 100, 20, boxes)).toEqual({ x: 100, y: 100 });
  });
  it("pushes a point seeded inside a box out along the lesser-penetration axis", () => {
    const boxes = [{ x: 500, y: 400, w: 100, h: 100 }];
    const out = repelFromBoxes(500, 440, 20, boxes);
    expect(out).toEqual({ x: 500, y: 460 });
  });
  it("does not push a point sitting exactly on the (expanded) box edge", () => {
    const boxes = [{ x: 500, y: 400, w: 100, h: 100 }];
    // expanded half-width = (100+20)/2 = 60 → right edge at x=560; touching, not overlapping.
    expect(repelFromBoxes(560, 400, 20, boxes)).toEqual({ x: 560, y: 400 });
  });
  it("terminates and stays on-stage even when boxes cannot all be satisfied", () => {
    const boxes = [
      { x: 100, y: 400, w: 100, h: 100 },
      { x: 160, y: 400, w: 100, h: 100 }, // overlaps the first; sandwiches the point
    ];
    const out = repelFromBoxes(130, 400, 84, boxes);
    expect(Number.isInteger(out.x)).toBe(true);
    expect(Number.isInteger(out.y)).toBe(true);
    expect(out.x).toBeGreaterThanOrEqual(42); // half of size 84
    expect(out.x).toBeLessThanOrEqual(1000 - 42);
    expect(out.y).toBeGreaterThanOrEqual(42);
    expect(out.y).toBeLessThanOrEqual(800 - 42);
  });
  it("clamps a point at the origin fully on-stage by its half-size", () => {
    expect(repelFromBoxes(0, 0, 84, [])).toEqual({ x: 42, y: 42 });
  });
});

describe("marginSlot", () => {
  it("places deterministic, evenly-spread slots in the bottom gutter", () => {
    expect(marginSlot(0, 3, SATELLITE_SIZE)).toEqual({ x: 100, y: 772 });
    expect(marginSlot(1, 3, SATELLITE_SIZE)).toEqual({ x: 500, y: 772 });
    expect(marginSlot(2, 3, SATELLITE_SIZE)).toEqual({ x: 900, y: 772 });
    expect(marginSlot(0, 1, SATELLITE_SIZE)).toEqual({ x: 500, y: 772 }); // total<=1 → centered
  });
});

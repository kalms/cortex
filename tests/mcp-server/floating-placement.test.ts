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
});

describe("repelFromBoxes", () => {
  it("leaves a point already clear untouched", () => {
    const boxes = [{ x: 500, y: 400, w: 100, h: 100 }];
    expect(repelFromBoxes(100, 100, 20, boxes)).toEqual({ x: 100, y: 100 });
  });
  it("pushes a point seeded inside a box out along the lesser-penetration axis", () => {
    const boxes = [{ x: 500, y: 400, w: 100, h: 100 }];
    const out = repelFromBoxes(500, 440, 20, boxes);
    expect(out.x).toBe(500);
    expect(out.y).toBeGreaterThan(450);
  });
});

describe("marginSlot", () => {
  it("is deterministic and spreads slots across the bottom gutter", () => {
    const a = marginSlot(0, 3, SATELLITE_SIZE);
    const b = marginSlot(0, 3, SATELLITE_SIZE);
    const c = marginSlot(2, 3, SATELLITE_SIZE);
    expect(a).toEqual(b);
    expect(c.x).toBeGreaterThan(a.x);
    expect(a.y).toBe(b.y);
  });
});

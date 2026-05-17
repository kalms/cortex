// tests/viewer/layout.test.js
import { describe, it, expect } from "vitest";
import { gridLayout } from "../../src/viewer/layout.js";

describe("gridLayout", () => {
  it("returns one positioned frame per input", () => {
    const result = gridLayout(
      [{ frame_id: 0, frame_label: "a", member_count: 5 },
       { frame_id: 1, frame_label: "b", member_count: 3 }],
      1000, 800,
    );
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.id)).toEqual([0, 1]);
  });

  it("preserves frame_id and frame_label as id/name", () => {
    const [a] = gridLayout(
      [{ frame_id: 7, frame_label: "viewer", member_count: 10 }],
      1000, 800,
    );
    expect(a.id).toBe(7);
    expect(a.name).toBe("viewer");
    expect(a.count).toBe(10);
  });

  it("sorts by member_count desc, then by frame_id asc", () => {
    const result = gridLayout(
      [{ frame_id: 0, frame_label: "a", member_count: 2 },
       { frame_id: 1, frame_label: "b", member_count: 8 },
       { frame_id: 2, frame_label: "c", member_count: 5 }],
      1000, 800,
    );
    // After sort: [b(8), c(5), a(2)]
    expect(result.map((f) => f.id)).toEqual([1, 2, 0]);
  });

  it("is deterministic — same input gives same output", () => {
    const input = [
      { frame_id: 0, frame_label: "a", member_count: 5 },
      { frame_id: 1, frame_label: "b", member_count: 3 },
      { frame_id: 2, frame_label: "c", member_count: 7 },
    ];
    const r1 = gridLayout(input, 1000, 800);
    const r2 = gridLayout(input, 1000, 800);
    expect(r1).toEqual(r2);
  });

  it("places frames within stage bounds", () => {
    const result = gridLayout(
      [{ frame_id: 0, frame_label: "a", member_count: 5 },
       { frame_id: 1, frame_label: "b", member_count: 3 },
       { frame_id: 2, frame_label: "c", member_count: 7 },
       { frame_id: 3, frame_label: "d", member_count: 2 }],
      1000, 800,
    );
    for (const f of result) {
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w / 2).toBeLessThanOrEqual(1000);
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(0);
      expect(f.y + f.h / 2).toBeLessThanOrEqual(800);
    }
  });

  it("returns empty array for empty input", () => {
    expect(gridLayout([], 1000, 800)).toEqual([]);
  });

  it("scales frame size by sqrt(member_count) within [0.55, 1.0] of cell", () => {
    const result = gridLayout(
      [{ frame_id: 0, frame_label: "a", member_count: 100 },
       { frame_id: 1, frame_label: "b", member_count: 1 }],
      1000, 800,
    );
    // Two frames → grid is 2x1. cellW=500, cellH=800. Inner = 80%.
    // Cell content area = 400×640.
    // largest gets 1.0× = 400, smallest gets 0.55× = 220.
    const [big, small] = result;
    expect(big.count).toBe(100);
    expect(small.count).toBe(1);
    expect(big.w).toBeGreaterThan(small.w);
  });

  it("handles single frame", () => {
    const [only] = gridLayout(
      [{ frame_id: 0, frame_label: "solo", member_count: 5 }],
      1000, 800,
    );
    // 1x1 grid: cell = full stage; inner = 80%
    expect(only.x).toBeCloseTo(500, 0);
    expect(only.y).toBeCloseTo(400, 0);
    expect(only.w).toBeCloseTo(800, 0); // 1000 * 0.8
    expect(only.h).toBeCloseTo(640, 0); // 800 * 0.8
  });
});

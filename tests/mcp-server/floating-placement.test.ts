import { describe, it, expect } from "vitest";
import { weightedCentroid, repelFromBoxes, marginSlot, SATELLITE_SIZE, placeNonAmbientFrames, separateMovables } from "../../src/mcp-server/floating-placement.js";

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

describe("placeNonAmbientFrames", () => {
  const ambientBoxes = [
    { id: 1, x: 200, y: 300, w: 120, h: 120 },
    { id: 2, x: 800, y: 300, w: 120, h: 120 },
  ];
  const ambientPositions = ambientBoxes.map((b) => ({ id: b.id, x: b.x, y: b.y }));

  it("centroids a non-ambient frame toward its ambient partners by pair weight", () => {
    const pairs = [{ a: 1, b: 9, weight: 3 }, { a: 2, b: 9, weight: 1 }];
    const out = placeNonAmbientFrames([{ frame_id: 9 }], pairs, ambientPositions, ambientBoxes);
    const p = out.get(9)!;
    expect(p.x).toBe(350);
    expect(p.y).toBe(300);
  });

  it("sends a frame with no ambient partner to a margin slot", () => {
    const out = placeNonAmbientFrames([{ frame_id: 9 }], [{ a: 7, b: 9, weight: 5 }], ambientPositions, ambientBoxes);
    // marginSlot → y=MARGIN_Y(=800-28=772), then repelFromBoxes clamps to STAGE_H - half(=800-42=758)
    expect(out.get(9)!.y).toBe(800 - 42);
  });

  it("is deterministic across runs", () => {
    const pairs = [{ a: 1, b: 9, weight: 2 }];
    const a = placeNonAmbientFrames([{ frame_id: 9 }], pairs, ambientPositions, ambientBoxes);
    const b = placeNonAmbientFrames([{ frame_id: 9 }], pairs, ambientPositions, ambientBoxes);
    expect([...a]).toEqual([...b]);
  });
});

import { placeAggregates } from "../../src/mcp-server/floating-placement.js";

describe("placeAggregates", () => {
  const ambientPositions = [
    { id: 1, x: 200, y: 300 }, { id: 2, x: 800, y: 300 },
  ];
  const ambientBoxes = ambientPositions.map((p) => ({ ...p, w: 120, h: 120 }));
  const frameRepDirsMap = new Map([[1, "app"], [2, "src"]]);

  it("uses edge ties first: centroid of edge-linked frames", () => {
    const edgeTies = new Map([["aux:locales:locales", new Map([[1, 3], [2, 1]])]]);
    const out = placeAggregates(
      [{ id: "aux:locales:locales", member_count: 4 }],
      edgeTies, new Map(), frameRepDirsMap, ambientPositions, ambientBoxes,
    );
    expect(out.get("aux:locales:locales")!.x).toBe(350); // (200*3 + 800*1)/4
  });

  it("falls back to path tie — placed near the host frame, not the margin", () => {
    const aggDirs = new Map([["aux:locales:locales", "app"]]);
    const out = placeAggregates(
      [{ id: "aux:locales:locales", member_count: 2 }],
      new Map(), aggDirs, frameRepDirsMap, ambientPositions, ambientBoxes,
    );
    const p = out.get("aux:locales:locales")!;
    // Path-tied to frame 1 (200,300) — its centroid IS frame 1's center, so the
    // dot is displaced to the nearest free slot: not the bottom margin, not
    // overlapping frame 1's box, and close to it.
    expect(p.y).not.toBe(800 - 28);
    const dx = Math.abs(p.x - 200), dy = Math.abs(p.y - 300);
    expect(dx >= (120 + 16) / 2 || dy >= (120 + 16) / 2).toBe(true); // 16 = AGG dot size
    expect(Math.hypot(p.x - 200, p.y - 300)).toBeLessThan(200);
  });

  it("falls back to a margin slot when neither edge nor path ties resolve", () => {
    const out = placeAggregates(
      [{ id: "aux:vendor:vendor", member_count: 9 }],
      new Map(), new Map([["aux:vendor:vendor", "nonexistent"]]), frameRepDirsMap,
      ambientPositions, ambientBoxes,
    );
    expect(out.get("aux:vendor:vendor")!.y).toBe(800 - 28); // MARGIN_Y
  });

  it("ignores edge ties to non-ambient frames and falls through to margin", () => {
    // frame 99 is not in ambientPositions and there is no path tie → margin slot.
    const edgeTies = new Map([["aux:x:x", new Map([[99, 5]])]]);
    const out = placeAggregates([{ id: "aux:x:x", member_count: 1 }], edgeTies, new Map(), frameRepDirsMap, ambientPositions, ambientBoxes);
    expect(out.get("aux:x:x")!.y).toBe(800 - 28); // MARGIN_Y (no ambient anchor)
  });

  it("path tie centroids all ambient frames sharing the host dir", () => {
    const reps = new Map([[1, "app"], [2, "app"]]); // both frames share host "app"
    const aggDirs = new Map([["aux:assets:assets", "app"]]);
    const out = placeAggregates([{ id: "aux:assets:assets", member_count: 1 }], new Map(), aggDirs, reps, ambientPositions, ambientBoxes);
    expect(out.get("aux:assets:assets")!).toEqual({ x: 500, y: 300 }); // centroid of (200,300)&(800,300)
  });

  it("is deterministic across runs", () => {
    const edgeTies = new Map([["aux:locales:locales", new Map([[1, 2], [2, 1]])]]);
    const args = [[{ id: "aux:locales:locales", member_count: 3 }], edgeTies, new Map(), frameRepDirsMap, ambientPositions, ambientBoxes] as const;
    const a = placeAggregates(...args);
    const b = placeAggregates(...args);
    expect([...a]).toEqual([...b]);
  });
});

describe("placeNonAmbientFrames — non-overlap invariant", () => {
  // 3 ambient frames; 6 non-ambient frames ALL pairing with the same ambient
  // frame (id 1) → identical centroid before the fix → they used to stack.
  const ambientPositions = [
    { id: 1, x: 500, y: 400 },
    { id: 2, x: 180, y: 180 },
    { id: 3, x: 820, y: 620 },
  ];
  const ambientBoxes = ambientPositions.map((p) => ({ ...p, w: 120, h: 120 }));
  const nonAmbient = [7, 8, 9, 10, 11, 12].map((frame_id) => ({ frame_id }));
  const pairs = nonAmbient.map((f) => ({ a: 1, b: f.frame_id, weight: 1 }));

  it("produces no two satellite frames directly on top of each other", () => {
    const out = placeNonAmbientFrames(nonAmbient, pairs, ambientPositions, ambientBoxes);
    const sats = [...out.values()];
    for (let i = 0; i < sats.length; i++) {
      for (let j = i + 1; j < sats.length; j++) {
        const dx = Math.abs(sats[i].x - sats[j].x);
        const dy = Math.abs(sats[i].y - sats[j].y);
        // two 84px square frames don't overlap iff separated ≥84 on either axis
        expect(dx >= SATELLITE_SIZE || dy >= SATELLITE_SIZE).toBe(true);
      }
    }
  });

  it("places no satellite frame on top of an ambient frame", () => {
    const out = placeNonAmbientFrames(nonAmbient, pairs, ambientPositions, ambientBoxes);
    for (const s of out.values()) {
      for (const b of ambientBoxes) {
        const dx = Math.abs(s.x - b.x);
        const dy = Math.abs(s.y - b.y);
        const minX = (SATELLITE_SIZE + b.w) / 2;
        const minY = (SATELLITE_SIZE + b.h) / 2;
        expect(dx >= minX || dy >= minY).toBe(true);
      }
    }
  });

  it("stays deterministic across runs", () => {
    const a = placeNonAmbientFrames(nonAmbient, pairs, ambientPositions, ambientBoxes);
    const b = placeNonAmbientFrames(nonAmbient, pairs, ambientPositions, ambientBoxes);
    expect([...a]).toEqual([...b]);
  });
});

describe("placeAggregates — no two aggregate dots stack", () => {
  it("separates two aggregates tied to the same single frame", () => {
    const ambientPositions = [{ id: 1, x: 200, y: 300 }];
    const ambientBoxes = [{ id: 1, x: 200, y: 300, w: 120, h: 120 }];
    const edgeTies = new Map([
      ["aux:a:a", new Map([[1, 1]])],
      ["aux:b:b", new Map([[1, 1]])],
    ]); // both seed at frame 1's center → must not coincide after placement
    const out = placeAggregates(
      [{ id: "aux:a:a", member_count: 1 }, { id: "aux:b:b", member_count: 1 }],
      edgeTies, new Map(), new Map([[1, "app"]]), ambientPositions, ambientBoxes,
    );
    const a = out.get("aux:a:a")!, b = out.get("aux:b:b")!;
    const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
    expect(dx >= 16 || dy >= 16).toBe(true); // two 16px dots don't overlap
  });
});

describe("separateMovables — saturated stage", () => {
  it("returns an on-stage integer position without throwing when no slot is free", () => {
    const fixed = [{ x: 500, y: 400, w: 1000, h: 800 }]; // covers the entire stage
    const out = separateMovables([{ id: "x", x: 500, y: 400, size: 84 }], fixed);
    const m = out[0]!;
    expect(Number.isInteger(m.x) && Number.isInteger(m.y)).toBe(true);
    expect(m.x >= 42 && m.x <= 958 && m.y >= 42 && m.y <= 758).toBe(true); // clamped on-stage
  });
});

import { describe, it, expect } from "vitest";
import { weightedCentroid, repelFromBoxes, marginSlot, SATELLITE_SIZE, placeNonAmbientFrames, separateMovables, ambientCloud, pushOutsideCloud, CLOUD_GAP } from "../../src/mcp-server/floating-placement.js";

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

describe("ambientCloud", () => {
  it("returns null for an empty cloud", () => {
    expect(ambientCloud([])).toBeNull();
  });
  it("centroid is the mean of box centers; radius encloses every box corner + gap", () => {
    const boxes = [
      { x: 200, y: 300, w: 120, h: 120 },
      { x: 800, y: 300, w: 120, h: 120 },
    ];
    const c = ambientCloud(boxes)!;
    expect(c).not.toBeNull();
    expect(c.cx).toBe(500);
    expect(c.cy).toBe(300);
    // furthest corner: dist(centroid, center)=300 + halfDiag(=hypot(120,120)/2≈84.85) + gap
    const halfDiag = Math.hypot(120, 120) / 2;
    expect(c.r).toBeCloseTo(300 + halfDiag + CLOUD_GAP, 5);
  });
  it("a single box yields a radius of just its half-diagonal + gap", () => {
    const c = ambientCloud([{ x: 500, y: 400, w: 100, h: 100 }])!;
    expect(c.cx).toBe(500);
    expect(c.cy).toBe(400);
    expect(c.r).toBeCloseTo(Math.hypot(100, 100) / 2 + CLOUD_GAP, 5);
  });
});

describe("pushOutsideCloud", () => {
  const cloud = { cx: 500, cy: 400, r: 200 };
  it("leaves a point already outside the keep-out circle untouched", () => {
    // a 84px box centered 300px out: near edge at 258 > r → already clear.
    expect(pushOutsideCloud(800, 400, 84, cloud, 0)).toEqual({ x: 800, y: 400 });
  });
  it("pushes an inside point radially out so its near edge clears the circle", () => {
    // seed at the centroid-side, 50px right of center → pushed straight right.
    const out = pushOutsideCloud(550, 400, 84, cloud, 0);
    expect(out.y).toBe(400); // direction preserved (pure +x)
    // center lands at r + half = 200 + 42 = 242 out → x = 742
    expect(out.x).toBe(742);
  });
  it("preserves the gravity direction (toward the seed's offset from center)", () => {
    // seed up-and-left of center → pushed further up-and-left along the same ray.
    const out = pushOutsideCloud(460, 360, 84, cloud, 0);
    const dx = out.x - 500, dy = out.y - 400;
    expect(dx).toBeLessThan(0);
    expect(dy).toBeLessThan(0);
    expect(Math.hypot(dx, dy)).toBeCloseTo(242, 5); // r + half
    // same ray as the seed offset (-40,-40): equal components
    expect(dx).toBeCloseTo(dy, 5);
  });
  it("uses a deterministic fallback direction for a point exactly at the center", () => {
    const a = pushOutsideCloud(500, 400, 84, cloud, 0);
    const b = pushOutsideCloud(500, 400, 84, cloud, 0);
    expect(a).toEqual(b); // deterministic
    expect(Math.hypot(a.x - 500, a.y - 400)).toBeCloseTo(242, 5);
  });
  it("fans co-incident center points out along distinct fallback rays by index", () => {
    const a = pushOutsideCloud(500, 400, 84, cloud, 0);
    const b = pushOutsideCloud(500, 400, 84, cloud, 1);
    expect(a).not.toEqual(b);
  });
});

describe("placeNonAmbientFrames", () => {
  const ambientBoxes = [
    { id: 1, x: 200, y: 300, w: 120, h: 120 },
    { id: 2, x: 800, y: 300, w: 120, h: 120 },
  ];
  const ambientPositions = ambientBoxes.map((b) => ({ id: b.id, x: b.x, y: b.y }));

  it("seeds toward its ambient partners by pair weight, then pushes outside the cloud", () => {
    const pairs = [{ a: 1, b: 9, weight: 3 }, { a: 2, b: 9, weight: 1 }];
    const out = placeNonAmbientFrames([{ frame_id: 9 }], pairs, ambientPositions, ambientBoxes);
    const p = out.get(9)!;
    // Raw weighted centroid (350,300) is LEFT of the cloud center (500,300) and
    // inside the keep-out circle, so it is pushed further left, out of the circle,
    // along that same leftward gravity ray. It must end up outside the circle.
    const cloud = ambientCloud(ambientBoxes)!;
    expect(Math.hypot(p.x - cloud.cx, p.y - cloud.cy)).toBeGreaterThanOrEqual(cloud.r - 1);
    expect(p.x).toBeLessThan(500); // still on its partners' (left) side
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

  it("seeds at the edge-tie centroid, then pushes the dot outside the cloud", () => {
    const edgeTies = new Map([["aux:locales:locales", new Map([[1, 3], [2, 1]])]]);
    const out = placeAggregates(
      [{ id: "aux:locales:locales", member_count: 4 }],
      edgeTies, new Map(), frameRepDirsMap, ambientPositions, ambientBoxes,
    );
    const p = out.get("aux:locales:locales")!;
    // raw centroid (350,300) is inside the keep-out circle → pushed out to the
    // left (its gravity side), never left sitting in the cloud's middle.
    const cloud = ambientCloud(ambientBoxes)!;
    expect(Math.hypot(p.x - cloud.cx, p.y - cloud.cy)).toBeGreaterThanOrEqual(cloud.r - 1);
    expect(p.x).toBeLessThan(500);
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

  it("path tie centroids all ambient frames sharing the host dir, then pushes outside the cloud", () => {
    const reps = new Map([[1, "app"], [2, "app"]]); // both frames share host "app"
    const aggDirs = new Map([["aux:assets:assets", "app"]]);
    const out = placeAggregates([{ id: "aux:assets:assets", member_count: 1 }], new Map(), aggDirs, reps, ambientPositions, ambientBoxes);
    const p = out.get("aux:assets:assets")!;
    // centroid of (200,300)&(800,300) is (500,300) — exactly the cloud center —
    // so it is pushed out along a deterministic fallback ray, not left dead-center.
    const cloud = ambientCloud(ambientBoxes)!;
    expect(Math.hypot(p.x - cloud.cx, p.y - cloud.cy)).toBeGreaterThanOrEqual(cloud.r - 1);
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

describe("keep-out invariant — auxiliaries never sit inside the ambient cloud", () => {
  // A realistic many-frame cloud: ambient frames clustered centrally, several
  // satellites whose pair-weighted centroids would otherwise land mid-cloud.
  const ambientBoxes = [
    { id: 1, x: 420, y: 360, w: 130, h: 130 },
    { id: 2, x: 560, y: 380, w: 130, h: 130 },
    { id: 3, x: 500, y: 480, w: 130, h: 130 },
    { id: 4, x: 470, y: 300, w: 130, h: 130 },
  ];
  const ambientPositions = ambientBoxes.map((b) => ({ id: b.id, x: b.x, y: b.y }));
  const cloud = ambientCloud(ambientBoxes)!;

  it("no satellite frame center lands inside the cloud keep-out circle", () => {
    const nonAmbient = [10, 11, 12, 13].map((frame_id) => ({ frame_id }));
    // each satellite links to frames on opposite sides → centroid near cloud center
    const pairs = [
      { a: 1, b: 10, weight: 1 }, { a: 2, b: 10, weight: 1 },
      { a: 3, b: 11, weight: 1 }, { a: 4, b: 11, weight: 1 },
      { a: 1, b: 12, weight: 1 }, { a: 3, b: 12, weight: 1 },
      { a: 2, b: 13, weight: 1 }, { a: 4, b: 13, weight: 1 },
    ];
    const out = placeNonAmbientFrames(nonAmbient, pairs, ambientPositions, ambientBoxes);
    for (const p of out.values()) {
      // center must be at least the circle radius from the centroid (allowing the
      // separation pass to nudge it, never back inside).
      expect(Math.hypot(p.x - cloud.cx, p.y - cloud.cy)).toBeGreaterThanOrEqual(cloud.r - SATELLITE_SIZE / 2 - 1);
    }
  });

  it("no aggregate dot lands inside the cloud keep-out circle", () => {
    const edgeTies = new Map([
      ["aux:a:a", new Map([[1, 1], [2, 1]])],
      ["aux:b:b", new Map([[3, 1], [4, 1]])],
    ]);
    const out = placeAggregates(
      [{ id: "aux:a:a", member_count: 2 }, { id: "aux:b:b", member_count: 2 }],
      edgeTies, new Map(), new Map(), ambientPositions, ambientBoxes,
    );
    for (const p of out.values()) {
      expect(Math.hypot(p.x - cloud.cx, p.y - cloud.cy)).toBeGreaterThanOrEqual(cloud.r - 8 - 1);
    }
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

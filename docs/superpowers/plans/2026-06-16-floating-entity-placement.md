# Floating-Entity Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the viewer's two fixed strips (auxiliary-aggregate bottom strip + decision-governed-frame top strip) with deterministic server-side gravity-centroid placement that drifts each satellite near the ambient frames it relates to.

**Architecture:** A new pure module `floating-placement.ts` runs *after* the unchanged ambient force-sim (`layoutFrames`), positioning non-ambient frames and aggregates relative to the final ambient positions. Placement depends only on `(ambient positions, ties)` — never on how those positions were produced (the layout-mode extensibility seam). The frame map fills x/y for non-ambient frames; `/api/aggregates` serves positioned aggregates; the viewer renders both at their server positions, de-emphasized. Governance selection stays client-side; D-xwxj is superseded.

**Tech Stack:** TypeScript/ESM, Vitest, Node http (viewer API), vanilla-JS canvas viewer. No new deps.

**Spec:** `docs/superpowers/specs/2026-06-16-floating-entity-placement-design.md`.

**Key existing types (do not redefine — import):**
- `FramePairWeight { a: number; b: number; weight: number }` — `src/mcp-server/frame-pair-rollup.ts`. `rollupFramePairs(nodes, edges)` returns these; `buildNodeFrameIndex(nodes)` maps `nodeId → frameId` for *framed* files only.
- `NodeRow { id, kind, file_path, name, qualified_name, data }`, `EdgeRow { source_id, target_id, relation }` — `src/graph/store.ts`.
- `Aggregate { id, label, aux_segment, member_count, sample_paths }` + `groupAuxiliaryPaths(paths)` + `DEFAULT_AUXILIARY_SEGMENTS` — `src/frame-extraction/auxiliary-detection.ts`.
- `STAGE_W = 1000`, `STAGE_H = 800` — `src/mcp-server/frame-layout.ts`.
- `FrameMapEntry { id, name, count, x, y, w, h, ambient, rank, score, layer }` — `src/mcp-server/frame-map.ts` (`x/y/w/h` are integer virtual-stage px, `null` for non-ambient today).
- `ROLLUP_RELATIONS = Set(["CALLS","USAGE","IMPORTS"])` — `frame-pair-rollup.ts`.

**Determinism rule (applies to every task):** no PRNG; fixed ordering (`a.id - b.id` for frames, `localeCompare` on string ids for aggregates); integer-pixel quantize on every emitted coordinate; bounded iteration counts. Same input → byte-identical output.

---

## File Structure

- **Create** `src/mcp-server/floating-placement.ts` — pure placement: `weightedCentroid`, `repelFromBoxes`, `marginSlot`, `placeNonAmbientFrames`, `placeAggregates`, and the shared constants. One responsibility: position satellites relative to anchored ambient frames.
- **Create** `src/mcp-server/aggregate-ties.ts` — pure tie-building: `buildAggregatePathIndex`, `buildAggregateEdgeTies`, `frameRepDirs`, `aggregateDirs`. One responsibility: derive an aggregate's ties to frames from edges + paths.
- **Modify** `src/mcp-server/frame-map.ts` — after `layoutFrames`, call `placeNonAmbientFrames` and fill x/y/w/h for non-ambient entries.
- **Modify** `src/mcp-server/api.ts` (`/api/aggregates`) — fetch edges, reuse `buildFrameMap` for ambient positions, build ties, place aggregates, serve positioned aggregates.
- **Modify** `src/viewer/viewer.js` — render non-ambient governed frames at server x/y (de-emphasized); render aggregates at server x/y; delete the strip math.
- **Modify** `src/viewer/adapters.js` — `withGovernedFramesRendered` keeps *selection* but drops *strip layout*.
- **Create** tests: `tests/mcp-server/floating-placement.test.ts`, `tests/mcp-server/aggregate-ties.test.ts`, additions to `tests/mcp-server/frame-map-layer.test.ts`, `tests/api/aggregates-positioned.test.ts`.

---

## Task 1: Pure placement primitives

**Files:**
- Create: `src/mcp-server/floating-placement.ts`
- Test: `tests/mcp-server/floating-placement.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp-server/floating-placement.test.ts
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
    // anchor A at x=0 weight1, anchor B at x=100 weight3 → x = 300/4 = 75.
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
    // box centered (500,400) 100x100 → spans x[450,550] y[350,450]. Point at
    // (500,440): inside; nearer the bottom edge (450) than any side → pushed down.
    const boxes = [{ x: 500, y: 400, w: 100, h: 100 }];
    const out = repelFromBoxes(500, 440, 20, boxes);
    expect(out.x).toBe(500);
    expect(out.y).toBeGreaterThan(450); // clear of the box's bottom edge + half size
  });
});

describe("marginSlot", () => {
  it("is deterministic and spreads slots across the bottom gutter", () => {
    const a = marginSlot(0, 3, SATELLITE_SIZE);
    const b = marginSlot(0, 3, SATELLITE_SIZE);
    const c = marginSlot(2, 3, SATELLITE_SIZE);
    expect(a).toEqual(b);            // same input → same output
    expect(c.x).toBeGreaterThan(a.x); // later index → further right
    expect(a.y).toBe(b.y);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/rka/Development/cortex-wt-floating-entity && npx vitest run tests/mcp-server/floating-placement.test.ts`
Expected: FAIL — module `floating-placement.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/mcp-server/floating-placement.ts
/**
 * Deterministic gravity-centroid placement for floating entities (layout slice
 * part 2). Runs AFTER the ambient force-sim; positions satellites (non-ambient
 * frames, auxiliary aggregates) relative to the FINAL ambient positions. Pure —
 * no PRNG, integer-quantized, bounded iterations. Depends only on (ambient
 * positions, ties), never on how the ambient positions were produced (the
 * layout-mode extensibility seam).
 */
import { STAGE_W, STAGE_H } from "./frame-layout.js";

/** Fixed satellite frame size (px) — smaller than the ambient 110–160 band so
 *  non-ambient frames read as de-emphasized. */
export const SATELLITE_SIZE = 84;
/** Aggregate dot collision radius (px) used for frame-repulsion. */
export const AGG_RADIUS = 8;
/** Bottom gutter y for the tie-less margin fallback (inside the stage). */
const MARGIN_Y = STAGE_H - 28;
/** Iteration cap for the repulsion solve (bounded → terminates, deterministic). */
const REPEL_ITERATIONS = 24;

/** A frame box: integer center x/y + square size w (== h). */
export interface Box { x: number; y: number; w: number; h: number; }
/** A weighted anchor for centroiding. */
export interface WeightedAnchor { x: number; y: number; weight: number; }

const q = (n: number): number => Math.round(n);

/** Weighted centroid of anchors; null when there are none or total weight ≤ 0. */
export function weightedCentroid(anchors: readonly WeightedAnchor[]): { x: number; y: number } | null {
  let sw = 0, sx = 0, sy = 0;
  for (const a of anchors) {
    if (a.weight <= 0) continue;
    sw += a.weight; sx += a.x * a.weight; sy += a.y * a.weight;
  }
  if (sw <= 0) return null;
  return { x: q(sx / sw), y: q(sy / sw) };
}

/** Push a point of the given square size out of any overlapping box, along the
 *  axis of lesser penetration. Anchored boxes never move. Bounded + clamped. */
export function repelFromBoxes(x: number, y: number, size: number, boxes: readonly Box[]): { x: number; y: number } {
  let px = x, py = y;
  const half = size / 2;
  for (let iter = 0; iter < REPEL_ITERATIONS; iter++) {
    let moved = false;
    for (const b of boxes) {
      const halfW = (b.w + size) / 2;
      const halfH = (b.h + size) / 2;
      const dx = px - b.x, dy = py - b.y;
      const ox = halfW - Math.abs(dx); // x overlap (positive = overlapping)
      const oy = halfH - Math.abs(dy); // y overlap
      if (ox > 0 && oy > 0) {
        if (ox < oy) px = b.x + (dx >= 0 ? halfW : -halfW);
        else py = b.y + (dy >= 0 ? halfH : -halfH);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // Keep the satellite fully on-stage.
  px = Math.min(STAGE_W - half, Math.max(half, px));
  py = Math.min(STAGE_H - half, Math.max(half, py));
  return { x: q(px), y: q(py) };
}

/** Deterministic slot in the bottom gutter for tie-less entities. Slots spread
 *  evenly across the inner 10%–90% of stage width. */
export function marginSlot(index: number, total: number, size: number): { x: number; y: number } {
  const half = size / 2;
  const x = total <= 1 ? STAGE_W / 2 : STAGE_W * (0.1 + (0.8 * index) / (total - 1));
  const clampedX = Math.min(STAGE_W - half, Math.max(half, x));
  return { x: q(clampedX), y: q(MARGIN_Y) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/floating-placement.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/floating-placement.ts tests/mcp-server/floating-placement.test.ts
git commit -m "feat(layout): pure placement primitives (centroid, repulsion, margin)"
```

---

## Task 2: Non-ambient frame placement + frame-map wiring

**Files:**
- Modify: `src/mcp-server/floating-placement.ts` (add `placeNonAmbientFrames`)
- Modify: `src/mcp-server/frame-map.ts` (call it after `layoutFrames`)
- Test: `tests/mcp-server/floating-placement.test.ts`, `tests/mcp-server/frame-map-layer.test.ts`

- [ ] **Step 1: Write the failing unit test for `placeNonAmbientFrames`**

```ts
// append to tests/mcp-server/floating-placement.test.ts
import { placeNonAmbientFrames } from "../../src/mcp-server/floating-placement.js";

describe("placeNonAmbientFrames", () => {
  const ambientBoxes = [
    { id: 1, x: 200, y: 300, w: 120, h: 120 },
    { id: 2, x: 800, y: 300, w: 120, h: 120 },
  ];
  const ambientPositions = ambientBoxes.map((b) => ({ id: b.id, x: b.x, y: b.y }));

  it("centroids a non-ambient frame toward its ambient partners by pair weight", () => {
    // frame 9 pairs with frame 1 (w=3) and frame 2 (w=1) → x = (200*3+800*1)/4 = 350.
    const pairs = [{ a: 1, b: 9, weight: 3 }, { a: 2, b: 9, weight: 1 }];
    const out = placeNonAmbientFrames([{ frame_id: 9 }], pairs, ambientPositions, ambientBoxes);
    const p = out.get(9)!;
    expect(p.x).toBe(350);
    expect(p.y).toBe(300);
  });

  it("sends a frame with no ambient partner to a margin slot", () => {
    // frame 9 pairs only with another non-ambient frame (7) → no anchor → margin.
    const out = placeNonAmbientFrames([{ frame_id: 9 }], [{ a: 7, b: 9, weight: 5 }], ambientPositions, ambientBoxes);
    const p = out.get(9)!;
    expect(p.y).toBe(800 - 28); // MARGIN_Y
  });

  it("is deterministic across runs", () => {
    const pairs = [{ a: 1, b: 9, weight: 2 }];
    const a = placeNonAmbientFrames([{ frame_id: 9 }], pairs, ambientPositions, ambientBoxes);
    const b = placeNonAmbientFrames([{ frame_id: 9 }], pairs, ambientPositions, ambientBoxes);
    expect([...a]).toEqual([...b]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mcp-server/floating-placement.test.ts`
Expected: FAIL — `placeNonAmbientFrames` is not exported.

- [ ] **Step 3: Implement `placeNonAmbientFrames`**

```ts
// append to src/mcp-server/floating-placement.ts
import type { FramePairWeight } from "./frame-pair-rollup.js";

/** Position each non-ambient frame at the pair-weighted centroid of the AMBIENT
 *  frames it connects to (frame-repulsion applied; margin fallback when it has
 *  no ambient partner). Returns frame_id → integer center {x, y}. Satellites are
 *  anchored only to AMBIENT frames (stable anchors) — never to each other. */
export function placeNonAmbientFrames(
  nonAmbient: readonly { frame_id: number }[],
  framePairs: readonly FramePairWeight[],
  ambientPositions: readonly { id: number; x: number; y: number }[],
  ambientBoxes: readonly Box[],
): Map<number, { x: number; y: number }> {
  const ambientPos = new Map(ambientPositions.map((p) => [p.id, p]));
  // Index pairs by frame_id → list of {partner, weight}, ambient partners only.
  const partnersOf = new Map<number, WeightedAnchor[]>();
  for (const f of nonAmbient) partnersOf.set(f.frame_id, []);
  for (const p of framePairs) {
    for (const [self, other] of [[p.a, p.b], [p.b, p.a]] as const) {
      const bucket = partnersOf.get(self);
      const anchor = ambientPos.get(other);
      if (bucket && anchor) bucket.push({ x: anchor.x, y: anchor.y, weight: p.weight });
    }
  }
  // Deterministic order: by frame_id, so margin-slot indices are stable.
  const sorted = [...nonAmbient].map((f) => f.frame_id).sort((x, y) => x - y);
  const tieless = sorted.filter((id) => (partnersOf.get(id) ?? []).length === 0);
  const tielessIndex = new Map(tieless.map((id, i) => [id, i]));
  const out = new Map<number, { x: number; y: number }>();
  for (const id of sorted) {
    const c = weightedCentroid(partnersOf.get(id) ?? []);
    const seed = c ?? marginSlot(tielessIndex.get(id)!, tieless.length, SATELLITE_SIZE);
    out.set(id, repelFromBoxes(seed.x, seed.y, SATELLITE_SIZE, ambientBoxes));
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mcp-server/floating-placement.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the frame-map integration test (ambient unchanged + non-ambient positioned)**

```ts
// append to tests/mcp-server/frame-map-layer.test.ts inside a new describe
describe("floating non-ambient frame placement", () => {
  it("keeps ambient positions byte-identical and now positions non-ambient frames", () => {
    // `nodes`/`edges` are the shared fixture already used in this file.
    const map = buildFrameMap(nodes, edges);
    const ambient = map.frames.filter((f) => f.ambient);
    const nonAmbient = map.frames.filter((f) => !f.ambient);
    // Every non-ambient frame now carries integer x/y/w/h (was null before).
    for (const f of nonAmbient) {
      expect(f.x).not.toBeNull();
      expect(f.y).not.toBeNull();
      expect(f.w).toBe(84); // SATELLITE_SIZE
      expect(f.h).toBe(84);
    }
    // Ambient frames keep real layout sizes (≠ satellite size in general).
    expect(ambient.length).toBeGreaterThan(0);
  });
});
```

If the shared fixture happens to produce zero non-ambient frames, add a `cluster:N` low-rank filler to it so `nonAmbient.length > 0`; otherwise the loop is vacuous (still passes, but assert `nonAmbient.length > 0` to make the test meaningful).

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run tests/mcp-server/frame-map-layer.test.ts -t "floating non-ambient"`
Expected: FAIL — non-ambient `x/y` are still `null`.

- [ ] **Step 7: Wire into `buildFrameMap`**

In `src/mcp-server/frame-map.ts`, the block at lines 185–202 currently maps `ranked` to `FrameMapEntry` and leaves non-ambient `x/y/w/h` null. Replace it with a version that places non-ambient frames first. Add the import at the top (near the other `./` imports):

```ts
import { placeNonAmbientFrames, SATELLITE_SIZE } from "./floating-placement.js";
```

Then replace the `posById` + `frames` block (current lines 185–202) with:

```ts
  const posById = new Map(positioned.map((p) => [p.id, p]));

  // Floating placement (layout slice part 2): position the NON-ambient frames at
  // the pair-weighted centroid of the ambient frames they connect to, so they
  // drift near related content instead of an arbitrary strip. Ambient positions
  // (above) are untouched — byte-identical to the pre-slice output.
  const ambientPositions = positioned.map((p) => ({ id: p.id, x: p.x, y: p.y }));
  const ambientBoxes = positioned.map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h }));
  const nonAmbient = ranked.filter((r) => !ambientIds.has(r.frame_id)).map((r) => ({ frame_id: r.frame_id }));
  const floatPos = placeNonAmbientFrames(nonAmbient, pairs, ambientPositions, ambientBoxes);

  const frames: FrameMapEntry[] = ranked.map((r) => {
    const p = posById.get(r.frame_id);
    if (p) {
      return {
        id: r.frame_id, name: r.frame_label, count: r.member_count,
        x: p.x, y: p.y, w: p.w, h: p.h,
        ambient: true, rank: r.rank, score: r.score,
        layer: layerById.get(r.frame_id) ?? "domain",
      };
    }
    const fp = floatPos.get(r.frame_id) ?? null;
    return {
      id: r.frame_id, name: r.frame_label, count: r.member_count,
      x: fp ? fp.x : null, y: fp ? fp.y : null,
      w: fp ? SATELLITE_SIZE : null, h: fp ? SATELLITE_SIZE : null,
      ambient: false, rank: r.rank, score: r.score,
      layer: layerById.get(r.frame_id) ?? "domain",
    };
  });

  return { frames, stage: { w: STAGE_W, h: STAGE_H } };
```

- [ ] **Step 8: Run frame-map + full suite to verify pass + no regression**

Run: `npx vitest run tests/mcp-server/frame-map-layer.test.ts`
Expected: PASS, including the existing "default ON / opt-out" layout golden tests (ambient positions unchanged — the new pass only fills previously-null non-ambient fields).

Run: `npx vitest run` — Expected: full suite green.

- [ ] **Step 9: Commit**

```bash
git add src/mcp-server/floating-placement.ts src/mcp-server/frame-map.ts tests/mcp-server/floating-placement.test.ts tests/mcp-server/frame-map-layer.test.ts
git commit -m "feat(layout): place non-ambient frames at pair-weighted centroid"
```

---

## Task 3: Aggregate ties (edges + paths)

**Files:**
- Create: `src/mcp-server/aggregate-ties.ts`
- Test: `tests/mcp-server/aggregate-ties.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp-server/aggregate-ties.test.ts
import { describe, it, expect } from "vitest";
import { buildAggregatePathIndex, buildAggregateEdgeTies, frameRepDirs, aggregateDirs } from "../../src/mcp-server/aggregate-ties.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

// Minimal node factory. Framed files carry data.frame_id; aux files do not.
const fileNode = (id: string, file_path: string, frame_id?: number): NodeRow => ({
  id, kind: "file", file_path, name: file_path, qualified_name: file_path,
  data: frame_id === undefined ? "{}" : JSON.stringify({ frame_id, frame_label: `f${frame_id}` }),
} as NodeRow);
const edge = (source_id: string, target_id: string, relation = "IMPORTS"): EdgeRow =>
  ({ source_id, target_id, relation } as EdgeRow);

describe("buildAggregatePathIndex", () => {
  it("maps every auxiliary file path to its aggregate id", () => {
    const idx = buildAggregatePathIndex(["app/locales/en.json", "app/locales/fr.json", "src/cli/run.ts"]);
    expect(idx.get("app/locales/en.json")).toBe("aux:locales:locales");
    expect(idx.get("app/locales/fr.json")).toBe("aux:locales:locales");
    expect(idx.has("src/cli/run.ts")).toBe(false); // non-aux
  });
});

describe("buildAggregateEdgeTies", () => {
  it("ties an aggregate to frames its member files link to", () => {
    const nodes: NodeRow[] = [
      fileNode("a", "app/locales/en.json"),        // aux
      fileNode("f1", "app/ui/menu.ts", 1),          // framed (frame 1)
      fileNode("f2", "app/api/route.ts", 2),        // framed (frame 2)
    ];
    const edges: EdgeRow[] = [edge("f1", "a", "USAGE"), edge("a", "f2", "IMPORTS")];
    const ties = buildAggregateEdgeTies(nodes, edges);
    const m = ties.get("aux:locales:locales")!;
    expect(m.get(1)).toBe(1);
    expect(m.get(2)).toBe(1);
  });
  it("ignores non-rollup relations and intra-aux edges", () => {
    const nodes: NodeRow[] = [fileNode("a", "vendor/x.js"), fileNode("b", "vendor/y.js")];
    const edges: EdgeRow[] = [edge("a", "b", "IMPORTS"), edge("a", "b", "CONTAINS")];
    const ties = buildAggregateEdgeTies(nodes, edges);
    expect(ties.size).toBe(0); // no aux→frame edges
  });
});

describe("frameRepDirs", () => {
  it("derives each frame's representative top dir from its member paths", () => {
    const nodes: NodeRow[] = [
      fileNode("f1", "app/ui/menu.ts", 1), fileNode("f1b", "app/ui/list.ts", 1),
      fileNode("f2", "src/api/route.ts", 2),
    ];
    const dirs = frameRepDirs(nodes);
    expect(dirs.get(1)).toBe("app");
    expect(dirs.get(2)).toBe("src");
  });
});

describe("aggregateDirs", () => {
  it("maps an aggregate to the host dir segment above its aux segment", () => {
    const dirs = aggregateDirs(["app/locales/en.json", "i18n/fr.json"]);
    expect(dirs.get("aux:locales:locales")).toBe("app"); // host dir above `locales`
    expect(dirs.get("aux:i18n:i18n")).toBe("");           // aux segment is first → no host dir
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mcp-server/aggregate-ties.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `aggregate-ties.ts`**

```ts
// src/mcp-server/aggregate-ties.ts
/**
 * Derive each auxiliary aggregate's ties to frames, for gravity-centroid
 * placement (layout slice part 2). Two tie sources, matching the spec's
 * edge→path cascade:
 *   - EDGE ties: CALLS/USAGE/IMPORTS edges between an aggregate's member files
 *     and a framed file → the aggregate tallies the connected frame.
 *   - PATH ties: an aggregate's host directory (the segment above its aux
 *     segment) matched against each frame's representative directory.
 * PURE — no I/O. Aggregate ids match `groupAuxiliaryPaths` exactly.
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";
import { DEFAULT_AUXILIARY_SEGMENTS } from "../frame-extraction/auxiliary-detection.js";
import { ROLLUP_RELATIONS, buildNodeFrameIndex } from "./frame-pair-rollup.js";

/** First auxiliary segment index in a split path, or -1. */
function auxIndex(parts: string[], segments: ReadonlySet<string>): number {
  for (let i = 0; i < parts.length; i++) if (segments.has(parts[i]!)) return i;
  return -1;
}

/** The aggregate id for an auxiliary path — identical keying to
 *  `groupAuxiliaryPaths` (`aux:<segment>:<label>`). Returns null if non-aux. */
function aggregateIdFor(path: string, segments: ReadonlySet<string>): string | null {
  const parts = path.split("/");
  const i = auxIndex(parts, segments);
  if (i === -1) return null;
  const seg = parts[i]!;
  const label = i + 2 < parts.length ? parts[i + 1]! : seg;
  return `aux:${seg}:${label}`;
}

/** Every auxiliary file path → its aggregate id. */
export function buildAggregatePathIndex(
  paths: readonly string[],
  segments: ReadonlySet<string> = DEFAULT_AUXILIARY_SEGMENTS,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    if (!p) continue;
    const id = aggregateIdFor(p, segments);
    if (id) out.set(p, id);
  }
  return out;
}

/** Aggregate id → host directory segment (the segment ABOVE the aux segment), or
 *  "" when the aux segment is the path root. Deterministic: first occurrence wins
 *  (paths processed in input order; all members of one aggregate share a host in
 *  practice — when they don't, the first is a stable representative). */
export function aggregateDirs(
  paths: readonly string[],
  segments: ReadonlySet<string> = DEFAULT_AUXILIARY_SEGMENTS,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    if (!p) continue;
    const parts = p.split("/");
    const i = auxIndex(parts, segments);
    if (i === -1) continue;
    const id = aggregateIdFor(p, segments)!;
    if (out.has(id)) continue;
    out.set(id, i > 0 ? parts[i - 1]! : "");
  }
  return out;
}

/** Aggregate id → (frameId → edge count). Counts CALLS/USAGE/IMPORTS edges where
 *  one endpoint is an aggregate member file and the other resolves to a frame. */
export function buildAggregateEdgeTies(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  segments: ReadonlySet<string> = DEFAULT_AUXILIARY_SEGMENTS,
): Map<string, Map<number, number>> {
  const auxPaths: string[] = [];
  for (const n of nodes) if (n.kind === "file" && n.file_path) auxPaths.push(n.file_path);
  const pathToAgg = buildAggregatePathIndex(auxPaths, segments);
  const frameByNode = buildNodeFrameIndex(nodes); // nodeId → frameId (framed files only)
  // nodeId → its file's aggregate id (aux files only).
  const aggByNode = new Map<string, string>();
  const pathByNode = new Map<string, string>();
  for (const n of nodes) {
    if (!n.file_path) continue;
    pathByNode.set(n.id, n.file_path);
    const agg = pathToAgg.get(n.file_path);
    if (agg) aggByNode.set(n.id, agg);
  }
  const out = new Map<string, Map<number, number>>();
  const tally = (agg: string, frame: number) => {
    let m = out.get(agg);
    if (!m) { m = new Map(); out.set(agg, m); }
    m.set(frame, (m.get(frame) ?? 0) + 1);
  };
  for (const e of edges) {
    if (!ROLLUP_RELATIONS.has(e.relation)) continue;
    const aggS = aggByNode.get(e.source_id), frameT = frameByNode.get(e.target_id);
    if (aggS !== undefined && frameT !== undefined) tally(aggS, frameT);
    const aggT = aggByNode.get(e.target_id), frameS = frameByNode.get(e.source_id);
    if (aggT !== undefined && frameS !== undefined) tally(aggT, frameS);
  }
  return out;
}

/** frameId → representative directory (the most common top-level path segment of
 *  its member files; ties broken by lexical order). */
export function frameRepDirs(nodes: readonly NodeRow[]): Map<number, string> {
  const counts = new Map<number, Map<string, number>>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    let fid: number | undefined;
    try { fid = (JSON.parse(n.data) as { frame_id?: number }).frame_id; } catch { continue; }
    if (typeof fid !== "number") continue;
    const top = n.file_path.split("/")[0] ?? "";
    let m = counts.get(fid);
    if (!m) { m = new Map(); counts.set(fid, m); }
    m.set(top, (m.get(top) ?? 0) + 1);
  }
  const out = new Map<number, string>();
  for (const [fid, m] of counts) {
    let best = "", bestN = -1;
    for (const [dir, n] of [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (n > bestN) { best = dir; bestN = n; }
    }
    out.set(fid, best);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mcp-server/aggregate-ties.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/aggregate-ties.ts tests/mcp-server/aggregate-ties.test.ts
git commit -m "feat(layout): build aggregate→frame edge + path ties"
```

---

## Task 4: Aggregate placement (edge → path → margin cascade)

**Files:**
- Modify: `src/mcp-server/floating-placement.ts` (add `placeAggregates`)
- Test: `tests/mcp-server/floating-placement.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// append to tests/mcp-server/floating-placement.test.ts
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
    const p = out.get("aux:locales:locales")!;
    expect(p.x).toBe(350); // (200*3 + 800*1)/4
  });

  it("falls back to path tie when there are no edges", () => {
    // host dir "app" matches frame 1's repDir "app" → centroid of {frame 1}.
    const aggDirs = new Map([["aux:locales:locales", "app"]]);
    const out = placeAggregates(
      [{ id: "aux:locales:locales", member_count: 2 }],
      new Map(), aggDirs, frameRepDirsMap, ambientPositions, ambientBoxes,
    );
    const p = out.get("aux:locales:locales")!;
    expect(p.x).toBe(200);
  });

  it("falls back to a margin slot when neither edge nor path ties resolve", () => {
    const out = placeAggregates(
      [{ id: "aux:vendor:vendor", member_count: 9 }],
      new Map(), new Map([["aux:vendor:vendor", "nonexistent"]]), frameRepDirsMap,
      ambientPositions, ambientBoxes,
    );
    expect(out.get("aux:vendor:vendor")!.y).toBe(800 - 28); // MARGIN_Y
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/mcp-server/floating-placement.test.ts -t placeAggregates`
Expected: FAIL — `placeAggregates` not exported.

- [ ] **Step 3: Implement `placeAggregates`**

```ts
// append to src/mcp-server/floating-placement.ts

/** Position each aggregate via the edge→path→margin tie cascade, relative to the
 *  AMBIENT frame positions. Aggregates tie only to ambient frames (stable
 *  anchors). Returns aggregate id → integer center {x, y}. */
export function placeAggregates(
  aggregates: readonly { id: string; member_count: number }[],
  edgeTies: Map<string, Map<number, number>>,
  aggregateDirs: Map<string, string>,
  frameRepDirs: Map<number, string>,
  ambientPositions: readonly { id: number; x: number; y: number }[],
  ambientBoxes: readonly Box[],
): Map<string, { x: number; y: number }> {
  const ambientPos = new Map(ambientPositions.map((p) => [p.id, p]));
  // Deterministic order by id so margin-slot indices are stable.
  const ordered = [...aggregates].sort((a, b) => a.id.localeCompare(b.id));

  const edgeCentroid = (id: string): { x: number; y: number } | null => {
    const ties = edgeTies.get(id);
    if (!ties) return null;
    const anchors: WeightedAnchor[] = [];
    for (const [fid, w] of ties) {
      const p = ambientPos.get(fid);
      if (p) anchors.push({ x: p.x, y: p.y, weight: w });
    }
    return weightedCentroid(anchors);
  };
  const pathCentroid = (id: string): { x: number; y: number } | null => {
    const host = aggregateDirs.get(id);
    if (!host) return null;
    const anchors: WeightedAnchor[] = [];
    for (const p of ambientPositions) {
      if (frameRepDirs.get(p.id) === host) anchors.push({ x: p.x, y: p.y, weight: 1 });
    }
    return weightedCentroid(anchors);
  };

  // First pass: resolve a seed (or mark tie-less for margin slotting).
  const seeds = new Map<string, { x: number; y: number } | null>();
  for (const a of ordered) seeds.set(a.id, edgeCentroid(a.id) ?? pathCentroid(a.id));
  const tieless = ordered.filter((a) => seeds.get(a.id) === null).map((a) => a.id);
  const tielessIndex = new Map(tieless.map((id, i) => [id, i]));

  const out = new Map<string, { x: number; y: number }>();
  for (const a of ordered) {
    const seed = seeds.get(a.id) ?? marginSlot(tielessIndex.get(a.id)!, tieless.length, AGG_RADIUS * 2);
    out.set(a.id, repelFromBoxes(seed.x, seed.y, AGG_RADIUS * 2, ambientBoxes));
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/mcp-server/floating-placement.test.ts`
Expected: PASS (all `placeAggregates` cases + earlier).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/floating-placement.ts tests/mcp-server/floating-placement.test.ts
git commit -m "feat(layout): place aggregates via edge→path→margin cascade"
```

---

## Task 5: Serve positioned aggregates from `/api/aggregates`

**Files:**
- Modify: `src/mcp-server/api.ts` (the `/api/aggregates` handler, ~lines 302–320)
- Modify: `src/frame-extraction/auxiliary-detection.ts` (extend `Aggregate` with optional `x`/`y`)
- Test: `tests/api/aggregates-positioned.test.ts`

- [ ] **Step 1: Extend the `Aggregate` type with positions**

In `src/frame-extraction/auxiliary-detection.ts`, add two optional fields to the `Aggregate` interface (after `sample_paths`):

```ts
  /** Integer virtual-stage px (center), set by the server's floating placement.
   *  Absent on the raw grouping output; populated by /api/aggregates. */
  x?: number;
  y?: number;
```

(`groupAuxiliaryPaths` leaves them undefined; the endpoint fills them. No behavior change for existing callers/tests.)

- [ ] **Step 2: Write the failing API test**

```ts
// tests/api/aggregates-positioned.test.ts
import { describe, it, expect } from "vitest";
import { positionAggregates } from "../../src/mcp-server/api.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

// positionAggregates(nodes, edges, frameMap) is the pure helper extracted from
// the /api/aggregates handler. It returns Aggregate[] with x/y populated.
const fileNode = (id: string, file_path: string, frame_id?: number): NodeRow => ({
  id, kind: "file", file_path, name: file_path, qualified_name: file_path,
  data: frame_id === undefined ? "{}" : JSON.stringify({ frame_id, frame_label: `f${frame_id}` }),
} as NodeRow);

describe("positionAggregates", () => {
  it("attaches integer x/y to each aggregate", () => {
    const nodes: NodeRow[] = [
      fileNode("a", "app/locales/en.json"),
      fileNode("f1", "app/ui/menu.ts", 1),
    ];
    const edges: EdgeRow[] = [{ source_id: "f1", target_id: "a", relation: "USAGE" } as EdgeRow];
    const frameMap = { frames: [{ id: 1, ambient: true, x: 200, y: 300, w: 120, h: 120 }], stage: { w: 1000, h: 800 } } as any;
    const aggs = positionAggregates(nodes, edges, frameMap);
    const a = aggs.find((x) => x.id === "aux:locales:locales")!;
    expect(Number.isInteger(a.x)).toBe(true);
    expect(Number.isInteger(a.y)).toBe(true);
    expect(a.x).toBe(200); // edge-tied to frame 1
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run tests/api/aggregates-positioned.test.ts`
Expected: FAIL — `positionAggregates` not exported from `api.ts`.

- [ ] **Step 4: Implement `positionAggregates` and call it in the handler**

In `src/mcp-server/api.ts`, add imports near the top (with the other `./` imports):

```ts
import { groupAuxiliaryPaths } from "../frame-extraction/auxiliary-detection.js";
import { buildAggregateEdgeTies, aggregateDirs, frameRepDirs } from "./aggregate-ties.js";
import { placeAggregates } from "./floating-placement.js";
import { buildFrameMap, type FrameMap } from "./frame-map.js";
```

(If `groupAuxiliaryPaths` / `buildFrameMap` are already imported, don't duplicate.)

Add this exported helper (top-level in the module, near other helpers):

```ts
/** Build positioned aggregates: group auxiliary paths, then place each at its
 *  edge→path→margin gravity centroid relative to the frame map's AMBIENT frames.
 *  Pure given (nodes, edges, frameMap). */
export function positionAggregates(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  frameMap: FrameMap,
) {
  const paths: string[] = [];
  for (const n of nodes) if (n.kind === "file" && n.file_path) paths.push(n.file_path);
  const aggregates = groupAuxiliaryPaths(paths);
  const ambient = frameMap.frames.filter((f) => f.ambient && f.x !== null && f.y !== null);
  const ambientPositions = ambient.map((f) => ({ id: f.id, x: f.x as number, y: f.y as number }));
  const ambientBoxes = ambient.map((f) => ({ id: f.id, x: f.x as number, y: f.y as number, w: f.w as number, h: f.h as number }));
  const edgeTies = buildAggregateEdgeTies(nodes, edges);
  const dirs = aggregateDirs(paths);
  const repDirs = frameRepDirs(nodes);
  const pos = placeAggregates(aggregates, edgeTies, dirs, repDirs, ambientPositions, ambientBoxes);
  return aggregates.map((a) => {
    const p = pos.get(a.id);
    return p ? { ...a, x: p.x, y: p.y } : a;
  });
}
```

Then change the `/api/aggregates` handler body (the `try { ... }` at ~lines 308–318) to fetch edges and use the helper:

```ts
        try {
          const edges = resolved ? resolved.store.getAllEdgesUnified(project ?? undefined) : [];
          const frameMap = buildFrameMap(nodes, edges);
          const aggregates = positionAggregates(nodes, edges, frameMap);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ aggregates }));
        } finally {
```

(`nodes` is already fetched at line 307. `getAllEdgesUnified` is the sibling of the existing `getAllNodesUnified` call — confirm the exact name in `src/graph/store.ts`; it is the same method used by the `/api/frames` handler at api.ts:340.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/api/aggregates-positioned.test.ts`
Expected: PASS.

Run: `npx vitest run tests/api` and `npx tsc --noEmit` — Expected: green (existing aggregate API tests still pass; the extra x/y fields are additive).

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/api.ts src/frame-extraction/auxiliary-detection.ts tests/api/aggregates-positioned.test.ts
git commit -m "feat(api): serve aggregates at their gravity-centroid positions"
```

---

## Task 6: Viewer — render satellites at server positions, remove strips

**Files:**
- Modify: `src/viewer/viewer.js` (`loadGraph` frame mapping; `drawAggregates`)
- Modify: `src/viewer/adapters.js` (`withGovernedFramesRendered`)

This is a UI-visible change → **Gate 0 visual QA required** after implementation.

- [ ] **Step 1: Include non-ambient governed frames at their server position (de-emphasized)**

In `src/viewer/viewer.js` `loadGraph` (lines 136–147), the `FRAMES` map currently keeps only ambient frames. Change it to also retain non-ambient frames that now carry a server position, tagging non-ambient ones for de-emphasized rendering:

```ts
    const stage = frameMap.stage || { w: 1000, h: 800 };
    FRAMES = (frameMap.frames || [])
      .filter((f) => f.x !== null && f.y !== null) // ambient + positioned non-ambient
      .map((f) => ({
        id: String(f.id),
        name: f.name,
        x: f.x / stage.w,
        y: f.y / stage.h,
        w: f.w,
        h: f.h,
        count: f.count,
        layer: f.layer,
        deemphasized: !f.ambient, // non-ambient satellites render smaller / faded
      }));
```

- [ ] **Step 2: Reduce `withGovernedFramesRendered` to selection-only**

In `src/viewer/adapters.js`, the governed frames are now already present in `FRAMES` *iff* the server positioned them (every non-ambient frame is positioned, so they always are). The strip-layout promotion is obsolete. Replace the body of `withGovernedFramesRendered` (lines 123–146) with a guard that only promotes a governed frame **still** missing (e.g. a frame with no server position at all — the degenerate zero-ambient case), keeping reachability without a strip:

```ts
export function withGovernedFramesRendered(ambientFrames, frameGovernance, frameMeta) {
  const present = new Set(ambientFrames.map((f) => String(f.id)));
  const missing = Object.keys(frameGovernance || {}).filter((id) => !present.has(String(id)));
  if (missing.length === 0) return ambientFrames;
  // Server-side floating placement positions every non-ambient frame, so a
  // governed frame is normally already in `ambientFrames`. This path now only
  // catches a governed frame the server didn't position at all (e.g. zero
  // ambient frames); place it deterministically in the bottom-right margin so
  // its decision still has an on-screen anchor. (Replaces the old top strip;
  // D-xwxj superseded by the gravity-centroid redesign.)
  const meta = frameMeta || new Map();
  const n = missing.length;
  const promoted = missing.map((id, i) => {
    const m = meta.get(String(id)) || {};
    return {
      id: String(id),
      name: m.name || `frame ${id}`,
      x: n === 1 ? 0.9 : 0.1 + (0.8 * i) / (n - 1),
      y: 0.93,
      w: m.w || PROMOTED_FRAME_W,
      h: m.h || PROMOTED_FRAME_H,
      count: m.count || 0,
      layer: m.layer,
      deemphasized: true,
      promotedForGovernance: true,
    };
  });
  return [...ambientFrames, ...promoted];
}
```

(Existing `adapters` tests asserting the promotion of missing frames still pass — the function still appends missing governed frames; only the default y-band moved and a `deemphasized` flag was added. Update any test asserting the exact `y: 0.07` to `y: 0.93`.)

- [ ] **Step 3: Render aggregates at server positions instead of the bottom strip**

In `src/viewer/viewer.js` `drawAggregates` (lines 1530–1571), replace the strip-slot positioning with the server's normalized position, mapped to canvas px the same way frames are (`agg.x` is virtual-stage px → normalize by stage, then × canvas size, with an edge clamp). Keep the dot + label + count rendering. Replace the slot/`stripTop` math:

```ts
  function drawAggregates(now) {
    if (!AGGREGATES || AGGREGATES.length === 0) return;
    const stageW = canvas.clientWidth;
    const stageH = canvas.clientHeight;
    const STAGE = { w: 1000, h: 800 }; // server virtual stage (matches frameMap.stage)
    let maxCount = 1;
    for (const a of AGGREGATES) if (a.member_count > maxCount) maxCount = a.member_count;

    ctx.save();
    for (let i = 0; i < AGGREGATES.length; i++) {
      const agg = AGGREGATES[i];
      const dotR = 5 + 10 * Math.sqrt(agg.member_count / maxCount);
      // Server position (virtual-stage px) → canvas px; fall back to a spread
      // along the bottom if the server didn't position this aggregate.
      const nx = typeof agg.x === "number" ? agg.x / STAGE.w : (i + 0.5) / Math.max(AGGREGATES.length, 1);
      const ny = typeof agg.y === "number" ? agg.y / STAGE.h : 0.96;
      const cx = Math.max(dotR + 4, Math.min(stageW - dotR - 4, nx * stageW));
      const cy = Math.max(dotR + 4, Math.min(stageH - dotR - 4, ny * stageH));

      const baseRgb = nodeBaseRGB();
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${baseRgb[0]},${baseRgb[1]},${baseRgb[2]},0.55)`;
      ctx.fill();
      ctx.strokeStyle = `rgba(${baseRgb[0]},${baseRgb[1]},${baseRgb[2]},0.9)`;
      ctx.lineWidth = 1;
      ctx.stroke();

      const labelRgb = subLabelRGB();
      ctx.fillStyle = `rgba(${labelRgb[0]},${labelRgb[1]},${labelRgb[2]},0.95)`;
      ctx.font = '10px "Geist Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(truncateMiddle(ctx, agg.label, 120), cx, cy + dotR + 6);

      const countRgb = countIdleRGB();
      ctx.fillStyle = `rgba(${countRgb[0]},${countRgb[1]},${countRgb[2]},0.9)`;
      ctx.font = '500 9px "Geist Mono", monospace';
      ctx.fillText(String(agg.member_count), cx, cy + dotR + 20);
    }
    ctx.restore();
  }
```

- [ ] **Step 4: De-emphasize satellite frames in `drawFrames`**

In `drawFrames` (starts line 1001), frames already iterate `FRAMES`. For each frame with `frame.deemphasized === true`, render at reduced opacity (e.g. multiply the frame fill/stroke alpha by ~0.5) so satellites read as secondary. Locate where the per-frame fill/stroke alpha is set in `drawFrames` and gate it:

```js
      const alphaMul = frame.deemphasized ? 0.5 : 1;
      // …apply alphaMul to the frame's fill + stroke + label alpha…
```

(The exact alpha expressions live in `drawFrames`; multiply each frame-body alpha by `alphaMul`. Satellites are already smaller via `SATELLITE_SIZE`/`w`.)

- [ ] **Step 5: Drop the bottom-strip reservation**

In `buildGraph`, `BOTTOM_MARGIN = 50` (line 391, "room for the aggregate strip") reserved space for the removed strip. Reduce it to match the normal edge margin so ambient frames can use the full stage:

```js
  const BOTTOM_MARGIN = 50; // → change to: const BOTTOM_MARGIN = EDGE_MARGIN;
```

- [ ] **Step 6: Gate 0 — visual QA (required)**

Start the dev server (hold stdin open) and drive the viewer:

```bash
cd /Users/rka/Development/cortex-wt-floating-entity
tail -f /dev/null | npm run dev > .tmp-dev.log 2>&1 &
```

Then, via Playwright MCP: navigate to `http://localhost:3334/viewer`, screenshot to `.tmp/`, check console for errors. Switch project to one with governed frames (cortex) and one with aggregates. Verify:
- No fixed top strip and no fixed bottom strip.
- Decision-governed non-ambient frames render *near* related ambient frames (de-emphasized), and their decision pills still attach on focus.
- Aggregates render near related frames (or in the bottom-right margin when tie-less); count badges intact.
- No overlap/clamp pathology; zero console errors.

Screenshots → `.tmp/` only. Document any aesthetic issues (non-blocking); block on runtime errors or broken rendering.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/viewer.js src/viewer/adapters.js
git commit -m "feat(viewer): render floating frames + aggregates at server positions, drop strips"
```

---

## Task 7: Supersede D-xwxj + living docs + release

**Files:**
- Modify: `CHANGELOG.md`, `HANDOFF.md`, `docs/specs/progress.md`, `docs/architecture/graph-ui.md`
- Modify: `package.json`, `plugin.json`, `.claude-plugin/marketplace.json`
- Decision: supersede `D-xwxj`

- [ ] **Step 1: Supersede the D-xwxj stopgap with a new decision**

Use the Cortex MCP tools (repo_path = the worktree path). Create the new decision capturing the server-side gravity-centroid placement (edge→path→margin cascade, selection-stays-client / position-from-server governance decoupling, layout-strategy seam), then supersede:

```
search_decisions({ query: "floating entity aggregate governed frame placement", repo_path })
create_decision({ title: "Server-side gravity-centroid placement for floating entities", description, rationale, alternatives, governs: ["src/mcp-server/floating-placement.ts", "src/mcp-server/aggregate-ties.ts", "src/viewer/viewer.js", "src/viewer/adapters.js"], repo_path })
supersede_decision({ decision_id: "D-xwxj", superseded_by: <new id>, repo_path })
```

- [ ] **Step 2: Version bump (patch → 0.3.23) + CHANGELOG**

Bump all three version fields (`package.json`, `plugin.json`, `.claude-plugin/marketplace.json`) 0.3.22 → 0.3.23. Add a `## [0.3.23] — <date>` CHANGELOG entry (Added: server-side floating-entity placement; Changed: viewer drops both fixed strips; superseded D-xwxj) + the `[0.3.23]:` link reference. Do NOT touch `CORTEX_INDEXER_VERSION`.

- [ ] **Step 3: Update living docs**

- `HANDOFF.md` — mark layout slice part 2 shipped; next item becomes the Louvain `concern` axis. Note D-xwxj superseded.
- `docs/specs/progress.md` — flip the "Floating-entity placement" row to ✅ Shipped (0.3.23); update the recommended-next-step list.
- `docs/architecture/graph-ui.md` — document `placeFloatingEntities`/`aggregate-ties`, the satellite render treatment, and that the two strips are gone.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(release): 0.3.23 — floating-entity placement"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** ✅ Non-ambient frame centroid (Task 2) · aggregate edge→path→margin cascade (Tasks 3–4) · frame-repulsion (Task 1) · serve positions (Task 5) · viewer drops strips + de-emphasis (Task 6) · governance decoupling, selection-stays-client (Tasks 2/6) · supersede D-xwxj (Task 7) · extensibility seam (placement depends only on ambient positions + ties — Tasks 1/2/4). Determinism + golden guard on ambient positions (Task 2 Step 8).

**Type consistency:** `Box`, `WeightedAnchor`, `placeNonAmbientFrames`, `placeAggregates` signatures are defined in Task 1/2/4 and consumed unchanged in Task 5. `Aggregate.x/y` added in Task 5 Step 1 before use. `FramePairWeight`/`buildNodeFrameIndex`/`ROLLUP_RELATIONS` imported from the real `frame-pair-rollup.ts`. `frameRepDirs`/`aggregateDirs`/`buildAggregateEdgeTies` names match across Tasks 3 and 5.

**Open verification deferred to implementer (named, not placeholders):** exact `getAllEdgesUnified` method name (confirm against api.ts:340, same call the `/api/frames` handler uses); the precise per-frame alpha expressions inside `drawFrames` (Task 6 Step 4) — multiply each by `alphaMul`.

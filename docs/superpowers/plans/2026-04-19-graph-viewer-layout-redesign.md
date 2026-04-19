# Graph Viewer Layout Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the revised layout from [2026-04-19 layout redesign spec](../specs/2026-04-19-graph-viewer-layout-redesign-design.md) — structure-primary band table, circular layout, consistent viewport footprint, search that navigates, mode-aware pan/zoom.

**Architecture:** Keep the existing pure-module layout (`src/viewer/shared/*.js`). Add three new d3-force plugins (`forceBoundary`, `forceGroup`, `forceGovernance`) plus an adaptive scaling helper in `layout.js`. Replace the projection's `BAND_TABLE`. Extend `sizing.js` with label-fit supernode dimensions. Extend `camera.js` with mode state + auto-fit. Extend `search.js` from predicate-only to a full match-list + camera-integration helper. Touch `graph-viewer-2d.js` to wire it all together.

**Tech Stack:** Vanilla JS ESM, d3-force@3, vitest, canvas 2D. No new dependencies.

**Branch:** `feature/viewer/layout-redesign` (already created; spec committed).

**Test runner:** `npm test` (vitest run). Single file: `npm test -- tests/viewer/layout.test.ts`.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/viewer/shared/layout.js` | modify | d3-force config + new forces + adaptive scaling |
| `src/viewer/shared/sizing.js` | modify | + `supernodeDims(label)` for label-fit sizing |
| `src/viewer/shared/groups.js` | modify | + depth-2 collapse when band requests it |
| `src/viewer/shared/projection.js` | modify | revised `BAND_TABLE`; inject `boxW/boxH` into group reps |
| `src/viewer/shared/camera.js` | modify | + mode state, save/restore, auto-fit trigger |
| `src/viewer/shared/search.js` | modify | + `findMatches()` returning list with positions |
| `src/viewer/shared/transitions.js` | modify | + aggregate-edge cross-fade; verify re-parenting |
| `src/viewer/graph-viewer-2d.js` | modify | wire mode-aware wheel, auto-fit, search picker chip, mode indicator |
| `src/viewer/style.css` | modify | + search-chip + mode-indicator styles |
| `tests/viewer/layout.test.ts` | modify | tests for new forces + adaptive scaling |
| `tests/viewer/sizing.test.ts` | modify | tests for `supernodeDims` |
| `tests/viewer/groups.test.ts` | modify | tests for depth-2 collapse |
| `tests/viewer/projection.test.ts` | modify | tests for revised band table |
| `tests/viewer/camera.test.ts` | modify | tests for mode + save/restore |
| `tests/viewer/search.test.ts` | modify | tests for `findMatches` |
| `tests/viewer/transitions.test.ts` | modify | tests for aggregate cross-fade |

No new files — all changes are additions to existing modules that already follow the right boundary.

---

## Phase 1 — New force primitives (pure, TDD)

These three forces are the core of the redesign. They're pure functions that take a strength scalar and return a d3-force plugin. All testable without a running simulation.

### Task 1: `forceBoundary` — soft outer containment

**Files:**
- Modify: `src/viewer/shared/layout.js` (add new export)
- Modify: `tests/viewer/layout.test.ts` (add test block)

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/layout.test.ts`, after the existing `createSimulation` block:

```typescript
import { forceBoundary } from '../../src/viewer/shared/layout.js';

describe('forceBoundary', () => {
  it('applies zero force to a node inside the radius', () => {
    const n = { x: 50, y: 0, vx: 0, vy: 0 };
    const f = forceBoundary(100, 1.0, 0, 0);
    f.initialize([n]);
    f(0.5); // alpha = 0.5
    expect(n.vx).toBe(0);
    expect(n.vy).toBe(0);
  });

  it('applies inward spring force to a node outside the radius', () => {
    const n = { x: 200, y: 0, vx: 0, vy: 0 };  // 100 units outside R=100
    const f = forceBoundary(100, 1.0, 0, 0);
    f.initialize([n]);
    f(0.5);
    expect(n.vx).toBeLessThan(0);       // pushed back toward center
    expect(n.vy).toBe(0);                // no vertical component (on axis)
  });

  it('scales strength with excess distance (farther = stronger pull)', () => {
    const near = { x: 110, y: 0, vx: 0, vy: 0 };   // 10 outside
    const far  = { x: 200, y: 0, vx: 0, vy: 0 };   // 100 outside
    const f = forceBoundary(100, 1.0, 0, 0);
    f.initialize([near, far]);
    f(1.0);
    expect(Math.abs(far.vx)).toBeGreaterThan(Math.abs(near.vx));
  });

  it('.radius(r) setter updates the active radius', () => {
    const n = { x: 150, y: 0, vx: 0, vy: 0 };
    const f = forceBoundary(100, 1.0, 0, 0);
    f.initialize([n]);
    f(1.0);
    const pushAt100 = n.vx;
    n.vx = 0;
    f.radius(200);                        // widen radius — now node is inside
    f(1.0);
    expect(n.vx).toBe(0);
    expect(pushAt100).toBeLessThan(0);
  });

  it('.strength(s) setter scales force magnitude', () => {
    const n1 = { x: 200, y: 0, vx: 0, vy: 0 };
    const n2 = { x: 200, y: 0, vx: 0, vy: 0 };
    const f1 = forceBoundary(100, 1.0, 0, 0);
    const f2 = forceBoundary(100, 2.0, 0, 0);
    f1.initialize([n1]); f2.initialize([n2]);
    f1(1.0); f2(1.0);
    expect(Math.abs(n2.vx)).toBeCloseTo(Math.abs(n1.vx) * 2, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: FAIL with `forceBoundary is not defined` (import error).

- [ ] **Step 3: Implement `forceBoundary` in `layout.js`**

Append to `src/viewer/shared/layout.js`. Setters must be regular functions
(not arrows) so `arguments.length` works for the d3-style get/set idiom:

```js
/**
 * Soft outer containment force. Nodes inside `radius` feel zero force;
 * nodes outside feel an inward spring whose magnitude scales with how far
 * past the radius they are. Pairs with group gravity to produce a circular
 * layout with free interior placement.
 *
 *   radius   — containment radius in world units
 *   strength — spring constant (default 0.8)
 *   cx, cy   — center point in world units (default 0, 0)
 */
export function forceBoundary(radius, strength = 0.8, cx = 0, cy = 0) {
  let nodes;
  function f(alpha) {
    for (const n of nodes) {
      const dx = n.x - cx;
      const dy = n.y - cy;
      const d = Math.hypot(dx, dy);
      if (d > radius) {
        const excess = d - radius;
        const factor = strength * alpha * (excess / d);
        n.vx -= dx * factor;
        n.vy -= dy * factor;
      }
    }
  }
  f.initialize = function(_nodes) { nodes = _nodes; };
  f.strength = function(s) { if (arguments.length) { strength = s; return f; } return strength; };
  f.radius = function(r) { if (arguments.length) { radius = r; return f; } return radius; };
  return f;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: all 5 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/layout.js tests/viewer/layout.test.ts
git commit -m "feat(viewer): forceBoundary — soft outer containment"
```

---

### Task 2: `forceGroup` — sibling clumping

**Files:**
- Modify: `src/viewer/shared/layout.js`
- Modify: `tests/viewer/layout.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/layout.test.ts`:

```typescript
import { forceGroup } from '../../src/viewer/shared/layout.js';

describe('forceGroup', () => {
  it('pulls non-super nodes toward their group centroid', () => {
    const a = { id: 'a', kind: 'file', group: 'g1', x: 0,   y: 0,   vx: 0, vy: 0 };
    const b = { id: 'b', kind: 'file', group: 'g1', x: 100, y: 0,   vx: 0, vy: 0 };
    const c = { id: 'c', kind: 'file', group: 'g1', x: 50,  y: 100, vx: 0, vy: 0 };
    const f = forceGroup(0.5);
    f.initialize([a, b, c]);
    f(1.0);
    // centroid of g1 = (50, 33.33). 'a' at (0,0) should be pulled toward it.
    expect(a.vx).toBeGreaterThan(0);    // pulled rightward
    expect(a.vy).toBeGreaterThan(0);    // pulled downward
  });

  it('does not pull supernodes themselves', () => {
    const sup = { id: 'g1', kind: 'group', group: 'g1', x: 0, y: 0, vx: 0, vy: 0 };
    const leaf = { id: 'a', kind: 'file', group: 'g1', x: 100, y: 0, vx: 0, vy: 0 };
    const f = forceGroup(0.5);
    f.initialize([sup, leaf]);
    f(1.0);
    expect(sup.vx).toBe(0);
    expect(sup.vy).toBe(0);
  });

  it('ignores nodes with no group', () => {
    const n = { id: 'x', kind: 'decision', group: null, x: 50, y: 50, vx: 0, vy: 0 };
    const f = forceGroup(0.5);
    f.initialize([n]);
    f(1.0);
    expect(n.vx).toBe(0);
    expect(n.vy).toBe(0);
  });

  it('.strength(s) scales force magnitude linearly', () => {
    const mk = () => ([
      { id: 'a', kind: 'file', group: 'g', x: 0,   y: 0, vx: 0, vy: 0 },
      { id: 'b', kind: 'file', group: 'g', x: 100, y: 0, vx: 0, vy: 0 },
    ]);
    const ns1 = mk();  const f1 = forceGroup(0.3); f1.initialize(ns1); f1(1.0);
    const ns2 = mk();  const f2 = forceGroup(0.6); f2.initialize(ns2); f2(1.0);
    expect(Math.abs(ns2[0].vx)).toBeCloseTo(Math.abs(ns1[0].vx) * 2, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: FAIL — `forceGroup is not defined`.

- [ ] **Step 3: Implement `forceGroup` in `layout.js`**

Append to `src/viewer/shared/layout.js`:

```js
/**
 * Group gravity. Each non-supernode with a `group` property feels a pull
 * toward its group's centroid (computed from peers sharing the same group).
 * Supernodes do NOT feel this force — they're the anchors peers pull toward.
 * Nodes without a group are untouched.
 *
 *   strength — default 0.35
 */
export function forceGroup(strength = 0.35) {
  let nodes;
  function f(alpha) {
    const centroids = new Map();
    for (const n of nodes) {
      if (!n.group) continue;
      let c = centroids.get(n.group);
      if (!c) { c = { x: 0, y: 0, count: 0 }; centroids.set(n.group, c); }
      c.x += n.x; c.y += n.y; c.count += 1;
    }
    for (const c of centroids.values()) { c.x /= c.count; c.y /= c.count; }
    for (const n of nodes) {
      if (!n.group || n.kind === 'group') continue;
      const c = centroids.get(n.group);
      if (!c) continue;
      n.vx += (c.x - n.x) * strength * alpha;
      n.vy += (c.y - n.y) * strength * alpha;
    }
  }
  f.initialize = function(_nodes) { nodes = _nodes; };
  f.strength = function(s) { if (arguments.length) { strength = s; return f; } return strength; };
  return f;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/layout.js tests/viewer/layout.test.ts
git commit -m "feat(viewer): forceGroup — sibling clumping toward group centroid"
```

---

### Task 3: `forceGovernance` — decisions toward territories

**Files:**
- Modify: `src/viewer/shared/layout.js`
- Modify: `tests/viewer/layout.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/layout.test.ts`:

```typescript
import { forceGovernance } from '../../src/viewer/shared/layout.js';

describe('forceGovernance', () => {
  it('pulls a decision toward the centroid of its governed nodes', () => {
    const d = { id: 'd1', kind: 'decision', governs: ['a', 'b'], x: 0, y: 0, vx: 0, vy: 0 };
    const a = { id: 'a', kind: 'group', x: 100, y: 0, vx: 0, vy: 0 };
    const b = { id: 'b', kind: 'group', x: 100, y: 100, vx: 0, vy: 0 };
    const f = forceGovernance(0.5);
    f.initialize([d, a, b]);
    f(1.0);
    expect(d.vx).toBeGreaterThan(0);    // territory centroid is at (100, 50)
    expect(d.vy).toBeGreaterThan(0);
  });

  it('leaves decisions with empty territory alone (no NaN, no drift)', () => {
    const d = { id: 'd1', kind: 'decision', governs: [], x: 10, y: 10, vx: 0, vy: 0 };
    const f = forceGovernance(0.5);
    f.initialize([d]);
    f(1.0);
    expect(d.vx).toBe(0);
    expect(d.vy).toBe(0);
    expect(Number.isNaN(d.vx)).toBe(false);
  });

  it('ignores governs members that are not in the node set', () => {
    const d = { id: 'd1', kind: 'decision', governs: ['ghost', 'a'], x: 0, y: 0, vx: 0, vy: 0 };
    const a = { id: 'a', kind: 'group', x: 100, y: 0, vx: 0, vy: 0 };
    const f = forceGovernance(0.5);
    f.initialize([d, a]);
    f(1.0);
    // Only 'a' counts → pull toward (100, 0)
    expect(d.vx).toBeGreaterThan(0);
    expect(d.vy).toBe(0);
  });

  it('does not affect non-decision nodes', () => {
    const file = { id: 'f', kind: 'file', governs: ['a'], x: 0, y: 0, vx: 0, vy: 0 };
    const a = { id: 'a', kind: 'group', x: 100, y: 0, vx: 0, vy: 0 };
    const f = forceGovernance(0.5);
    f.initialize([file, a]);
    f(1.0);
    expect(file.vx).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: FAIL — `forceGovernance is not defined`.

- [ ] **Step 3: Implement in `layout.js`**

Append to `src/viewer/shared/layout.js`:

```js
/**
 * Governance gravity. Each decision is pulled toward the centroid of its
 * `governs` targets that are currently in the node set. A decision with
 * no visible territory feels no force (no drift, no NaN).
 *
 *   strength — default 0.25
 */
export function forceGovernance(strength = 0.25) {
  let nodes;
  function f(alpha) {
    const byId = new Map();
    for (const n of nodes) byId.set(n.id, n);
    for (const n of nodes) {
      if (n.kind !== 'decision') continue;
      let tx = 0, ty = 0, count = 0;
      for (const targetId of (n.governs || [])) {
        const t = byId.get(targetId);
        if (t) { tx += t.x; ty += t.y; count += 1; }
      }
      if (count === 0) continue;
      tx /= count; ty /= count;
      n.vx += (tx - n.x) * strength * alpha;
      n.vy += (ty - n.y) * strength * alpha;
    }
  }
  f.initialize = function(_nodes) { nodes = _nodes; };
  f.strength = function(s) { if (arguments.length) { strength = s; return f; } return strength; };
  return f;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/layout.js tests/viewer/layout.test.ts
git commit -m "feat(viewer): forceGovernance — decisions pulled toward territory centroid"
```

---

### Task 4: Adaptive scaling helper

Rationale: link distance + charge must scale with visible N so the graph's natural radius stays ≈ target across bands. Use `adapt = 50 / sqrt(max(1, N))`. Separate helper for readability + testing.

**Files:**
- Modify: `src/viewer/shared/layout.js`
- Modify: `tests/viewer/layout.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/layout.test.ts`:

```typescript
import { adaptiveScale } from '../../src/viewer/shared/layout.js';

describe('adaptiveScale', () => {
  it('returns a larger factor for fewer nodes (spread them more)', () => {
    expect(adaptiveScale(10)).toBeGreaterThan(adaptiveScale(100));
  });

  it('follows 50 / sqrt(N)', () => {
    expect(adaptiveScale(25)).toBeCloseTo(10, 5);
    expect(adaptiveScale(100)).toBeCloseTo(5, 5);
  });

  it('guards against N=0', () => {
    expect(adaptiveScale(0)).toBe(50);
    expect(Number.isNaN(adaptiveScale(0))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: FAIL — `adaptiveScale is not defined`.

- [ ] **Step 3: Implement**

Append to `src/viewer/shared/layout.js`:

```js
/**
 * Scale factor for link distance + charge, inversely proportional to
 * sqrt(N visible). Keeps the graph's natural radius ≈ constant across
 * bands as the visible node count changes.
 */
export function adaptiveScale(visibleCount) {
  return 50 / Math.sqrt(Math.max(1, visibleCount));
}
```

- [ ] **Step 4: Run test**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/layout.js tests/viewer/layout.test.ts
git commit -m "feat(viewer): adaptiveScale — node-count-aware force scaling"
```

---

## Phase 2 — Supernode sizing by label

### Task 5: `supernodeDims(label)` in `sizing.js`

**Files:**
- Modify: `src/viewer/shared/sizing.js`
- Modify: `tests/viewer/sizing.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/sizing.test.ts`:

```typescript
import { supernodeDims } from '../../src/viewer/shared/sizing.js';

describe('supernodeDims', () => {
  it('returns wider box for longer labels', () => {
    const short = supernodeDims('ws/');
    const long  = supernodeDims('docs/superpowers/');
    expect(long.w).toBeGreaterThan(short.w);
  });

  it('enforces minimum width of 32', () => {
    const dim = supernodeDims('a/');
    expect(dim.w).toBeGreaterThanOrEqual(32);
  });

  it('has constant height', () => {
    expect(supernodeDims('ws/').h).toBe(supernodeDims('docs/superpowers/').h);
    expect(supernodeDims('x').h).toBe(20);
  });

  it('radius fits the box (≥ half its diagonal / 2)', () => {
    const d = supernodeDims('src/events/');
    expect(d.radius).toBeGreaterThanOrEqual(Math.max(d.w, d.h) / 2);
  });

  it('works in node (no DOM canvas) via fallback measurement', () => {
    // vitest runs in node by default — measureText unavailable. Should still
    // return a plausible width proportional to character count.
    const a = supernodeDims('aaaa/');
    const b = supernodeDims('aaaaaaaa/');
    expect(b.w).toBeGreaterThan(a.w);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/sizing.test.ts`
Expected: FAIL — `supernodeDims is not defined`.

- [ ] **Step 3: Implement**

Append to `src/viewer/shared/sizing.js`:

```js
/**
 * Supernode dimensions derived from label width. Returns the bounding box
 * (w×h) and a radius that fits the diagonal — used by collide force and
 * render to keep labels legible regardless of path length.
 *
 * Uses OffscreenCanvas measureText in browsers; falls back to a
 * char-count estimate in node (tests) so this stays pure.
 */
const SN_FONT = '11px -apple-system, BlinkMacSystemFont, sans-serif';
const SN_MIN_W = 32;
const SN_H = 20;
const SN_H_PAD = 18;

let _measureCtx = null;
function measureLabel(text) {
  if (typeof OffscreenCanvas !== 'undefined') {
    if (!_measureCtx) _measureCtx = new OffscreenCanvas(8, 8).getContext('2d');
    _measureCtx.font = SN_FONT;
    return _measureCtx.measureText(text).width;
  }
  if (typeof document !== 'undefined') {
    if (!_measureCtx) _measureCtx = document.createElement('canvas').getContext('2d');
    _measureCtx.font = SN_FONT;
    return _measureCtx.measureText(text).width;
  }
  // Node / vitest fallback: ~6px per char at 11px font.
  return text.length * 6;
}

export function supernodeDims(label) {
  const tw = measureLabel(String(label));
  const w = Math.max(SN_MIN_W, Math.round(tw + SN_H_PAD));
  const h = SN_H;
  const radius = Math.hypot(w, h) / 2;
  return { w, h, radius };
}
```

- [ ] **Step 4: Run test**

Run: `npm test -- tests/viewer/sizing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/sizing.js tests/viewer/sizing.test.ts
git commit -m "feat(viewer): supernodeDims — label-fit rounded-rect sizing"
```

---

## Phase 3 — Band table inversion + projection wiring

### Task 6: Depth-cap option in `groups.js`

The current `derivePathGroups` collects groups at every directory depth. We need a mode where only depth-2 directories (relative to root — `src/events/`, `docs/superpowers/`) are kept, and deeper dirs collapse up into them.

**Files:**
- Modify: `src/viewer/shared/groups.js`
- Modify: `tests/viewer/groups.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/groups.test.ts`:

```typescript
import { derivePathGroups } from '../../src/viewer/shared/groups.js';

describe('derivePathGroups — depth-cap', () => {
  it('collapses deep paths into depth-2 parents when {depth: 2}', () => {
    const nodes = [
      { id: 'n1', kind: 'file', file_path: 'src/events/worker/persister.ts' },
      { id: 'n2', kind: 'file', file_path: 'src/events/worker/git-watcher.ts' },
      { id: 'n3', kind: 'file', file_path: 'src/events/bus.ts' },
      { id: 'n4', kind: 'file', file_path: 'src/viewer/shared/projection.js' },
    ];
    const groups = derivePathGroups(nodes, { depth: 2 });
    const ids = groups.map(g => g.id).filter(id => id.startsWith('group:path:'));
    expect(ids).toContain('group:path:src/events');
    expect(ids).toContain('group:path:src/viewer');
    // Deeper ones should NOT be emitted:
    expect(ids).not.toContain('group:path:src/events/worker');
    expect(ids).not.toContain('group:path:src/viewer/shared');
  });

  it('rolls up deep members into their depth-2 ancestor', () => {
    const nodes = [
      { id: 'n1', kind: 'file', file_path: 'src/events/worker/persister.ts' },
      { id: 'n2', kind: 'file', file_path: 'src/events/bus.ts' },
    ];
    const groups = derivePathGroups(nodes, { depth: 2 });
    const events = groups.find(g => g.id === 'group:path:src/events');
    expect(events.members).toEqual(expect.arrayContaining(['n1', 'n2']));
    expect(events.memberCount).toBe(2);
  });

  it('keeps existing behavior when no opts passed (backward compat)', () => {
    const nodes = [
      { id: 'n1', kind: 'file', file_path: 'src/events/worker/persister.ts' },
      { id: 'n2', kind: 'file', file_path: 'src/events/worker/git-watcher.ts' },
    ];
    const groups = derivePathGroups(nodes);
    const ids = groups.map(g => g.id);
    expect(ids).toContain('group:path:src/events/worker');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/groups.test.ts`
Expected: FAIL — depth cap not honored.

- [ ] **Step 3: Implement depth cap in `derivePathGroups`**

Modify `src/viewer/shared/groups.js`. Change the signature and directory-bucketing loop:

Replace the function signature:

```js
export function derivePathGroups(nodes, opts = {}) {
  const maxDepth = opts.depth ?? Infinity;
  const groups = new Map();
  // ... rest unchanged up to the dirMembers loop
```

And change the `dirMembers` bucketing to truncate paths to `maxDepth` segments:

```js
    const dir = dirOf(ownerFilePath);
    if (dir !== null) {
      const capped = capToDepth(dir, maxDepth);
      if (!dirMembers.has(capped)) dirMembers.set(capped, new Set());
      dirMembers.get(capped).add(n.id);
    }
```

Add the helper at the bottom, near `dirOf`:

```js
function capToDepth(dirPath, maxDepth) {
  if (!Number.isFinite(maxDepth)) return dirPath;
  const parts = dirPath.split('/');
  if (parts.length <= maxDepth) return dirPath;
  return parts.slice(0, maxDepth).join('/');
}
```

- [ ] **Step 4: Run test**

Run: `npm test -- tests/viewer/groups.test.ts`
Expected: all pass including the existing 2026-04-18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/groups.js tests/viewer/groups.test.ts
git commit -m "feat(viewer): derivePathGroups({depth}) — depth-cap for overview band"
```

---

### Task 7: Revise `BAND_TABLE` in `projection.js`

The new band table makes structure the primary floor. Decisions stay always-visible, but at overview we now emit depth-2 dir groups; at mid we emit depth-3; at close/detail, leaves as before.

**Files:**
- Modify: `src/viewer/shared/projection.js`
- Modify: `tests/viewer/projection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/projection.test.ts` (find a good place after other band tests):

```typescript
describe('BAND_TABLE — structure-primary', () => {
  const mkState = () => {
    const nodes = new Map();
    const add = (id, kind, extra = {}) => nodes.set(id, { id, kind, name: id, ...extra });
    add('d1', 'decision');
    add('f1', 'file',     { file_path: 'src/events/worker/a.ts' });
    add('f2', 'file',     { file_path: 'src/events/worker/b.ts' });
    add('f3', 'file',     { file_path: 'src/events/bus.ts' });
    add('f4', 'file',     { file_path: 'src/viewer/shared/x.ts' });
    add('f5', 'file',     { file_path: 'src/viewer/shared/y.ts' });
    add('f6', 'file',     { file_path: 'docs/architecture/ui.md' });
    add('f7', 'file',     { file_path: 'docs/architecture/events.md' });
    return { nodes, edges: new Map() };
  };
  const filters = new Set(['file', 'decision', 'function']);

  it('overview (≤0.4×) emits depth-2 dir supernodes + decisions', () => {
    const state = mkState();
    const { visibleNodes } = project(state, { zoom: 0.3, focus: null, filters, search: '' });
    const ids = [...visibleNodes.keys()];
    expect(ids).toContain('d1');
    expect(ids).toContain('group:path:src/events');
    expect(ids).toContain('group:path:src/viewer');
    expect(ids).toContain('group:path:docs/architecture');
    // Deeper supernodes should NOT be present at overview:
    expect(ids).not.toContain('group:path:src/events/worker');
    expect(ids).not.toContain('group:path:src/viewer/shared');
    // Leaves should NOT be present at overview:
    expect(ids).not.toContain('f1');
    expect(ids).not.toContain('f2');
  });

  it('mid (0.4–1.0×) emits depth-3 dir supernodes', () => {
    const state = mkState();
    const { visibleNodes } = project(state, { zoom: 0.7, focus: null, filters, search: '' });
    const ids = [...visibleNodes.keys()];
    expect(ids).toContain('group:path:src/events/worker');
    expect(ids).toContain('group:path:src/viewer/shared');
  });

  it('close (1.0–2.0×) emits leaf files', () => {
    const state = mkState();
    const { visibleNodes } = project(state, { zoom: 1.5, focus: null, filters, search: '' });
    const ids = [...visibleNodes.keys()];
    expect(ids).toContain('f1');
    expect(ids).toContain('f2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/projection.test.ts`
Expected: FAIL — existing BAND_TABLE doesn't emit dir supernodes at overview.

- [ ] **Step 3: Update `BAND_TABLE` and derivation call in `projection.js`**

Replace the existing `BAND_TABLE` export in `src/viewer/shared/projection.js` with:

```js
/**
 * Band table — structure-primary. Depth-2 dir supernodes form the backbone
 * at overview; decisions are always visible and positioned via governance
 * gravity (see layout.js) near their territories.
 *
 * dirDepth = max filesystem depth of emitted dir groups. Dir groups deeper
 * than dirDepth collapse up into their depth-`dirDepth` ancestor.
 */
export const BAND_TABLE = [
  { maxZoom: 0.4, visibleKinds: new Set(['decision']),
    dirDepth: 2, emitDirGroups: true, emitFileGroups: false, emitLeafFiles: false },
  { maxZoom: 1.0, visibleKinds: new Set(['decision']),
    dirDepth: 3, emitDirGroups: true, emitFileGroups: false, emitLeafFiles: false },
  { maxZoom: 2.0, visibleKinds: new Set(['decision', 'file']),
    dirDepth: Infinity, emitDirGroups: false, emitFileGroups: true, emitLeafFiles: true },
  { maxZoom: Infinity,
    visibleKinds: new Set(['decision', 'file', 'function', 'component',
      'reference', 'path', 'variable', 'section', 'type', 'project']),
    dirDepth: Infinity, emitDirGroups: false, emitFileGroups: false, emitLeafFiles: true },
];
```

Then update the derivation call inside `project()`:

```js
  // Was: const pathGroups = derivePathGroups(allNodes);
  const pathGroups = derivePathGroups(allNodes, { depth: band.dirDepth });
```

And rewrite the `emittedGroupIds` block that previously used `'top' / 'mid' / 'none'` so it just checks `band.emitDirGroups`:

```js
  const emittedGroupIds = new Set();
  if (band.emitDirGroups) {
    for (const g of pathGroups) {
      if (g.kind === 'dir') emittedGroupIds.add(g.id);
    }
  }
  if (band.emitFileGroups) {
    for (const g of pathGroups) {
      if (g.kind === 'file') emittedGroupIds.add(g.id);
    }
  }
```

Delete the now-unused `rootDirGroupIds`, `midDirGroupIds`, and `hasDirAncestor` / `nearestDirAncestor` code (search for their declarations and remove unused helpers). Verify the file still exports `projectionDeltaIsInteresting` and `BAND_TABLE`.

- [ ] **Step 4: Run ALL projection tests**

Run: `npm test -- tests/viewer/projection.test.ts`
Expected: new tests PASS; pre-existing tests that depended on the old 'top'/'mid' semantics may fail — fix them to use the new depth-cap expectation.

If pre-existing tests fail because they expected decisions-only at overview, update those tests to match the new expected behavior (depth-2 supernodes visible alongside decisions). Note this change in the commit.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/projection.js tests/viewer/projection.test.ts
git commit -m "feat(viewer): structure-primary band table (depth-2 overview, depth-3 mid)"
```

---

### Task 8: Inject `boxW/boxH` into group representatives

Projection's group representative is a synthetic node. Render needs label-fit dimensions baked into it so collide uses the right radius without calling `supernodeDims` every frame.

**Files:**
- Modify: `src/viewer/shared/projection.js`
- Modify: `tests/viewer/projection.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/projection.test.ts`:

```typescript
it('group representatives include boxW/boxH/radius from supernodeDims', () => {
  const state = {
    nodes: new Map([
      ['f1', { id: 'f1', kind: 'file', file_path: 'src/events/a.ts' }],
      ['f2', { id: 'f2', kind: 'file', file_path: 'src/events/b.ts' }],
    ]),
    edges: new Map(),
  };
  const filters = new Set(['file', 'decision']);
  const { visibleNodes } = project(state, { zoom: 0.3, focus: null, filters, search: '' });
  const g = visibleNodes.get('group:path:src/events');
  expect(g).toBeDefined();
  expect(g.boxW).toBeGreaterThan(0);
  expect(g.boxH).toBeGreaterThan(0);
  expect(g.radius).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/projection.test.ts`
Expected: FAIL — representative has no `boxW`.

- [ ] **Step 3: Update group representative construction in `projection.js`**

Near the top of `projection.js`, add:

```js
import { supernodeDims } from './sizing.js';
```

Find the block that builds representatives (around `visibleNodes.set(g.id, { ... })`) and add dims:

```js
  for (const id of emittedGroupIds) {
    const g = groupById.get(id);
    if (!g) continue;
    const label = labelFor(g);
    const dims = supernodeDims(label);
    visibleNodes.set(g.id, {
      id: g.id,
      kind: 'group',
      name: label,
      groupKind: g.kind,
      members: g.members,
      memberCount: g.memberCount,
      dirPath: g.dirPath,
      filePath: g.filePath,
      boxW: dims.w,
      boxH: dims.h,
      radius: dims.radius,
    });
  }
```

- [ ] **Step 4: Run test**

Run: `npm test -- tests/viewer/projection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/projection.js tests/viewer/projection.test.ts
git commit -m "feat(viewer): projection injects supernode boxW/boxH/radius into reps"
```

---

## Phase 4 — Wire new forces into the simulation

### Task 9: Replace `createSimulation` wiring

**Files:**
- Modify: `src/viewer/shared/layout.js`
- Modify: `tests/viewer/layout.test.ts`
- Modify: `src/viewer/graph-viewer-2d.js` (wiring only — no render changes yet)

- [ ] **Step 1: Write the failing test**

Extend the `createSimulation` describe block in `tests/viewer/layout.test.ts`:

```typescript
it('includes boundary, group, governance forces', () => {
  const sim = createSimulation();
  expect(sim.force('boundary')).toBeTruthy();
  expect(sim.force('group')).toBeTruthy();
  expect(sim.force('governance')).toBeTruthy();
  sim.stop();
});

it('drops the forceCenter (boundary replaces it)', () => {
  const sim = createSimulation();
  expect(sim.force('center')).toBeFalsy();
  sim.stop();
});
```

Also update the existing pinned test `center force strength is > 0.05` — it's no longer valid since `center` is gone. Delete or replace it with a boundary-strength check:

```typescript
it('boundary force has a configured strength', () => {
  const sim = createSimulation();
  expect(sim.force('boundary').strength()).toBeGreaterThan(0);
  sim.stop();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: FAIL — no boundary/group/governance force in createSimulation.

- [ ] **Step 3: Update `createSimulation` in `layout.js`**

Replace the body:

```js
const DEFAULT_BOUNDARY_STRENGTH = 0.8;
const DEFAULT_GROUP_STRENGTH    = 0.35;
const DEFAULT_GOVERN_STRENGTH   = 0.25;

export function createSimulation(opts = {}) {
  const radius = opts.radius ?? 400;
  return forceSimulation()
    .force('link',       forceLink().id(n => n.id).distance(linkDistance).strength(linkStrength))
    .force('charge',     forceManyBody().strength(nodeCharge))
    .force('collide',    forceCollide().radius(collideRadius))
    .force('boundary',   forceBoundary(radius, DEFAULT_BOUNDARY_STRENGTH))
    .force('group',      forceGroup(DEFAULT_GROUP_STRENGTH))
    .force('governance', forceGovernance(DEFAULT_GOVERN_STRENGTH))
    .alpha(1);
}
```

Add a `collideRadius` helper above it (so collide uses boxW/boxH for groups, world for others):

```js
function collideRadius(n) {
  if (n.kind === 'group' && n.radius) return n.radius + 4;
  return nodeSize(n) + 4;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/viewer/layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire adaptive scaling + boundary radius in entry file**

Open `src/viewer/graph-viewer-2d.js`. Locate `syncSimulation` (or whatever wires projection output into the sim — search for `simulation.nodes(` and `force('link').links(`). Adjust so it:

1. Computes `adapt = adaptiveScale(visibleNodes.size)`
2. Sets link distance + charge through multipliers rather than constants

Find the imports at top and add:

```js
import { adaptiveScale } from './shared/layout.js';
```

Find the `syncSimulation` (or equivalent sync call) and add these two lines before the alpha restart:

```js
  const adapt = adaptiveScale(visibleNodes.size);
  simulation.force('link').distance(link => linkDistance(link) * adapt);
  simulation.force('charge').strength(node => nodeCharge(node) * adapt);
```

Note: `linkDistance` and `nodeCharge` are already imported from layout.js.

Also, adjust the boundary radius when canvas resizes. Find the resize handler and add:

```js
  const r = Math.min(canvas.width, canvas.height) / window.devicePixelRatio * 0.40;
  simulation.force('boundary').radius(r);
```

- [ ] **Step 6: Smoke-test the viewer runs**

Start the dev server:

```bash
npm run dev &
sleep 3
curl -s http://localhost:3334/viewer | grep -q "<canvas" && echo "OK" || echo "FAIL"
```

Expected: `OK`. Kill the dev server after (`kill %1`).

- [ ] **Step 7: Commit**

```bash
git add src/viewer/shared/layout.js tests/viewer/layout.test.ts src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): wire boundary/group/governance forces + adaptive scaling"
```

---

## Phase 5 — Render updates

### Task 10: Supernode rendering uses `boxW/boxH`

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Locate supernode draw code**

Run: `grep -n "kind === 'group'" src/viewer/graph-viewer-2d.js` and `grep -n "drawRoundedRect" src/viewer/graph-viewer-2d.js`

Find the block that draws a supernode. It currently uses `nodeSize(n)` or a similar scalar. Note the exact line range for the edit.

- [ ] **Step 2: Replace the sizing reference**

Change the block from (approximate):

```js
if (n.kind === 'group') {
  const r = nodeSize(n);
  drawRoundedRect(ctx, n.x - r, n.y - r*0.6, r*2, r*1.2, 4);
  ...
}
```

To:

```js
if (n.kind === 'group') {
  const w = n.boxW ?? 48;
  const h = n.boxH ?? 20;
  drawRoundedRect(ctx, n.x - w/2, n.y - h/2, w, h, 4);
  ...
}
```

Keep the stroke/fill/label-centering code as-is below the rect call. Verify the label draws at `(n.x, n.y)` centered — adjust the text-baseline to `middle` if it was anchored to top.

- [ ] **Step 3: Hand-verify**

Run dev server and navigate to viewer:

```bash
npm run dev &
sleep 3
open http://localhost:3334/viewer
```

Visually confirm:
- Each supernode's rect width matches its label length (compare `src/ws/` to `docs/superpowers/`).
- Labels are centered inside the rect.
- No overlapping text.

Kill the dev server (`kill %1`) after confirming.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): supernode render uses label-fit boxW/boxH"
```

---

### Task 11: Label gating by band

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

Label visibility per the spec's §4 table. Implement a small pure helper in the entry file (could live in sizing.js but is render-local — leave inline).

- [ ] **Step 1: Add the gating helper**

Near the top of the render section in `graph-viewer-2d.js`, after existing helpers, add:

```js
/**
 * Returns true iff a node's label should render at the given zoom.
 * Selection and search-match are overrides handled by the caller.
 *   group:    always
 *   decision: always
 *   file:     zoom >= 0.7
 *   function/reference/component/etc: zoom >= 2.0
 */
function labelVisibleAt(node, zoom) {
  if (node.kind === 'group' || node.kind === 'decision') return true;
  if (node.kind === 'file') return zoom >= 0.7;
  return zoom >= 2.0;
}
```

- [ ] **Step 2: Gate labels in the draw loop**

Find the label-drawing block (`ctx.fillText(n.name, ...)` near each kind's draw code). Wrap each call:

```js
if (labelVisibleAt(n, camera.zoom) || n.id === selectedId || isSearchMatch(n)) {
  ctx.fillText(n.name, n.x, n.y + labelOffset);
}
```

If `isSearchMatch` doesn't exist yet, inline the check: `(search && searchMatch(n, search))` using the existing import.

- [ ] **Step 3: Hand-verify**

Start dev server, zoom in and out:

- At overview (≤0.4×): supernode labels + decision titles only.
- At mid (~0.7×): + file names.
- At close (≥1.0×): + function labels.
- Selected node: label always visible.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): label visibility gated by zoom band (spec §4)"
```

---

## Phase 6 — Camera mode + auto-fit

### Task 12: Camera mode + save/restore helpers

**Files:**
- Modify: `src/viewer/shared/camera.js`
- Modify: `tests/viewer/camera.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/camera.test.ts`:

```typescript
import {
  createCameraState,
  saveCamera,
  restoreCamera,
} from '../../src/viewer/shared/camera.js';

describe('camera state with mode + save/restore', () => {
  it('createCameraState returns mode=overview by default', () => {
    const s = createCameraState();
    expect(s.mode).toBe('overview');
    expect(s.saved).toBe(null);
  });

  it('saveCamera snapshots current x/y/zoom', () => {
    const s = createCameraState();
    s.camera = { x: 10, y: 20, zoom: 1.5 };
    saveCamera(s);
    expect(s.saved).toEqual({ x: 10, y: 20, zoom: 1.5 });
  });

  it('restoreCamera replaces camera with saved and clears saved', () => {
    const s = createCameraState();
    s.camera = { x: 10, y: 20, zoom: 1.5 };
    saveCamera(s);
    s.camera = { x: 99, y: 99, zoom: 3 };
    restoreCamera(s);
    expect(s.camera).toEqual({ x: 10, y: 20, zoom: 1.5 });
    expect(s.saved).toBe(null);
  });

  it('restoreCamera is a no-op if nothing was saved', () => {
    const s = createCameraState();
    s.camera = { x: 5, y: 5, zoom: 1 };
    restoreCamera(s);
    expect(s.camera).toEqual({ x: 5, y: 5, zoom: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/camera.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

Append to `src/viewer/shared/camera.js`:

```js
/**
 * Camera state container used by the entry file. Wraps a camera with mode
 * (overview | focus) and a save slot for search return-to.
 */
export function createCameraState() {
  return {
    camera: createCamera(),
    mode: 'overview',
    saved: null,
  };
}

/** Snapshot the current camera for later restore. */
export function saveCamera(state) {
  state.saved = { x: state.camera.x, y: state.camera.y, zoom: state.camera.zoom };
}

/** Restore a previously-saved camera; no-op if none. Clears the slot. */
export function restoreCamera(state) {
  if (!state.saved) return;
  state.camera = state.saved;
  state.saved = null;
}
```

- [ ] **Step 4: Run test**

Run: `npm test -- tests/viewer/camera.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/camera.js tests/viewer/camera.test.ts
git commit -m "feat(viewer): camera state w/ mode + save/restore"
```

---

### Task 13: Mode-aware wheel handler

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Locate the wheel handler**

Run: `grep -n "addEventListener('wheel'" src/viewer/graph-viewer-2d.js`

- [ ] **Step 2: Update it to branch by mode**

Replace the handler body. In overview mode, wheel advances through band thresholds. In focus mode, normal geometric zoom at cursor.

```js
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = (ev.clientX - rect.left) * devicePixelRatio;
  const sy = (ev.clientY - rect.top)  * devicePixelRatio;

  if (camState.mode === 'focus') {
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    camState.camera = zoomAtPoint(camState.camera, factor, sx, sy, canvas.width, canvas.height);
    reproject('focus-zoom');
    return;
  }

  // Overview: step through band thresholds. The band crossings in projection
  // naturally trigger reheats via reproject.
  const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
  camState.camera = zoomAtPoint(camState.camera, factor, sx, sy, canvas.width, canvas.height);
  reproject('zoom-band');
  // Auto-fit is scheduled by reproject when visible set changes (Task 14).
}, { passive: false });
```

Replace whatever `camera` variable is currently used with `camState.camera`. Search for `camera.x`, `camera.y`, `camera.zoom` references elsewhere and update to `camState.camera.x`, etc. (This is a rename; do all of them in this task.)

- [ ] **Step 3: Hand-verify**

```bash
npm run dev &
sleep 3
open http://localhost:3334/viewer
```

- Scroll wheel in overview: zoom crosses bands; supernodes expand.
- Dblclick a leaf node: enters focus mode (see Task 14 for focus entry wiring; for now, manually set `camState.mode = 'focus'` in devtools if needed to test wheel behavior).

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): mode-aware wheel (overview bands vs focus geometric)"
```

---

### Task 14: Auto-fit after reheat + pan disable in overview

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Locate the sim tick / alpha handler**

Run: `grep -n "simulation.on" src/viewer/graph-viewer-2d.js` (find the tick + end handlers), and `grep -n "alpha()" src/viewer/graph-viewer-2d.js`.

- [ ] **Step 2: Add auto-fit on alpha settle**

After each `simulation.alpha(...).restart()` call that's triggered by a reproject, set a pending flag. Then in the tick handler, when `sim.alpha() < 0.02` and the flag is set, clear it and lerp camera to fit.

Add near the top of the module with other state:

```js
let pendingAutoFit = false;
let autoFitLerp = null;  // { from, to, t0 } while animating
```

After any `reproject(reason)` that should auto-fit (anything in overview mode):

```js
if (camState.mode === 'overview') pendingAutoFit = true;
```

In the sim's `on('tick', ...)` handler, at the end:

```js
if (pendingAutoFit && simulation.alpha() < 0.02) {
  pendingAutoFit = false;
  const nodes = [...visibleNodes.values()];
  const target = fitToBounds(nodes, canvas.width/devicePixelRatio, canvas.height/devicePixelRatio, 40);
  autoFitLerp = { from: { ...camState.camera }, to: target, t0: performance.now() };
}
```

In the render frame loop (look for `requestAnimationFrame(render)`), apply the lerp:

```js
if (autoFitLerp) {
  const t = Math.min(1, (performance.now() - autoFitLerp.t0) / 400);
  camState.camera = lerpCamera(autoFitLerp.from, autoFitLerp.to, easeOutCubic(t));
  if (t >= 1) autoFitLerp = null;
}
```

Add the easing helper near the top:

```js
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
```

- [ ] **Step 3: Disable pan in overview mode**

Locate the pan handler (`grep -n "mousedown" src/viewer/graph-viewer-2d.js` or similar). Wrap the pan start:

```js
canvas.addEventListener('mousedown', (ev) => {
  if (camState.mode === 'overview') return;  // no pan in overview
  // ... existing pan logic
});
```

- [ ] **Step 4: Hand-verify**

```bash
npm run dev &
sleep 3
open http://localhost:3334/viewer
```

- Scroll wheel: after band cross, camera lerps to fit the new visible set.
- Try to drag empty canvas in overview: no pan (graph stays in view).
- Dblclick a node to enter focus (wiring comes in Task 15): pan enabled, wheel = geometric.

Kill dev server.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): auto-fit after reheat in overview; disable pan in overview"
```

---

### Task 15: Focus entry + exit, mode indicator

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`
- Modify: `src/viewer/index.html` (toolbar slot)
- Modify: `src/viewer/style.css` (mode indicator styling)

- [ ] **Step 1: Add a mode-indicator element**

In `src/viewer/index.html`, find the toolbar container (search for existing toolbar markup). Add:

```html
<div id="mode-indicator" class="mode-indicator mode-overview">OVERVIEW</div>
```

Append to `src/viewer/style.css`:

```css
.mode-indicator {
  display: inline-block;
  padding: 4px 8px;
  font: 10px/1 -apple-system, sans-serif;
  letter-spacing: .6px;
  text-transform: uppercase;
  border-radius: 3px;
  margin-left: 8px;
}
.mode-indicator.mode-overview { background: #1f2430; color: #7a8294; }
.mode-indicator.mode-focus    { background: #2a3547; color: #6ea8fe; }
```

- [ ] **Step 2: Wire mode transitions**

In `graph-viewer-2d.js`, find the existing dblclick handler (search for `dblclick`). Update it to set mode and update the indicator:

```js
const modeIndicator = document.getElementById('mode-indicator');

function setMode(mode, focusLabel) {
  camState.mode = mode;
  modeIndicator.className = `mode-indicator mode-${mode}`;
  modeIndicator.textContent = mode === 'focus'
    ? `FOCUS: ${focusLabel ?? ''}`
    : 'OVERVIEW';
}
```

Update the dblclick leaf handler to call `setMode('focus', node.name)`, and the Esc-out-of-focus handler to call `setMode('overview')`. Also wire the dblclick-on-supernode to NOT enter focus (it just drills via zoom — keep mode as overview).

- [ ] **Step 3: Disable soft boundary in focus mode**

In `reproject` or wherever the simulation is reconfigured, add:

```js
simulation.force('boundary').strength(camState.mode === 'focus' ? 0 : 0.8);
```

- [ ] **Step 4: Hand-verify**

```bash
npm run dev &
sleep 3
open http://localhost:3334/viewer
```

- Toolbar shows `OVERVIEW` badge.
- Dblclick a leaf file → badge flips to `FOCUS: <filename>`; pan + wheel-zoom now work freely; graph can extend beyond viewport.
- `Esc` → back to `OVERVIEW`; auto-fit restores.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/graph-viewer-2d.js src/viewer/index.html src/viewer/style.css
git commit -m "feat(viewer): mode indicator + focus-mode force/pan adjustments"
```

---

## Phase 7 — Search navigates

### Task 16: `findMatches` in `search.js`

Currently `search.js` is predicate-only (`searchMatch(node, query)`). We need a function that returns the full list of matches so the camera integration can fit them all.

**Files:**
- Modify: `src/viewer/shared/search.js`
- Modify: `tests/viewer/search.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/viewer/search.test.ts`:

```typescript
import { findMatches } from '../../src/viewer/shared/search.js';

describe('findMatches', () => {
  it('returns empty array for empty query', () => {
    const nodes = [{ id: 'a', name: 'foo' }];
    expect(findMatches(nodes, '')).toEqual([]);
  });

  it('returns all nodes whose name contains query (case-insensitive)', () => {
    const nodes = [
      { id: 'a', name: 'Projection', x: 1, y: 2 },
      { id: 'b', name: 'camera' },
      { id: 'c', name: 'projector', x: 3, y: 4 },
    ];
    const matches = findMatches(nodes, 'proj');
    expect(matches.map(m => m.id)).toEqual(['a', 'c']);
    expect(matches[0].x).toBe(1);
    expect(matches[0].y).toBe(2);
  });

  it('preserves node order', () => {
    const nodes = [
      { id: 'z', name: 'alpha' },
      { id: 'a', name: 'alpha' },
    ];
    const matches = findMatches(nodes, 'alpha');
    expect(matches.map(m => m.id)).toEqual(['z', 'a']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/viewer/search.test.ts`
Expected: FAIL — `findMatches` not exported.

- [ ] **Step 3: Implement**

Append to `src/viewer/shared/search.js`:

```js
/**
 * Returns the subset of `nodes` whose name contains `query`
 * (case-insensitive). Empty query → empty array (no match = no camera move).
 */
export function findMatches(nodes, query) {
  if (!query) return [];
  const q = query.toLowerCase();
  const out = [];
  for (const n of nodes) {
    const name = String(n && n.name ? n.name : '').toLowerCase();
    if (name.includes(q)) out.push(n);
  }
  return out;
}
```

- [ ] **Step 4: Run test**

Run: `npm test -- tests/viewer/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/search.js tests/viewer/search.test.ts
git commit -m "feat(viewer): findMatches — return full match list for navigation"
```

---

### Task 17: Search camera integration + picker chip

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`
- Modify: `src/viewer/index.html` (chip markup)
- Modify: `src/viewer/style.css` (chip styles)

- [ ] **Step 1: Add chip markup**

In `src/viewer/index.html`, adjacent to the existing search input, add:

```html
<button id="search-chip" class="search-chip" hidden>
  <span id="search-chip-count">0</span> matches
  <span class="chevron">▾</span>
</button>
<ul id="search-chip-menu" class="search-chip-menu" hidden></ul>
```

Append to `src/viewer/style.css`:

```css
.search-chip {
  margin-left: 6px;
  padding: 3px 8px;
  font: 11px/1 -apple-system, sans-serif;
  color: #d8dde7;
  background: #1f2430;
  border: 1px solid #2a3547;
  border-radius: 3px;
  cursor: pointer;
}
.search-chip:hover { background: #2a3547; }
.search-chip .chevron { margin-left: 4px; opacity: .7; }
.search-chip-menu {
  position: absolute;
  z-index: 10;
  margin: 4px 0 0 0;
  padding: 4px 0;
  max-height: 260px;
  overflow-y: auto;
  background: #11141b;
  border: 1px solid #1f2430;
  border-radius: 4px;
  list-style: none;
  box-shadow: 0 4px 12px rgba(0,0,0,.3);
}
.search-chip-menu li {
  padding: 6px 10px;
  cursor: pointer;
  font: 12px/1.3 -apple-system, sans-serif;
  color: #d8dde7;
}
.search-chip-menu li:hover { background: #1f2430; }
.search-chip-menu li .path { color: #7a8294; font-size: 10.5px; }
```

- [ ] **Step 2: Wire chip + camera in entry file**

In `graph-viewer-2d.js`, add imports:

```js
import { findMatches } from './shared/search.js';
import { saveCamera, restoreCamera, fitToBounds } from './shared/camera.js';
```

Find the search input handler. Replace/extend its body:

```js
const searchInput = document.getElementById('search-input');
const chip = document.getElementById('search-chip');
const chipCount = document.getElementById('search-chip-count');
const chipMenu = document.getElementById('search-chip-menu');

searchInput.addEventListener('focus', () => {
  if (!camState.saved) saveCamera(camState);
});

searchInput.addEventListener('input', debounce(() => {
  const q = searchInput.value.trim();
  reproject('search');   // existing behavior — force-visible matches

  const matches = findMatches([...state.nodes.values()], q);

  if (matches.length === 0) {
    chip.hidden = true;
    chipMenu.hidden = true;
    return;
  }

  chip.hidden = false;
  chipCount.textContent = String(matches.length);

  // Camera lerp to fit matches (single → center on it; many → fit all)
  lerpCameraTo(cameraForMatches(matches));

  // Populate menu (hidden until clicked)
  chipMenu.innerHTML = '';
  for (const m of matches) {
    const li = document.createElement('li');
    li.innerHTML = `<strong>${m.name}</strong> <span class="path">${m.file_path ?? ''}</span>`;
    li.addEventListener('click', () => {
      lerpCameraTo(cameraForMatches([m]));
      chipMenu.hidden = true;
    });
    chipMenu.appendChild(li);
  }
}, 200));

chip.addEventListener('click', () => { chipMenu.hidden = !chipMenu.hidden; });

searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    searchInput.value = '';
    reproject('search');
    chip.hidden = true;
    chipMenu.hidden = true;
    restoreCamera(camState);
  }
});

function cameraForMatches(matches) {
  const canvasW = canvas.width / devicePixelRatio;
  const canvasH = canvas.height / devicePixelRatio;
  return fitToBounds(matches, canvasW, canvasH, 80);
}

function lerpCameraTo(target) {
  autoFitLerp = { from: { ...camState.camera }, to: target, t0: performance.now() };
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
```

- [ ] **Step 3: Hand-verify**

```bash
npm run dev &
sleep 3
open http://localhost:3334/viewer
```

- Type `project`: camera lerps to the match; chip shows count.
- Type a broad query matching many: camera fits the bounds; chip shows count.
- Click chip: dropdown appears with match list.
- Click a row: camera hops to that specific match.
- Esc in input: clears query + camera restores.

Kill dev server.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js src/viewer/index.html src/viewer/style.css
git commit -m "feat(viewer): search navigates camera + multi-match picker chip"
```

---

## Phase 8 — Transitions

### Task 18: Verify re-parenting on supernode unfold

The 2026-04-18 spec called for children to inherit the supernode's position on unfold. Confirm this works post-band-table-inversion, patch if it doesn't.

**Files:**
- Modify: `src/viewer/shared/transitions.js` (possibly)
- Modify: `src/viewer/graph-viewer-2d.js` (possibly)

- [ ] **Step 1: Add an integration check**

Append to `tests/viewer/transitions.test.ts`:

```typescript
import { diffProjection } from '../../src/viewer/shared/transitions.js';

describe('re-parenting on unfold', () => {
  it('entering leaves get initial position from their ex-supernode', () => {
    const prev = {
      visibleNodes: new Map([
        ['group:path:src/events', { id: 'group:path:src/events', kind: 'group', x: 120, y: 40 }],
      ]),
      visibleEdges: new Map(),
    };
    const curr = {
      visibleNodes: new Map([
        ['f1', { id: 'f1', kind: 'file', group: 'group:path:src/events' }],
        ['f2', { id: 'f2', kind: 'file', group: 'group:path:src/events' }],
      ]),
      visibleEdges: new Map(),
    };
    const { entering } = diffProjection(prev, curr);
    for (const t of entering) {
      expect(Math.abs(t.from.x - 120)).toBeLessThan(25); // within ~20px jitter
      expect(Math.abs(t.from.y - 40)).toBeLessThan(25);
    }
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/viewer/transitions.test.ts`
Expected: PASS if re-parenting is already wired; FAIL otherwise. If FAIL, proceed to Step 3.

- [ ] **Step 3: Patch `diffProjection` if needed**

If the test failed, open `src/viewer/shared/transitions.js` and find where entering transitions get their `from.x/y`. Ensure the fallback path queries `prev.visibleNodes.get(node.group)` for position before falling back to random. Implementation sketch:

```js
function initialPositionForEntering(node, prev) {
  if (node.group && prev.visibleNodes.has(node.group)) {
    const parent = prev.visibleNodes.get(node.group);
    return {
      x: parent.x + (Math.random() - 0.5) * 20,
      y: parent.y + (Math.random() - 0.5) * 20,
    };
  }
  return { x: 0, y: 0 };
}
```

Wire this into the existing `diffProjection` `entering` construction.

- [ ] **Step 4: Re-run test**

Run: `npm test -- tests/viewer/transitions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/transitions.js tests/viewer/transitions.test.ts
git commit -m "fix(viewer): ensure re-parenting on supernode unfold"
```

If Step 2 passed with no code change, skip to Task 19 (commit the new test only):

```bash
git add tests/viewer/transitions.test.ts
git commit -m "test(viewer): pin re-parenting behavior on supernode unfold"
```

---

### Task 19: Aggregate edge ↔ constituent cross-fade

Currently aggregate edges and their constituent edges swap instantly at band crossings. Promote to 220ms cross-fade (spec §7.2).

**Files:**
- Modify: `src/viewer/shared/transitions.js`
- Modify: `src/viewer/graph-viewer-2d.js` (render integration)
- Modify: `tests/viewer/transitions.test.ts`

- [ ] **Step 1: Write failing test for edge-diff reclassification**

Append to `tests/viewer/transitions.test.ts`:

```typescript
describe('edge reclassification', () => {
  it('diffProjection returns reclassified when raw↔aggregate swap', () => {
    const prev = {
      visibleNodes: new Map([['a', {id:'a'}], ['b', {id:'b'}]]),
      visibleEdges: new Map([['a→b', { source_id:'a', target_id:'b', relation:'CALLS' }]]),
    };
    const curr = {
      visibleNodes: new Map([['ga', {id:'ga'}], ['gb', {id:'gb'}]]),
      visibleEdges: new Map([['agg:ga→gb', { aggregate:true, source_id:'ga', target_id:'gb', count:1, relation:'CALLS' }]]),
    };
    const diff = diffProjection(prev, curr);
    expect(diff.reclassified).toBeDefined();
    expect(Array.isArray(diff.reclassified)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npm test -- tests/viewer/transitions.test.ts`
Expected: FAIL — `reclassified` not returned or empty.

- [ ] **Step 3: Extend `diffProjection`**

In `src/viewer/shared/transitions.js`, make sure the returned object includes `reclassified`. The v1 shipped version likely returns `{entering, exiting}` only — add the third bucket populated when an edge's aggregate-flag changes between raw↔aggregate for the same endpoint pair.

```js
function diffEdges(prev, curr) {
  const reclassified = [];
  // Cross-reference by canonical endpoint pair:
  const prevByPair = new Map();
  for (const e of prev.visibleEdges.values()) {
    prevByPair.set(pairKey(e), e);
  }
  for (const e of curr.visibleEdges.values()) {
    const match = prevByPair.get(pairKey(e));
    if (match && !!match.aggregate !== !!e.aggregate) {
      reclassified.push({ from: match, to: e, age: 0, duration: 220 });
    }
  }
  return reclassified;
}

function pairKey(e) {
  return `${e.source_id}↔${e.target_id}`;
}
```

Wire `reclassified` into the diff return.

- [ ] **Step 4: Apply cross-fade in render**

In `graph-viewer-2d.js`, find the edge-draw loop. For any edge that is in a `reclassified` transition, draw both the old and new edges with opacity `age/duration` and `1 - age/duration` respectively. Advance `age` per frame alongside entering/exiting.

Add a block near the existing `anim.transitions` update:

```js
for (const t of anim.edgeReclassify ?? []) {
  t.age += delta;
  if (t.age >= t.duration) { /* cleaned up at diff application */ }
}
```

And in draw, before the normal edge render:

```js
for (const t of anim.edgeReclassify ?? []) {
  const p = Math.min(1, t.age / t.duration);
  drawEdge(t.from, { alpha: 1 - p });
  drawEdge(t.to,   { alpha: p });
}
```

Assuming `drawEdge` already exists — if not, extract it from the existing loop.

- [ ] **Step 5: Re-run test**

Run: `npm test -- tests/viewer/transitions.test.ts`
Expected: PASS.

- [ ] **Step 6: Hand-verify**

```bash
npm run dev &
sleep 3
open http://localhost:3334/viewer
```

- Zoom across a band threshold that aggregates/constituents swap: the swap cross-fades over ~220ms rather than snapping.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/shared/transitions.js src/viewer/graph-viewer-2d.js tests/viewer/transitions.test.ts
git commit -m "feat(viewer): aggregate↔constituent edge cross-fade (spec §7.2)"
```

---

## Phase 9 — Integration + QA

### Task 20: Integration test — viewport fill stable across bands

**Files:**
- Create: `tests/viewer/integration-viewport-fill.test.ts`

- [ ] **Step 1: Write the test**

```typescript
import { describe, it, expect } from 'vitest';
import { forceSimulation } from 'd3-force';
import {
  createSimulation,
  adaptiveScale,
  linkDistance,
  nodeCharge,
} from '../../src/viewer/shared/layout.js';
import { project } from '../../src/viewer/shared/projection.js';

// Build a synthetic state mimicking ~50 subsystem leaves
function buildState() {
  const nodes = new Map();
  const edges = new Map();
  const subsystems = ['src/events', 'src/graph', 'src/viewer', 'src/ws', 'src/mcp', 'docs/architecture', 'tests/viewer'];
  let id = 0;
  for (const s of subsystems) {
    for (let i = 0; i < 10; i++) {
      const nid = `n${id++}`;
      nodes.set(nid, { id: nid, kind: 'file', name: `f${i}.ts`, file_path: `${s}/f${i}.ts` });
    }
  }
  return { nodes, edges };
}

// Run the sim with the given projection to convergence
function settle(projection, radius) {
  const nodes = [...projection.visibleNodes.values()].map(n => ({ ...n, x: (Math.random()-0.5)*50, y: (Math.random()-0.5)*50 }));
  const edges = [...projection.visibleEdges.values()];
  const sim = createSimulation({ radius });
  sim.nodes(nodes);
  sim.force('link').links(edges);
  const adapt = adaptiveScale(nodes.length);
  sim.force('link').distance(l => linkDistance(l) * adapt);
  sim.force('charge').strength(n => nodeCharge(n) * adapt);
  sim.alpha(1).alphaDecay(0.1);
  for (let i = 0; i < 300; i++) sim.tick();
  sim.stop();
  return nodes;
}

function graphDiameter(nodes) {
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
  }
  return Math.max(maxX-minX, maxY-minY);
}

describe('viewport fill across bands', () => {
  const RADIUS = 400;
  const filters = new Set(['file', 'decision']);

  it('overview and detail bands settle at similar graph diameters', () => {
    const state = buildState();
    const overviewProj = project(state, { zoom: 0.3, focus: null, filters, search: '' });
    const detailProj   = project(state, { zoom: 3.0, focus: null, filters, search: '' });

    const overviewNodes = settle(overviewProj, RADIUS);
    const detailNodes   = settle(detailProj,   RADIUS);

    const ovd = graphDiameter(overviewNodes);
    const dtd = graphDiameter(detailNodes);

    // Target ≈ 2 * RADIUS = 800. Allow ±40%.
    expect(ovd).toBeGreaterThan(2 * RADIUS * 0.6);
    expect(ovd).toBeLessThan(2 * RADIUS * 1.4);
    expect(dtd).toBeGreaterThan(2 * RADIUS * 0.6);
    expect(dtd).toBeLessThan(2 * RADIUS * 1.4);

    // And within 50% of each other.
    const ratio = Math.max(ovd, dtd) / Math.min(ovd, dtd);
    expect(ratio).toBeLessThan(1.5);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npm test -- tests/viewer/integration-viewport-fill.test.ts`
Expected: PASS. If it fails with >1.5× ratio, tune `DEFAULT_BOUNDARY_STRENGTH` or `adaptiveScale` constant (50) — these are the two knobs. Keep the change small and document in the commit.

- [ ] **Step 3: Commit**

```bash
git add tests/viewer/integration-viewport-fill.test.ts
git commit -m "test(viewer): integration — viewport fill stable across bands"
```

---

### Task 21: Gate 0 — Visual QA

Per `.claude/rules/workflow.md`. Required before code review.

- [ ] **Step 1: Start dev server**

```bash
npm run dev > /tmp/cortex-dev.log 2>&1 &
sleep 4
curl -s http://localhost:3334/viewer | grep -q "<canvas" && echo "OK" || echo "FAIL"
```

- [ ] **Step 2: Run Playwright script** (via the available Playwright MCP tools, or a manual browser test if unavailable)

Checks to perform:

| Check | Pass condition |
|---|---|
| Page loads without console errors | `browser_console_messages level=error` returns 0 |
| Overview zoom (default) shows depth-2 supernodes | Visible: `src/events/`, `src/viewer/`, etc. + decisions |
| Zoom in past 0.4× | Deeper supernodes (`src/events/worker/`) appear |
| Zoom to 1.5× | Leaf file labels visible |
| Search `projection` | Camera lerps to match(es); chip appears |
| Esc in search | Camera lerps back; chip hides |
| Dblclick supernode | Camera zooms to band that unfolds it |
| Dblclick leaf file | Mode flips to `FOCUS: <filename>`; pan+zoom work |
| Esc in focus | Back to `OVERVIEW`; auto-fit |
| Graph shape stays circular across bands | Circularity > 0.85 at each band (eyeball) |

Capture a screenshot at each of these states.

- [ ] **Step 3: Log findings**

Document pass/fail per check in the commit message. If anything fails, loop back to the relevant earlier task and fix before proceeding. Do not run code review until Gate 0 passes.

- [ ] **Step 4: Commit QA artifacts** (if any)

If Playwright saved screenshots in `.playwright-mcp/`, they're gitignored (per `chore: add workflow rules Gate 0` commit) — no action needed. Commit only if new test fixtures were added.

Kill dev server: `kill %1`.

---

### Task 22: Gate 1 — Code review

Per `.claude/rules/workflow.md`.

- [ ] **Step 1: Get diff summary**

Run: `git diff main --name-only`

Expected list: ~9 files (layout, sizing, groups, projection, camera, search, transitions, graph-viewer-2d, style.css) + ~7 test files.

- [ ] **Step 2: Run `/review`**

Invoke the `/review` slash command. It reads the diff and reports.

- [ ] **Step 3: Address findings**

- **Critical** → fix before marking done, re-run `/review`.
- **Warning** → document in PR description, don't block.
- **Suggestion** → consider, don't block.

- [ ] **Step 4: Commit any fixes**

Atomic commits per fix, messages like `fix(viewer): address review — <specific issue>`.

---

### Task 23: Gate 2 — QA before merge

Per `.claude/rules/workflow.md`.

- [ ] **Step 1: Invoke the `qa` agent** (or run equivalent full pass)

Checks:
- `npm test` exits 0 (all suites).
- `npm run build` exits 0 (no TS errors).
- Dev server boots cleanly (`npm run dev`, watch log for errors).
- Full feature walkthrough (overlap with Gate 0; broader — include adjacent features like activity stream to confirm no regression).

- [ ] **Step 2: Merge to main**

```bash
git checkout main
git merge --no-ff feature/viewer/layout-redesign
git branch -d feature/viewer/layout-redesign
```

Do NOT push unless the user explicitly asks.

- [ ] **Step 3: Update MEMORY.md if needed**

If the redesign changed any of the long-lived architectural invariants referenced in the user's memory (e.g. "decisions are always visible floor"), update the relevant memory entry. In this case the invariant *did* change — decisions are now satellites, not co-equal floor. Update or note this in the Phase 1 status memory.

---

## Deferred / out of scope for this plan

These are listed in the spec's Deferred section but intentionally not implemented here:

- Force-regime interpolation by zoom (`group`/`collide` relax at close zoom).
- Animated mode indicator swap.
- Empty-territory dashed halo.
- Conversation memory as graph nodes, Louvain clustering, activity heat, breadcrumb, co-change clustering, server-side aggregation.

Do not add these in this plan.

---

## Success criteria

All of the following true:

1. `npm test` passes — all suites.
2. Gate 0 walkthrough passes with no console errors.
3. Overview shows structural backbone with decisions as satellites (spec §1).
4. Graph stays ≈ same viewport fill across bands (integration test + eyeball).
5. Search animates camera to match(es); chip disambiguates.
6. Focus mode works (dblclick leaf → focus; Esc → overview).
7. Merge to main clean via `git merge --no-ff`.

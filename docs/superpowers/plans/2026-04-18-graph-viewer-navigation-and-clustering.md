# 2D Graph Viewer — Navigation, Clustering, Search UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three gaps in the shipped 2D viewer: add pan/zoom/fit/recenter + zoom-gated labels + pan-to-fit on focus; re-tune the force simulation to settle into an emergent Obsidian-style disk; and make search dim non-matches instead of hiding them.

**Architecture:** One new pure module (`shared/camera.js`) owns camera state + transform math (unit-tested). The entry file `graph-viewer-2d.js` gains camera state, pan/zoom/wheel/keyboard handlers, a camera-aware render transform, a zoom-gated label pass, and a search-dim multiplier. `shared/layout.js` is a pure data change (re-tuned force numbers). One tiny new pure helper `shared/search.js` holds the name-match predicate so it can be unit-tested.

**Tech Stack:** Vanilla ES modules, Canvas 2D, Pointer Events API, `wheel` events, Vitest. No new runtime deps.

**Spec:** [../specs/2026-04-18-graph-viewer-navigation-and-clustering.md](../specs/2026-04-18-graph-viewer-navigation-and-clustering.md)

**Related plans:**
- Plan B (shipped): [2026-04-17-graph-viewer-2d.md](2026-04-17-graph-viewer-2d.md)

---

## File Structure

**New source files:**

```
src/viewer/shared/
  camera.js        pure camera state + transform math (createCamera, clampZoom, worldToScreen,
                   screenToWorld, fitToBounds, zoomAtPoint, lerpCamera)
  search.js        single pure helper: searchMatch(node, query) → boolean
```

**New tests:**

```
tests/viewer/
  camera.test.ts   round-trip, fitToBounds variants, zoom-at-point pivot, lerp
  search.test.ts   empty query, case-insensitive, name-only
```

**Modified source files:**

```
src/viewer/graph-viewer-2d.js   camera state + pan/zoom/wheel/F-R keyboard, render transform,
                                label pass, pan-to-fit on focus, search-dim path, hit-test update
src/viewer/shared/layout.js     re-tuned force numbers (values table in spec)
src/viewer/index.html           recenter button in toolbar; match-count span in search group
src/viewer/style.css            recenter button style, #search-group layout, grabbing cursor
```

**Modified tests:**

```
tests/viewer/layout.test.ts     new pinned assertion: forceCenter.strength > 0.05
```

No new runtime dependencies. `d3-force` is already a devDependency.

---

## Task ordering rationale

Tasks 1–2 are small, isolated, and orthogonal to the camera work. They ship visible wins first. Task 3 is the new pure module — a prerequisite for everything that follows. Task 4 wires the camera transform into render + hit-test + fit-on-load (the minimum that produces a functioning camera). Tasks 5–9 layer interactions one at a time, each independently shippable.

---

### Task 1: Force tuning — emergent disk

**Files:**
- Modify: `src/viewer/shared/layout.js`
- Modify: `tests/viewer/layout.test.ts`

- [ ] **Step 1: Update the layout.js numbers**

In `src/viewer/shared/layout.js`, replace the `SIZE`, `CHARGE`, `LINK_DIST`, `LINK_STR` table and the `createSimulation()` body as follows (note: `SIZE` and `LINK_STR` are unchanged; only `CHARGE`, `LINK_DIST`, and the `forceCenter` strength change):

```js
const SIZE = {
  decision: 7.5,
  file: 5,
  function: 2.5,
  component: 4.5,
  reference: 4.5,
  path: 3.5,
};

const CHARGE = {
  decision: -220,
  file: -80,
  function: -40,
  component: -40,
  reference: -40,
  path: -25,
};

const LINK_DIST = {
  GOVERNS: 45,
  CALLS: 55,
  IMPORTS: 70,
  SUPERSEDES: 40,
  REFERENCES: 70,
  'co-changed': 140,
};

const LINK_STR = {
  GOVERNS: 0.8,
  CALLS: 0.5,
  IMPORTS: 0.4,
  SUPERSEDES: 0.6,
  REFERENCES: 0.4,
  'co-changed': 0.1,
};
```

In `createSimulation()`, change `forceCenter(0, 0).strength(0.03)` to `.strength(0.12)`:

```js
export function createSimulation() {
  return forceSimulation()
    .force('link',   forceLink().id(n => n.id).distance(linkDistance).strength(linkStrength))
    .force('charge', forceManyBody().strength(nodeCharge))
    .force('center', forceCenter(0, 0).strength(0.12))
    .force('collide', forceCollide().radius(n => nodeSize(n.kind) + 4))
    .alpha(1);
}
```

- [ ] **Step 2: Add pinned assertion in the layout tests**

In `tests/viewer/layout.test.ts`, inside the existing `describe('createSimulation', ...)` block, add a new test after the existing one:

```ts
it('center force strength is > 0.05 (pinned — emergent disk requires a real center pull)', () => {
  const sim = createSimulation();
  expect(sim.force('center').strength()).toBeGreaterThan(0.05);
  sim.stop();
});
```

- [ ] **Step 3: Run tests to verify everything still passes**

Run: `npx vitest run tests/viewer/layout.test.ts`
Expected: 9 tests passing (8 existing + 1 new).

Also run: `npm test`
Expected: 162 tests passing (161 prior + 1 new).

Also run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/shared/layout.js tests/viewer/layout.test.ts
git commit -m "feat(viewer): re-tune forces for emergent Obsidian-style disk"
```

---

### Task 2: Search UX — dim non-matches instead of hiding

**Files:**
- Create: `src/viewer/shared/search.js`
- Create: `tests/viewer/search.test.ts`
- Modify: `src/viewer/graph-viewer-2d.js`
- Modify: `src/viewer/index.html`
- Modify: `src/viewer/style.css`

- [ ] **Step 1: Write the failing test for `searchMatch`**

Write `tests/viewer/search.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { searchMatch } from '../../src/viewer/shared/search.js';

describe('searchMatch', () => {
  it('empty / falsy query matches every node', () => {
    expect(searchMatch({ name: 'foo' }, '')).toBe(true);
    expect(searchMatch({ name: 'bar' }, null)).toBe(true);
    expect(searchMatch({ name: 'baz' }, undefined)).toBe(true);
  });

  it('case-insensitive substring match on name', () => {
    expect(searchMatch({ name: 'AuthService' }, 'auth')).toBe(true);
    expect(searchMatch({ name: 'authservice' }, 'AUTH')).toBe(true);
    expect(searchMatch({ name: 'authservice' }, 'Thse')).toBe(false);
    expect(searchMatch({ name: 'Login' }, 'auth')).toBe(false);
  });

  it('matches on name only — ignores kind, file_path, data', () => {
    expect(searchMatch({ name: 'X', kind: 'auth' }, 'auth')).toBe(false);
    expect(searchMatch({ name: 'X', file_path: 'src/auth.ts' }, 'auth')).toBe(false);
    expect(searchMatch({ name: 'X', data: { rationale: 'about auth' } }, 'auth')).toBe(false);
  });

  it('tolerates missing name (no crash)', () => {
    expect(searchMatch({}, 'x')).toBe(false);
    expect(searchMatch({ name: null }, 'x')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/viewer/search.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/viewer/shared/search.js`**

```js
/**
 * Predicate used by the 2D viewer to decide whether a node "matches" the
 * current search query. Pure; name-only; case-insensitive; empty query is
 * treated as "match everything" so the caller can always multiply its output
 * through without a special-case.
 */
export function searchMatch(node, query) {
  if (!query) return true;
  const name = String(node && node.name ? node.name : '').toLowerCase();
  return name.includes(query.toLowerCase());
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/search.test.ts`
Expected: 4 tests passing.

- [ ] **Step 5: Wire `searchMatch` into the entry file**

In `src/viewer/graph-viewer-2d.js`:

Add to the imports at the top (group with other shared imports):

```js
import { searchMatch } from '/viewer/shared/search.js';
```

Find the existing `function isVisible(node) { ... }` block (it currently checks `focusSet`, `activeKinds`, and `searchQuery`). Replace it with the version below — search is no longer a hide gate:

```js
function isVisible(node) {
  if (focusSet && !focusSet.has(node.id)) return false;
  if (!activeKinds.has(node.kind)) return false;
  return true;
}
```

In the `draw()` function, find the edges loop. After the `if (!isVisible(a) || !isVisible(b)) continue;` line, compute an edge dim multiplier before the stroke is drawn:

```js
    // Inside the edges loop, right after the isVisible skip:
    const edgeBright = !searchQuery || (searchMatch(a, searchQuery) && searchMatch(b, searchQuery));
    const edgeSearchDim = edgeBright ? 1.0 : 0.15;
```

Then multiply `alpha` (which already exists in that loop) by `edgeSearchDim` when building `ctx.strokeStyle`:

```js
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * edgeSearchDim) + ')';
```

In the nodes loop in `draw()`, after the existing `if (!isVisible(node)) continue;` line and the existing alpha composition (down to the line that sets the final `alpha`), insert:

```js
    const matches = searchMatch(node, searchQuery);
    const searchDim = searchQuery && !matches ? 0.15 : 1.0;
```

Then change the `shape(ctx, sx, sy, r, rgbString(rgb, alpha));` call to multiply by `searchDim`:

```js
    shape(ctx, sx, sy, r, rgbString(rgb, alpha * searchDim));
    if (node.status === 'superseded') {
      drawStrike(ctx, sx, sy, r, 'rgba(255,255,255,' + (alpha * searchDim * 0.8) + ')');
    }
```

- [ ] **Step 6: Add the match-count span to the toolbar**

In `src/viewer/index.html`, find the `<input type="text" id="search" placeholder="Search nodes...">` line. Wrap the input and a new match-count span in a `#search-group` container:

```html
<div id="search-group">
  <input type="text" id="search" placeholder="Search nodes...">
  <span id="search-count"></span>
</div>
```

- [ ] **Step 7: Add search-count styling**

Append to `src/viewer/style.css`:

```css
/* -- Search group (input + match count) -- */
#search-group {
  position: relative;
  display: flex;
  align-items: center;
}
#search-count {
  position: absolute;
  right: 8px;
  color: #555;
  font-size: 10px;
  font-family: "Geist Mono", monospace;
  pointer-events: none;
  user-select: none;
}
#search-count.hidden { display: none; }
```

Also add the `grabbing` cursor rule at the top of the 2D-viewer-canvas block (it already has `#graph { ... }`). Find that rule and add `cursor: default;` line; then add a companion rule below:

```css
#graph.panning {
  cursor: grabbing;
}
```

- [ ] **Step 8: Wire the match count in the entry file**

In `src/viewer/graph-viewer-2d.js`, find the search setup section (where `searchInput.addEventListener('input', ...)` lives). Extend the handler to update the match count:

```js
const searchInput = document.getElementById('search');
const searchCount = document.getElementById('search-count');

function updateSearchCount() {
  if (!searchQuery) {
    searchCount.classList.add('hidden');
    searchCount.textContent = '';
    return;
  }
  let matches = 0;
  let total = 0;
  for (const node of state.nodes.values()) {
    if (!isVisible(node)) continue;
    total++;
    if (searchMatch(node, searchQuery)) matches++;
  }
  searchCount.textContent = matches + ' / ' + total;
  searchCount.classList.remove('hidden');
}

searchInput.addEventListener('input', (ev) => {
  searchQuery = ev.target.value.toLowerCase();
  updateSearchCount();
});
```

Also update the count when kind filters change — inside the existing `document.querySelectorAll('#filters input').forEach(...)` handler body, after the `activeKinds.add/delete` lines, add:

```js
    updateSearchCount();
```

- [ ] **Step 9: Add `Esc` in the search input to clear and blur, plus `/` to focus**

Append after the `searchInput.addEventListener('input', ...)` handler:

```js
searchInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    searchInput.value = '';
    searchQuery = '';
    updateSearchCount();
    searchInput.blur();
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && document.activeElement !== searchInput) {
    ev.preventDefault();
    searchInput.focus();
  }
});
```

- [ ] **Step 10: Verify**

Run: `npx tsc --noEmit` — no errors
Run: `npm test` — expect 166 passing (162 prior + 4 search tests)
Run: `npm run dev` in background, hit `http://localhost:3334/viewer`, verify:
- Curl check: `curl -s http://localhost:3334/viewer/graph-viewer-2d.js | grep -c "searchMatch\|searchDim\|edgeBright"` → ≥ 4
- Curl check: `curl -s http://localhost:3334/viewer | grep -c "search-count\|search-group"` → ≥ 2

Kill dev server (`pkill -f "tsx src/index.ts"`).

- [ ] **Step 11: Commit**

```bash
git add src/viewer/shared/search.js tests/viewer/search.test.ts \
        src/viewer/graph-viewer-2d.js src/viewer/index.html src/viewer/style.css
git commit -m "feat(viewer): search dims non-matches instead of hiding; keyboard shortcuts; match count"
```

---

### Task 3: `shared/camera.js` — pure camera state + transform math

**Files:**
- Create: `src/viewer/shared/camera.js`
- Create: `tests/viewer/camera.test.ts`

- [ ] **Step 1: Write the failing tests**

Write `tests/viewer/camera.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  createCamera,
  clampZoom,
  screenToWorld,
  worldToScreen,
  fitToBounds,
  zoomAtPoint,
  lerpCamera,
} from '../../src/viewer/shared/camera.js';

describe('camera', () => {
  it('createCamera returns identity', () => {
    expect(createCamera()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('clampZoom clamps to [0.2, 5]', () => {
    expect(clampZoom(0.1)).toBe(0.2);
    expect(clampZoom(0.2)).toBe(0.2);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(5)).toBe(5);
    expect(clampZoom(10)).toBe(5);
  });

  it('worldToScreen: identity camera maps world origin to canvas center', () => {
    const [sx, sy] = worldToScreen(createCamera(), 0, 0, 400, 300);
    expect(sx).toBe(200);
    expect(sy).toBe(150);
  });

  it('worldToScreen / screenToWorld round-trip for arbitrary camera', () => {
    const cam = { x: 50, y: -30, zoom: 2 };
    const [sx, sy] = worldToScreen(cam, 10, 20, 400, 300);
    const [wx, wy] = screenToWorld(cam, sx, sy, 400, 300);
    expect(wx).toBeCloseTo(10);
    expect(wy).toBeCloseTo(20);
  });

  it('screenToWorld at canvas center returns camera.x, camera.y', () => {
    const [wx, wy] = screenToWorld({ x: 42, y: -17, zoom: 1 }, 200, 150, 400, 300);
    expect(wx).toBeCloseTo(42);
    expect(wy).toBeCloseTo(-17);
  });

  it('fitToBounds: 0 nodes → identity camera', () => {
    expect(fitToBounds([], 400, 300)).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('fitToBounds: 1 node → centered on that node at zoom=1', () => {
    expect(fitToBounds([{ x: 50, y: -10 }], 400, 300)).toEqual({ x: 50, y: -10, zoom: 1 });
  });

  it('fitToBounds: many nodes → centered on bbox center, zoom fits within padding', () => {
    const cam = fitToBounds([
      { x: -100, y: -100 },
      { x: 100, y: 100 },
    ], 500, 400, 40);
    expect(cam.x).toBe(0);
    expect(cam.y).toBe(0);
    // width 200 in canvas 500 with 40 padding each side → zoomX = 420/200 = 2.1
    // height 200 in canvas 400 with 40 padding each side → zoomY = 320/200 = 1.6
    // min = 1.6
    expect(cam.zoom).toBeCloseTo(1.6);
  });

  it('fitToBounds clamps zoom to [0.2, 5]', () => {
    const tiny = fitToBounds([{ x: 0, y: 0 }, { x: 0.01, y: 0.01 }], 400, 300, 40);
    expect(tiny.zoom).toBeLessThanOrEqual(5);
    const huge = fitToBounds([{ x: -100000, y: -100000 }, { x: 100000, y: 100000 }], 400, 300, 40);
    expect(huge.zoom).toBeGreaterThanOrEqual(0.2);
  });

  it('zoomAtPoint: world point under cursor stays under cursor', () => {
    const cam = { x: 0, y: 0, zoom: 1 };
    const canvasW = 400, canvasH = 300;
    const cursorX = 300, cursorY = 100;
    const [wxBefore, wyBefore] = screenToWorld(cam, cursorX, cursorY, canvasW, canvasH);
    const zoomed = zoomAtPoint(cam, 2, cursorX, cursorY, canvasW, canvasH);
    const [wxAfter, wyAfter] = screenToWorld(zoomed, cursorX, cursorY, canvasW, canvasH);
    expect(wxAfter).toBeCloseTo(wxBefore);
    expect(wyAfter).toBeCloseTo(wyBefore);
    expect(zoomed.zoom).toBe(2);
  });

  it('zoomAtPoint: clamps at max', () => {
    const cam = zoomAtPoint({ x: 0, y: 0, zoom: 4 }, 3, 200, 150, 400, 300);
    expect(cam.zoom).toBe(5);
  });

  it('zoomAtPoint: clamps at min', () => {
    const cam = zoomAtPoint({ x: 0, y: 0, zoom: 0.3 }, 0.1, 200, 150, 400, 300);
    expect(cam.zoom).toBe(0.2);
  });

  it('lerpCamera: endpoints and midpoint', () => {
    const a = { x: 0, y: 0, zoom: 1 };
    const b = { x: 100, y: -50, zoom: 2 };
    expect(lerpCamera(a, b, 0)).toEqual(a);
    expect(lerpCamera(a, b, 1)).toEqual(b);
    expect(lerpCamera(a, b, 0.5)).toEqual({ x: 50, y: -25, zoom: 1.5 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/viewer/camera.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/viewer/shared/camera.js`**

```js
/**
 * Pure camera state + transform math for the 2D viewer.
 *
 * Camera = { x, y, zoom }
 *   - x, y: world-space point that appears at the canvas center
 *   - zoom: scalar; 1 means 1:1 world-to-screen (clamped to [0.2, 5])
 *
 * The module is DOM-less; it operates on plain numbers. The entry file keeps
 * `camera` as mutable state and passes it to these helpers each frame.
 */

export const ZOOM_MIN = 0.2;
export const ZOOM_MAX = 5;

export function createCamera() {
  return { x: 0, y: 0, zoom: 1 };
}

export function clampZoom(z) {
  if (z < ZOOM_MIN) return ZOOM_MIN;
  if (z > ZOOM_MAX) return ZOOM_MAX;
  return z;
}

/**
 * Forward transform: world point → screen pixel.
 *   screen = (world - camera) * zoom + (canvas / 2)
 */
export function worldToScreen(camera, wx, wy, canvasW, canvasH) {
  const sx = (wx - camera.x) * camera.zoom + canvasW / 2;
  const sy = (wy - camera.y) * camera.zoom + canvasH / 2;
  return [sx, sy];
}

/**
 * Inverse transform: screen pixel → world point.
 *   world = (screen - canvas / 2) / zoom + camera
 */
export function screenToWorld(camera, sx, sy, canvasW, canvasH) {
  const wx = (sx - canvasW / 2) / camera.zoom + camera.x;
  const wy = (sy - canvasH / 2) / camera.zoom + camera.y;
  return [wx, wy];
}

/**
 * Camera that frames every node in the iterable within `canvas` minus `padding`
 * on all sides. With 0 nodes returns identity; with 1 node, centers it at
 * zoom = 1. Zoom is clamped to [ZOOM_MIN, ZOOM_MAX].
 */
export function fitToBounds(nodes, canvasW, canvasH, padding = 40) {
  const arr = Array.isArray(nodes) ? nodes : [...nodes];
  if (arr.length === 0) return createCamera();
  if (arr.length === 1) {
    const n = arr[0];
    return { x: n.x ?? 0, y: n.y ?? 0, zoom: 1 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of arr) {
    const x = n.x ?? 0;
    const y = n.y ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const availW = Math.max(1, canvasW - 2 * padding);
  const availH = Math.max(1, canvasH - 2 * padding);
  const zoom = clampZoom(Math.min(availW / w, availH / h));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
}

/**
 * Zoom by `factor` while keeping the world point currently under (sx, sy)
 * pinned under the same screen coordinate after the zoom.
 *
 * Derivation:
 *   world = (screen - W/2) / zoom + camera
 *   world_before = world_after → solve for new camera:
 *     camera_new = camera_old + (screen - W/2) * (1/zoom_old - 1/zoom_new)
 */
export function zoomAtPoint(camera, factor, sx, sy, canvasW, canvasH) {
  const newZoom = clampZoom(camera.zoom * factor);
  const dx = (sx - canvasW / 2) * (1 / camera.zoom - 1 / newZoom);
  const dy = (sy - canvasH / 2) * (1 / camera.zoom - 1 / newZoom);
  return { x: camera.x + dx, y: camera.y + dy, zoom: newZoom };
}

/**
 * Per-frame interpolation used for smooth recenter / focus-fit animations.
 * t = 0 → from, t = 1 → to, no clamping outside [0, 1] (caller's responsibility).
 */
export function lerpCamera(from, to, t) {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    zoom: from.zoom + (to.zoom - from.zoom) * t,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/viewer/camera.test.ts`
Expected: 13 tests passing.

Run full suite: `npm test`
Expected: 179 tests passing (166 prior + 13 new).

- [ ] **Step 5: Commit**

```bash
git add src/viewer/shared/camera.js tests/viewer/camera.test.ts
git commit -m "feat(viewer): pure camera module — state, transforms, fit, zoom-at-point, lerp"
```

---

### Task 4: Wire camera into render + hit-test + fit-on-load

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Add camera state and import**

At the top of `src/viewer/graph-viewer-2d.js`, add to imports:

```js
import {
  createCamera,
  worldToScreen as camWorldToScreen,
  screenToWorld as camScreenToWorld,
  fitToBounds,
  zoomAtPoint,
  lerpCamera,
} from '/viewer/shared/camera.js';
```

After the `const anim = createAnimState();` line (near the top, before the hydrate fetch), insert:

```js
let camera = createCamera();
let targetCamera = null;   // when set, frame() lerps camera toward it
window.__cortex_viewer_camera = () => camera;  // hook for tests / debugging
```

- [ ] **Step 2: Replace the file-local `worldToScreen` with a camera-aware wrapper**

Find the existing `function worldToScreen(x, y) { ... }` in `graph-viewer-2d.js` (it currently uses a fixed canvas-center formula). Replace it with:

```js
function worldToScreen(wx, wy) {
  return camWorldToScreen(camera, wx, wy, canvas.clientWidth, canvas.clientHeight);
}
```

- [ ] **Step 3: Update `pickNodeAt` to be camera-aware**

Find the existing `function pickNodeAt(ev) { ... }` helper. Replace its body with:

```js
function pickNodeAt(ev) {
  const rect = canvas.getBoundingClientRect();
  const [wx, wy] = camScreenToWorld(
    camera,
    ev.clientX - rect.left,
    ev.clientY - rect.top,
    rect.width,
    rect.height,
  );
  let best = null;
  let bestDist = Infinity;
  for (const node of state.nodes.values()) {
    const dx = (node.x ?? 0) - wx;
    const dy = (node.y ?? 0) - wy;
    const d = dx * dx + dy * dy;
    const r = (nodeSize(node.kind) + 3) / camera.zoom;
    if (d < r * r && d < bestDist) { best = node; bestDist = d; }
  }
  return best;
}
```

- [ ] **Step 4: Add fit-on-load state and the fit logic**

Near the top (right after the `targetCamera = null;` line), add:

```js
let hasInitiallyFit = false;
```

Then in the existing `frame(t)` function, immediately after `simulation.tick();` and before `applyBreathing(t);`, add the fit-on-load check:

```js
  if (!hasInitiallyFit && simulation.alpha() < 0.3) {
    // Wait for the sim to actually reach roughly equilibrium before framing.
    // With the Task 1 force tuning, alpha < 0.3 fires at ~tick 50 (≈0.8s at 60fps).
    const fit = fitToBounds(state.nodes.values(), canvas.clientWidth, canvas.clientHeight, 40);
    camera = fit;
    hasInitiallyFit = true;
  }

  // Smooth camera animation toward a target, if one is set.
  if (targetCamera) {
    camera = lerpCamera(camera, targetCamera, 0.15);
    const dx = targetCamera.x - camera.x;
    const dy = targetCamera.y - camera.y;
    const dz = targetCamera.zoom - camera.zoom;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(dz) < 0.005) {
      camera = targetCamera;
      targetCamera = null;
    }
  }
```

- [ ] **Step 5: Apply the camera transform inside `draw()`**

Find the existing `function draw() { ... }`. The current body begins with `ctx.fillStyle = BACKGROUND; ctx.fillRect(...)` then draws edges and nodes.

Rewrite it as below — the draw pass now wraps world-space rendering in a save/translate/scale/restore block:

```js
function draw() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  ctx.save();
  ctx.translate(canvas.clientWidth / 2, canvas.clientHeight / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  ctx.lineWidth = 0.5 / camera.zoom;   // keep edges crisp at any zoom
  for (const edge of state.edges.values()) {
    const a = state.nodes.get(edge.source_id);
    const b = state.nodes.get(edge.target_id);
    if (!a || !b) continue;
    if (!isVisible(a) || !isVisible(b)) continue;
    const eKey = edgeKey(edge);
    const alphaSpec = EDGE_ALPHA[edge.relation] || EDGE_ALPHA.CALLS;
    const eAnim = anim.edges.get(eKey);
    const h = eAnim ? eAnim.highlight : 0;
    const alpha = alphaSpec.rest + (alphaSpec.hover - alphaSpec.rest) * h;
    const edgeBright = !searchQuery || (searchMatch(a, searchQuery) && searchMatch(b, searchQuery));
    const edgeSearchDim = edgeBright ? 1.0 : 0.15;
    ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * edgeSearchDim) + ')';
    ctx.beginPath();
    ctx.moveTo(a.x ?? 0, a.y ?? 0);
    ctx.lineTo(b.x ?? 0, b.y ?? 0);
    ctx.stroke();
  }

  for (const node of state.nodes.values()) {
    if (!isVisible(node)) continue;
    const shape = SHAPE_FOR_KIND[node.kind] || SHAPE_FOR_KIND.file;
    const base = PALETTE_REST[node.kind] || PALETTE_REST.file;
    const hover = PALETTE_HOVER[node.kind] || PALETTE_HOVER.file;
    const nAnim = anim.nodes.get(node.id) || { highlight: 0, colorMix: 0 };
    const rgb = lerpRGB(base, hover, nAnim.colorMix);
    const statusAlpha = node.status === 'proposed' || node.status === 'superseded' ? 0.4 : 1.0;
    const restAlpha  = statusAlpha * 0.5;
    const hoverAlpha = Math.min(1, statusAlpha + 0.25);
    const alpha = hoveredId === null
      ? statusAlpha
      : restAlpha + (hoverAlpha - restAlpha) * nAnim.highlight;
    const matches = searchMatch(node, searchQuery);
    const searchDim = searchQuery && !matches ? 0.15 : 1.0;
    const r = nodeSize(node.kind) * (1 + nAnim.highlight * 0.15);
    shape(ctx, node.x ?? 0, node.y ?? 0, r, rgbString(rgb, alpha * searchDim));
    if (node.status === 'superseded') {
      drawStrike(ctx, node.x ?? 0, node.y ?? 0, r, 'rgba(255,255,255,' + (alpha * searchDim * 0.8) + ')');
    }
  }

  drawSynapses();

  ctx.restore();
}
```

Note: the node and edge draw calls no longer go through `worldToScreen` — they pass world coordinates directly because the canvas context is now transformed. `drawSynapses` continues to use `worldToScreen()` internally; update it accordingly in the next step.

- [ ] **Step 6: Update `drawSynapses` to draw in world space**

Find the existing `function drawSynapses() { ... }`. Replace it with:

```js
function drawSynapses() {
  for (const s of anim.synapses) {
    const progress = s.age / s.duration;
    if (s.kind === 'ring') {
      const node = state.nodes.get(s.nodeId);
      if (!node) continue;
      const r = nodeSize(node.kind) + progress * 22;
      ctx.beginPath();
      ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(180,160,224,' + (1 - progress) + ')';
      ctx.lineWidth = 1 / camera.zoom;
      ctx.stroke();
    } else if (s.kind === 'pulse') {
      const a = state.nodes.get(s.source);
      const b = state.nodes.get(s.target);
      if (!a || !b) continue;
      const px = (a.x ?? 0) + ((b.x ?? 0) - (a.x ?? 0)) * progress;
      const py = (a.y ?? 0) + ((b.y ?? 0) - (a.y ?? 0)) * progress;
      ctx.beginPath();
      ctx.arc(px, py, 2.5 / camera.zoom, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,' + (1 - progress) + ')';
      ctx.fill();
    }
  }
}
```

- [ ] **Step 7: Verify typecheck + tests + dev server**

Run: `npx tsc --noEmit` — no errors
Run: `npm test` — still 179 passing
Run: `npm run dev` in background. Then:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3334/viewer
curl -s http://localhost:3334/viewer/graph-viewer-2d.js | grep -c "fitToBounds\|zoomAtPoint\|hasInitiallyFit"
```

Expected: `200`, then ≥ 3.

Kill dev server (`pkill -f "tsx src/index.ts"`).

- [ ] **Step 8: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): wire camera transform into render + hit-test + fit-on-load"
```

---

### Task 5: Pan — drag empty canvas

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Add pan state and handlers**

In `src/viewer/graph-viewer-2d.js`, find the existing hover detection section (starts with `let hoveredId = null;` and includes the `canvas.addEventListener('pointermove', ...)` handler).

**Before** the existing `pointermove` handler, add new pan state + `pointerdown` handler:

```js
// --- Pan state ---
let isPanning = false;
let panStart = null;  // { screenX, screenY, cameraX, cameraY }

canvas.addEventListener('pointerdown', (ev) => {
  // Only pan if no node is under the cursor (otherwise let click/dblclick through).
  if (pickNodeAt(ev)) return;
  isPanning = true;
  panStart = { screenX: ev.clientX, screenY: ev.clientY, cameraX: camera.x, cameraY: camera.y };
  canvas.classList.add('panning');
  canvas.setPointerCapture(ev.pointerId);
});
```

Update the existing `pointermove` handler so it early-returns (doing pan) if a pan is active. At the very top of the existing `pointermove` listener body, add:

```js
  if (isPanning && panStart) {
    const dx = (ev.clientX - panStart.screenX) / camera.zoom;
    const dy = (ev.clientY - panStart.screenY) / camera.zoom;
    camera = { ...camera, x: panStart.cameraX - dx, y: panStart.cameraY - dy };
    // Cancel any in-progress lerp — user is driving the camera now.
    targetCamera = null;
    return;
  }
```

Add a `pointerup` / `pointercancel` handler after the existing `pointerleave` handler:

```js
function endPan(ev) {
  if (!isPanning) return;
  isPanning = false;
  panStart = null;
  canvas.classList.remove('panning');
  if (ev && ev.pointerId !== undefined) {
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
  }
}

canvas.addEventListener('pointerup', endPan);
canvas.addEventListener('pointercancel', endPan);
```

Also update the existing `pointerleave` handler to call `endPan()` before its current body:

Find the existing:

```js
canvas.addEventListener('pointerleave', () => {
  hoveredId = null;
  clearHover(anim);
  tooltip.classList.remove('show');
});
```

Replace with:

```js
canvas.addEventListener('pointerleave', (ev) => {
  endPan(ev);
  hoveredId = null;
  clearHover(anim);
  tooltip.classList.remove('show');
});
```

- [ ] **Step 2: Suppress click when a pan just ended**

A drag that ends on a node should not fire `click` (which would open the detail panel). Track a "just panned" flag:

After the pan state declarations, add:

```js
let didPan = false;
```

Inside the pan branch of `pointermove` (the `if (isPanning && panStart)` block you added), at the top of the if-body add:

```js
    didPan = true;
```

In `endPan`, reset after a short delay so the click fires after `pointerup` don't open anything by mistake:

```js
function endPan(ev) {
  if (!isPanning) return;
  isPanning = false;
  panStart = null;
  canvas.classList.remove('panning');
  if (ev && ev.pointerId !== undefined) {
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
  }
  // Keep didPan set through the immediately-following click event, clear after.
  setTimeout(() => { didPan = false; }, 0);
}
```

Guard the existing `canvas.addEventListener('click', ...)` handler. Find the existing click handler body (it currently calls `pickNodeAt` then `showDetail` or `closeDetail`). Prepend:

```js
  if (didPan) return;
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — no errors
Run: `npm test` — 179 passing
Run: `npm run dev` — curl the served JS to confirm pan code is there:

```bash
curl -s http://localhost:3334/viewer/graph-viewer-2d.js | grep -c "isPanning\|panStart\|endPan"
```

Expected: ≥ 3.

Kill dev server.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): pan — drag empty canvas to translate the view"
```

---

### Task 6: Zoom (wheel)

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Add wheel handler**

In `src/viewer/graph-viewer-2d.js`, after the pan handlers added in Task 5 (right after the `canvas.addEventListener('pointercancel', endPan);` line), insert:

```js
canvas.addEventListener('wheel', (ev) => {
  if (ev.deltaY === 0) return;
  ev.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;
  const factor = Math.exp(-ev.deltaY * 0.001);
  camera = zoomAtPoint(camera, factor, sx, sy, rect.width, rect.height);
  targetCamera = null;  // user-driven zoom cancels any in-progress animation
}, { passive: false });
```

(`{ passive: false }` is needed because we call `preventDefault()`.)

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` — no errors
Run: `npm test` — 179 passing
Run: `npm run dev`, curl:

```bash
curl -s http://localhost:3334/viewer/graph-viewer-2d.js | grep -c "zoomAtPoint\|wheel"
```

Expected: ≥ 2 (imports + listener).

Kill dev server.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): zoom on wheel (trackpad pinch path included)"
```

---

### Task 7: Recenter — F/R key + toolbar button + lerp animation

**Files:**
- Modify: `src/viewer/index.html`
- Modify: `src/viewer/style.css`
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Add recenter button to the toolbar**

In `src/viewer/index.html`, inside the `#toolbar` div, after the `#search-group` div and before the `#filters` div, add:

```html
<button id="recenter-btn" title="Recenter (F)" aria-label="Recenter view">⤢</button>
```

(The `⤢` glyph is `U+2922` — a diagonal resize arrow. Renders as a clean compact icon in Geist Mono.)

- [ ] **Step 2: Add button styling**

Append to `src/viewer/style.css`:

```css
/* -- Recenter button -- */
#recenter-btn {
  background: transparent;
  border: 1px solid #222;
  color: #888;
  font-family: "Geist Mono", monospace;
  font-size: 14px;
  padding: 3px 8px;
  border-radius: 3px;
  cursor: pointer;
  line-height: 1;
}
#recenter-btn:hover {
  color: #ccc;
  border-color: #444;
}
```

- [ ] **Step 3: Wire recenter in the entry file**

In `src/viewer/graph-viewer-2d.js`, after the camera state declarations near the top (where `let hasInitiallyFit = false;` lives), add a helper:

```js
function recenter() {
  targetCamera = fitToBounds(
    state.nodes.values(),
    canvas.clientWidth,
    canvas.clientHeight,
    40,
  );
}
```

At the end of the file (or near the existing `window.addEventListener('keydown', ...)` handler — **don't** replace it, just add a new one):

```js
document.getElementById('recenter-btn').addEventListener('click', recenter);

window.addEventListener('keydown', (ev) => {
  if (document.activeElement === searchInput) return;
  if (ev.key === 'f' || ev.key === 'F' || ev.key === 'r' || ev.key === 'R') {
    ev.preventDefault();
    recenter();
  }
});
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` — no errors
Run: `npm test` — 179 passing
Run: `npm run dev`, curl:

```bash
curl -s http://localhost:3334/viewer | grep -c "recenter-btn"
curl -s http://localhost:3334/viewer/graph-viewer-2d.js | grep -c "recenter\|targetCamera"
```

Expected: ≥ 1 and ≥ 3.

Kill dev server.

- [ ] **Step 5: Commit**

```bash
git add src/viewer/index.html src/viewer/style.css src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): recenter — F/R key + toolbar button with lerp animation"
```

---

### Task 8: Pan-to-fit on focus mode + Esc returns to full view

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Update the dblclick handler to pan-to-fit focus**

In `src/viewer/graph-viewer-2d.js`, find the existing `canvas.addEventListener('dblclick', ...)` handler. Its current body identifies the node, sets `focusId` and `focusSet`. Replace with:

```js
canvas.addEventListener('dblclick', (ev) => {
  const best = pickNodeAt(ev);
  if (best) {
    focusId = best.id;
    focusSet = bfsNeighborhood(best.id, 1);
    // Animate camera to fit the focused subgraph.
    const focusedNodes = [...state.nodes.values()].filter((n) => focusSet.has(n.id));
    targetCamera = fitToBounds(
      focusedNodes,
      canvas.clientWidth,
      canvas.clientHeight,
      80,
    );
  }
});
```

- [ ] **Step 2: Update the Escape handler to also re-fit after clearing focus**

Find the existing `window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { ... }` handler.

(Task 7 added a second `keydown` listener for F/R; leave that alone.)

In the Escape branch, after `focusId = null; focusSet = null;`, add:

```js
    targetCamera = fitToBounds(
      state.nodes.values(),
      canvas.clientWidth,
      canvas.clientHeight,
      40,
    );
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` — no errors
Run: `npm test` — 179 passing
Run: `npm run dev`, curl:

```bash
curl -s http://localhost:3334/viewer/graph-viewer-2d.js | grep -c "focusedNodes\|fitToBounds"
```

Expected: ≥ 3 (import + dblclick use + Escape use).

Kill dev server.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): focus mode + Esc animate camera via fit-to-bounds"
```

---

### Task 9: Zoom-gated persistent labels

**Files:**
- Modify: `src/viewer/graph-viewer-2d.js`

- [ ] **Step 1: Add a `drawLabels()` screen-space pass**

In `src/viewer/graph-viewer-2d.js`, find the `function draw() { ... }` definition. At the very end of `draw()`, after the final `ctx.restore();` call, add a `drawLabels()` invocation:

```js
  ctx.restore();

  drawLabels();
}
```

Immediately after `draw()`, define `drawLabels()`:

```js
function drawLabels() {
  ctx.save();
  ctx.font = '11px "Geist Mono", monospace';
  ctx.textBaseline = 'middle';

  for (const node of state.nodes.values()) {
    if (!isVisible(node)) continue;

    // Per-kind fade windows.
    let alpha = 0;
    if (node.kind === 'decision') {
      alpha = 1;
    } else if (node.kind === 'file') {
      // 0.4 → 0.6 linear
      const t = (camera.zoom - 0.4) / 0.2;
      alpha = t <= 0 ? 0 : t >= 1 ? 1 : t;
    } else {
      // functions, components, references, paths: 0.9 → 1.1 linear
      const t = (camera.zoom - 0.9) / 0.2;
      alpha = t <= 0 ? 0 : t >= 1 ? 1 : t;
    }

    if (alpha <= 0) continue;

    // Search dim also applies to labels.
    if (searchQuery && !searchMatch(node, searchQuery)) alpha *= 0.15;

    const [sx, sy] = camWorldToScreen(
      camera,
      node.x ?? 0,
      node.y ?? 0,
      canvas.clientWidth,
      canvas.clientHeight,
    );
    // Offset label to the right of the node (size scales with on-screen apparent size).
    const offset = nodeSize(node.kind) * camera.zoom + 4;
    ctx.fillStyle = 'rgba(153,153,153,' + alpha + ')';   // #999
    ctx.fillText(String(node.name || ''), sx + offset, sy + 3);
  }

  ctx.restore();
}
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit` — no errors
Run: `npm test` — 179 passing
Run: `npm run dev`, curl:

```bash
curl -s http://localhost:3334/viewer/graph-viewer-2d.js | grep -c "drawLabels\|textBaseline\|fillText"
```

Expected: ≥ 3.

Kill dev server.

- [ ] **Step 3: Commit**

```bash
git add src/viewer/graph-viewer-2d.js
git commit -m "feat(viewer): zoom-gated persistent labels (decisions always, files ≥0.5×, others ≥1×)"
```

---

## Post-implementation manual verification

After all tasks land, run `npm run dev` and open [http://localhost:3334/viewer](http://localhost:3334/viewer). Verify the following (not automated — user-visible behavior):

1. **Fit-on-load:** graph fills the viewport with padding; no nodes clipped off-screen at boot.
2. **Pan:** drag on empty canvas — view translates, cursor changes to grabbing, clicking after a drag does NOT open the detail panel.
3. **Zoom:** mouse wheel / trackpad pinch — zooms at cursor position; the world point under cursor stays under cursor. Clamps at 0.2 and 5.
4. **Recenter:** press `F` (or `R`, or click the button) — camera animates smoothly back to fit over ~300ms.
5. **Zoom-gated labels:** at default fit-zoom, decision titles are visible always; zoom in past 0.5× → file names appear; past 1× → function/component/reference/path names appear. Labels don't pop binary — they fade.
6. **Focus mode:** dblclick a decision — camera smoothly pans/zooms to fit the 1-hop subgraph with padding. `Esc` — camera smoothly returns to the full-graph fit.
7. **Shape & clustering:** compared to before, the graph settles into a visibly circular disk. Connected nodes bunch into visible clusters. Overall reads like the Obsidian reference.
8. **Search:** type "auth" (or any substring that matches a few nodes) — matched subgraph stays bright; everything else dims to ~15%; edges between matches stay bright; edges crossing into non-matches dim. Hovering a dimmed node still works (hover locally overrides dim). `Esc` inside the search field clears + blurs. `/` focuses the search field from anywhere.
9. **Match count:** shows `N / M` in the search input while a query is active; hides when empty.
10. **Regression check:** existing Plan B behaviors still work — hover highlights neighbors, click opens detail panel, detail panel connection links navigate, kind-filter checkboxes hide kinds (distinct from search dim), synapse ring appears on `add_node`, pulse appears on `add_edge`.

If any of the above fails, that's either a regression to fix or a tuning call (force params) — address before merge.

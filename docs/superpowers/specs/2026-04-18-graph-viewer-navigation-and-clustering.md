# 2D Graph Viewer — Navigation, Clustering, Search UX

**Date:** 2026-04-18
**Status:** Approved
**Extends:** [2026-04-17 graph UI and activity stream](2026-04-17-graph-ui-and-activity-stream-design.md) (Plan B shipped the 9-step ladder; this spec addresses gaps found on first use)

## Goal

Close three gaps in the shipped 2D viewer: there is no way to navigate (no pan, no zoom, graph silently extends past the viewport); the force simulation settles into a diffuse cloud rather than the Obsidian-style emergent disk the inspiration called for; and search hides non-matches with `continue` in the draw loop, destroying the structural context that makes the graph legible.

Visuals (palette, shapes, sizing, lavender-diamond decisions) are **not** changing. What changes is where nodes end up on screen, how the viewer frames them, and how search presents matches.

## Scope summary

**In scope:**
- Pan (drag empty canvas), zoom (wheel / pinch via `wheel` + `ctrlKey`), fit-to-viewport on load, `F`/`R` key + toolbar button to re-fit, pan-to-fit when entering focus mode
- Zoom-gated persistent labels (decisions always, files at ≥0.5×, all kinds at ≥1×)
- Force-simulation re-tune for the emergent disk shape (stronger centering, tighter link distances, easier charge)
- Search rework: non-matches dim to 0.15 instead of being hidden; kind filter + focus mode keep current hide semantics
- One new pure module (`shared/camera.js`) with unit tests

**Deferred (out of scope):**
- Node drag (d3-force `.drag()` wiring)
- Minimap
- Touch / mobile (pinch + two-finger pan handled *only* via the `wheel` + `ctrlKey` path that browsers synthesize on trackpads)
- Keyboard shortcuts beyond `F` / `R` / `Esc`
- Mouse double-click-to-zoom-to-fit (dblclick remains bound to focus mode)
- Community detection (Louvain), cluster coloring, spatial cluster separation
- Temporal slider, gap detection, decision-panel enrichments

## Navigation

### Camera model

New pure module [src/viewer/shared/camera.js](../../src/viewer/shared/camera.js):

```
Camera = { x: number, y: number, zoom: number }
```

- `x, y` — world-space translation. The world origin (0,0) is where d3-force centers the graph.
- `zoom` — scalar; `1` means 1:1 world-to-screen. Clamped to `[0.2, 5]`.

Exported pure helpers:

- `createCamera()` → `{ x:0, y:0, zoom:1 }`
- `clampZoom(z)` → clamp to `[0.2, 5]`
- `screenToWorld(camera, sx, sy, canvasW, canvasH)` → `[wx, wy]`
- `worldToScreen(camera, wx, wy, canvasW, canvasH)` → `[sx, sy]`
- `fitToBounds(nodes, canvasW, canvasH, padding=40)` → new `Camera` framing the given nodes. With 0 nodes returns identity; with 1 node, centers that node at `zoom=1`.
- `zoomAtPoint(camera, factor, sx, sy, canvasW, canvasH)` → new `Camera` after zooming by `factor` so the world point under `(sx,sy)` stays under the cursor.
- `lerpCamera(from, to, t)` → per-frame interpolation for smooth animations.

All helpers are testable in Node without a canvas.

### Pan

- `pointerdown` on the canvas where `pickNodeAt(ev) === null` begins a pan. Cursor changes to `grabbing`. Drag deltas apply to `camera.x / camera.y` scaled by `1/camera.zoom`.
- `pointerup` / `pointerleave` / `pointercancel` ends the pan; cursor returns to default.
- `pointerdown` on a node is ignored by the pan handler; the click / dblclick handlers still fire.

### Zoom

- `wheel` events call `zoomAtPoint(camera, exp(-event.deltaY * 0.001), cursorX, cursorY, W, H)`. `preventDefault()` to stop page scroll.
- On trackpads the browser emits `wheel` with `ctrlKey=true` for pinch. Same handler; no separate pinch code.
- Clamped to `[0.2, 5]`.

### Fit-to-viewport on load

After hydrate, the first few `simulation.tick()` calls run before nodes have stable positions. The viewer calls `fitToBounds(state.nodes.values(), W, H)` once when `simulation.alpha() < 0.8` **or** after ~30 ticks, whichever first, and sets the camera with no animation. Re-fitting is not automatic beyond this — users re-fit explicitly via the recenter affordance.

Guard: a graph with <2 nodes skips the fit and keeps `{0,0,1}`.

### Recenter

- Keyboard `F` or `R` (non-modifier, not inside an input) → compute `fitToBounds(...)`, set as camera *target*, animate over 300ms via `lerpCamera`.
- Toolbar button with the same behavior, positioned next to the search input in `#toolbar`.
- A stored `targetCamera` is consumed by the render loop each frame: `camera = lerpCamera(camera, targetCamera, 0.15)` until `|camera − targetCamera| < ε`, then clear.

### Zoom-gated labels

- Decisions always show their title (11px Geist Mono, color `#999`, offset `(nodeSize + 4, 3)` from node center).
- File labels fade in linearly from zoom 0.4 → 0.6 (α 0 → 1).
- All other kinds (functions, components, references, paths) fade in linearly from zoom 0.9 → 1.1 (α 0 → 1).
- Labels are drawn in screen-space after the world-space draw — caller does `ctx.restore()` before the label pass and computes screen positions via `worldToScreen`. Font size is constant regardless of zoom.

### Pan-to-fit on focus

When `dblclick` enters focus mode, the viewer computes `fitToBounds(nodesIn(focusSet), W, H, padding=80)` and sets it as the camera target; the same `lerpCamera` loop handles the animation. `Esc` (which already clears focus) also calls `fitToBounds` on the whole graph as the new target, so the camera smoothly returns.

### Hit-test update

The existing `pickNodeAt(ev)` takes an event and returns the node under the cursor (or `null`). It currently uses hardcoded center math and does not account for camera. New implementation:

```js
function pickNodeAt(ev) {
  const rect = canvas.getBoundingClientRect();
  const [wx, wy] = screenToWorld(camera, ev.clientX - rect.left, ev.clientY - rect.top, rect.width, rect.height);
  let best = null, bestDist = Infinity;
  for (const node of state.nodes.values()) {
    const dx = (node.x ?? 0) - wx;
    const dy = (node.y ?? 0) - wy;
    const d = dx * dx + dy * dy;
    const r = (nodeSize(node.kind) + 3) / camera.zoom;  // world-space radius
    if (d < r * r && d < bestDist) { best = node; bestDist = d; }
  }
  return best;
}
```

The `/camera.zoom` term keeps the hit radius at the apparent on-screen size of the node: a 5px-at-1×-zoom node is still 5px-target at 2× zoom.

### Render loop wiring

`draw()` adds camera transforms once at the top, draws world-space content (edges + nodes + synapses), then restores and draws labels in screen-space:

```js
function draw() {
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  ctx.save();
  ctx.translate(canvas.clientWidth / 2, canvas.clientHeight / 2);
  ctx.scale(camera.zoom, camera.zoom);
  ctx.translate(-camera.x, -camera.y);

  drawEdges();
  drawNodes();
  drawSynapses();

  ctx.restore();

  drawLabels();   // screen-space, zoom-gated
}
```

The existing `worldToScreen` helper in the entry file becomes thin: `[node.x, node.y]` are already world-space inside the transformed context. Label positions still use `worldToScreen(camera, ...)` for their screen-space placement.

## Force tuning — emergent disk

Direction: stronger centering + tighter links + slightly easier charge. No new forces; no clustering algorithm.

| parameter | current | proposed | role |
|---|---|---|---|
| `forceCenter(0,0).strength` | 0.03 | **0.12** | Primary lever. Pulls the whole graph into a disk. |
| `LINK_DIST.GOVERNS` | 70 | **45** | Tight hub-spoke for decision clusters. |
| `LINK_DIST.CALLS` | 80 | **55** | Tight function clusters. |
| `LINK_DIST.IMPORTS` | 100 | **70** | Tighter module structure. |
| `LINK_DIST.SUPERSEDES` | 60 | **40** | Chain stays compact. |
| `LINK_DIST.REFERENCES` | 100 | **70** | External refs closer. |
| `LINK_DIST['co-changed']` | 200 | **140** | Still the widest; still loose. |
| `CHARGE.decision` | -300 | **-220** | Eased so center force can compress. |
| `CHARGE.file` | -100 | **-80** | Same. |
| `CHARGE.function` | -50 | **-40** | Same. |
| `CHARGE.component` | -50 | **-40** | Same. |
| `CHARGE.reference` | -50 | **-40** | Same. |
| `CHARGE.path` | -30 | **-25** | Same. |
| `LINK_STR.*` | unchanged | unchanged | Relative balance is already right. |
| `forceCollide(nodeSize + 4)` | unchanged | unchanged | Prevents overlap at tight distances. |
| `SIZE.*` | unchanged | unchanged | Visuals locked. |

These are **first-draft** numbers. The implementer is expected to run `npm run dev`, compare the result to the Obsidian reference screenshot, and adjust `forceCenter.strength` (±0.05) and `LINK_DIST.GOVERNS` (±10) until the disk holds with visible clusters. The relative shape of the table should be preserved.

**Mutation reheat** (`alpha(0.3)`) is unchanged. With tighter forces, the viewer re-equilibrates in ~1.5–2s, similar to current behavior.

## Search UX — dim, don't hide

### Current (ships today)

```js
function isVisible(node) {
  if (focusSet && !focusSet.has(node.id)) return false;
  if (!activeKinds.has(node.kind)) return false;
  if (searchQuery && !node.name.toLowerCase().includes(searchQuery)) return false;
  return true;
}
// draw(): if (!isVisible(node)) continue;
```

Non-matches disappear; the structural context users rely on to read the graph is destroyed.

### New

`isVisible` keeps only hide-style gates (focus + kind). Search becomes a **dim multiplier** applied in the alpha composition:

```js
function isVisible(node) {
  if (focusSet && !focusSet.has(node.id)) return false;
  if (!activeKinds.has(node.kind)) return false;
  return true;
}

function searchMatch(node) {
  return !searchQuery || node.name.toLowerCase().includes(searchQuery);
}
```

Inside the nodes loop:

```js
const matches   = searchMatch(node);
const searchDim = (searchQuery && !matches) ? 0.15 : 1.0;
const finalAlpha = existingComposite * searchDim;
```

Inside the edges loop (edge is bright only when **both** endpoints match):

```js
const edgeBright  = !searchQuery || (searchMatch(a) && searchMatch(b));
const edgeDimMult = edgeBright ? 1.0 : 0.15;
// applied to the edge's already-composed alpha
```

### Interactions

- **Hover while search is active:** hover wins locally. A hovered node lights up regardless of match; its neighbors follow the normal hover rules. Lets the user investigate a hovered cluster without clearing the search.
- **Kind filter:** still hides. Unchecking "function" removes functions from the draw pass entirely; search dims within the remaining set.
- **Focus mode:** still limits the graph via `focusSet`. Search dims within the 1-hop subset.
- **Status (proposed / superseded):** status alpha (0.4) composes with search dim (0.15), so a proposed non-match renders at 0.06. Intentionally very dim.

### Affordances

- `/` key focuses the search input (not captured while already focused inside an input).
- `Esc` inside the search input clears its value and blurs.
- Small right-aligned match count inside the input container: `3 / 48`. If it feels noisy during implementation, drop it.

## Architecture

No new subsystems. Wiring changes to the entry file:

```
shared/camera.js         NEW — pure camera state + transform math
         │
         ▼
graph-viewer-2d.js
  ├── camera: Camera (mutable state)
  ├── targetCamera: Camera | null (drives lerpCamera per frame)
  ├── pointer handlers:
  │     pointerdown  → pan-start OR (delegated to click/dblclick if on a node)
  │     pointermove  → pan OR hover
  │     pointerup    → pan-end
  │     wheel        → zoomAtPoint
  ├── keyboard:
  │     F / R → fitToBounds → targetCamera
  │     Esc   → clear search (existing) + exit focus (existing)
  ├── render:
  │     ctx.save → translate + scale → drawEdges/Nodes/Synapses → ctx.restore
  │     drawLabels (screen-space, zoom-gated)
  └── search:
        isVisible gates hide; searchMatch multiplies alpha
```

Force tuning is a pure data change — `shared/layout.js` number edits only.

## Data flow

Unchanged from Plan B. `/api/graph` hydrates once; `/ws` streams mutations via `applyMutation` + `syncSimulation(alpha=0.3)`. Camera and search live entirely client-side and never touch the event pipeline.

## Error handling

| failure | response |
|---|---|
| `fitToBounds` with 0 nodes | return identity camera `{0,0,1}` |
| `fitToBounds` with 1 node | center that node at zoom=1 |
| `wheel` with `deltaY === 0` | no-op |
| Zoom hits clamp boundary | silently clamped; no error |
| Focus on an id that raced removal | fallback to fit whole graph |
| Pan starts then cursor leaves window | treat `pointerleave` / `pointercancel` as `pointerup` |
| Malformed search regex characters | irrelevant — we use `String.prototype.includes`, not regex |

## Testing strategy

| layer | how | what |
|---|---|---|
| `camera.js` pure helpers | Vitest | `clampZoom` boundaries; `screenToWorld` / `worldToScreen` round-trip; `fitToBounds` with 0 / 1 / many nodes (assert zoom & translate shape); `zoomAtPoint` pivot invariant (world point under cursor stays under cursor); `lerpCamera` endpoints |
| `layout.js` numbers | Vitest | existing relative orderings (unchanged); new pinned assertion `createSimulation().force('center').strength() > 0.05` |
| `searchMatch` helper | Vitest | empty query → true for any node; case-insensitive substring match; matches on `name` only (not kind / path / data) |
| Render / pan / zoom / dim / zoom-labels / pan-to-fit | manual in `npm run dev` | visual. Verify: graph fills viewport at load; wheel zooms at cursor; drag pans without rubber-banding; `F` recenters smoothly; decision labels always visible, file labels appear at 0.5×; searching "auth" (or whatever) dims rest, matched subgraph stays legible; focus-mode smoothly re-frames |

All 161 existing tests must continue to pass. `npx tsc --noEmit` clean.

## File structure

**New:**

```
src/viewer/shared/
  camera.js                          pure camera state + transform math
tests/viewer/
  camera.test.ts
```

**Modified:**

```
src/viewer/graph-viewer-2d.js        camera wiring, pan/zoom/wheel/keyboard, render transform,
                                     label pass, search-dim path, hit-test update
src/viewer/shared/layout.js          re-tuned force numbers (table above)
src/viewer/index.html                recenter button in #toolbar; match-count span in search
src/viewer/style.css                 recenter button style, grabbing cursor during pan
tests/viewer/layout.test.ts          pinned forceCenter.strength assertion
```

No new runtime dependencies. `d3-force` is already a devDependency for Vitest.

## Future extensibility

Items deferred from this spec that slot in without structural refactor:

| future feature | what v1 already supports |
|---|---|
| Node drag | `fx`/`fy` pinning is a d3-force primitive; add a `drag` handler that calls `camera.screenToWorld` + sets `fx/fy`. No camera changes. |
| Minimap | `fitToBounds` already tells you the world bounds; a minimap is a second canvas drawing a scaled projection + a viewport rectangle derived from `camera`. |
| Touch / pinch | Pointer events API already abstracts touch from mouse for pan; pinch-zoom via the Pointer Events multi-touch model is a separate handler that reuses `zoomAtPoint`. |
| Louvain / cluster coloring | Would attach a `cluster_id` on nodes at the server or derive client-side; render reads it and maps to a new palette. No force changes needed. |
| Temporal slider | Server backfills past events; client replays mutations with camera + search state preserved. |

## Open items explicitly out of scope

- Redoing the entire simulation as a GPU-accelerated worker (not needed at current scale).
- Alternative layouts (concentric, ring-structured) — the "A" direction was chosen; the other options are gone.
- Sync with the activity stream (Plan C).
- Any change to decision-node visual language (diamond + lavender stay).

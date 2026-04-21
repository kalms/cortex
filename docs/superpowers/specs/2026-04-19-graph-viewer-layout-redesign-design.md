# Graph Viewer: Layout Redesign — Structure Primary, Circular, Obsidian-Like

> Design spec. Started 2026-04-19.
>
> **Supersedes (revises) parts of:**
> - [2026-04-18 Graph viewer LOD projection design](./2026-04-18-graph-viewer-lod-projection-design.md)
>
> Keeps the projection/reheat/transitions architecture; replaces the band
> table, force model, supernode sizing, search navigation, and pan/zoom
> controller.

## Why revise

The LOD projection spec shipped and hand-QA revealed four problems that are
not tuning issues:

1. **Wrong floor at max zoom-out.** The shipped band table made decisions +
   top-level path groups co-equal at `<0.4×`. In use, project structure is
   the backbone humans navigate by; decisions are esoteric satellites that
   can span multiple regions. The current view inverts the right priority.
2. **Not dense enough.** Nodes sprawl instead of clumping into identifiable
   regions, so when you zoom out the graph loses orientation ("what am I
   looking at?"). Obsidian's graph view achieves this with strong
   link attraction + weak repulsion + no collision bubble; ours has the
   opposite balance, tuned for close-zoom readability.
3. **Viewport footprint drifts with zoom.** Nodes scale with zoom (good),
   but the graph's natural radius grows/shrinks with visible node count,
   so the overview doesn't *stay* an overview — it becomes a tiny dot or a
   sprawl depending on where you are.
4. **Search doesn't navigate.** Matches force-visible, but the camera
   doesn't move. The match is somewhere on the canvas and the user has no
   affordance to find it.

A live d3-force prototype ([`.superpowers/brainstorm/23378-*/content/layout-prototype.html`](../../../.superpowers/brainstorm/))
validated the revised force model before writing this spec.

## Summary of changes

- **Band table inverted** — structure is the backbone; decisions are
  satellites pulled toward the regions they govern.
- **Soft boundary** replaces the inner-attractor radial force — nodes
  place freely inside, pushed back only when they drift past the circle.
- **Group gravity** clumps siblings around a shared centroid.
- **Governance gravity** pulls decisions toward the centroid of their
  territories' visible members.
- **Adaptive forces** — link distance and charge scale with visible node
  count so graph radius stays ~constant viewport real estate across bands.
- **Label-fit sizing** for supernodes — the rounded rect grows to its
  label width (`src/events/` vs `docs/superpowers/` are visibly different
  widths). Collide radius follows the box.
- **Search navigates** — camera pans/zooms to match(es); multi-match
  picker chip for disambiguation.
- **Pan/zoom is mode-aware** — auto-fit in overview mode; free pan+zoom
  in focus mode.

## Design principles (revised)

1. **Project structure is the backbone.** Decisions, territories, and all
   other semantic overlays attach to structure — they never replace it
   as the "skeleton" view.
2. **Circular is the target shape.** The graph should look like a
   coherent disc at any band, not a blob or ring.
3. **Viewport footprint is invariant.** Zoom is semantic (reveals detail
   within the same shape), not geometric (graph grows/shrinks). Forces
   adapt to visible node count so the graph fills ~same viewport fraction
   at every band.
4. **Soft containment, free placement.** Nodes are free to settle
   anywhere inside the target circle; a boundary force only kicks in if
   they drift past. No inner attractor pulling toward a ring.
5. **Clumps over sprawl.** Sibling nodes (same path-group) share an
   attractor so related things physically gather. Overlap is fine at
   overview — shape reads as region identity, not individual-node
   legibility.
6. **Search is navigation, not just filtering.** Typing a query moves the
   camera.
7. **Preserved:** all other principles from 2026-04-18 — purity,
   client-only, synthesized groups, pleasant transitions, legibility
   floors, selection-as-render-state.

---

## §1 — Band table (inverted)

Replaces the 2026-04-18 band table ([§2 there](./2026-04-18-graph-viewer-lod-projection-design.md#zoom-band-table-starting-point--iterate)).

| Zoom | Visible |
|---|---|
| Overview (≤0.4×) | **Depth-2 path supernodes** + decisions (as satellites) + territory hulls |
| Mid (0.4–1.0×) | Depth-3 path supernodes + decisions + territories + loose root files |
| Close (1.0–2.0×) | Files + decisions + territories + major functions |
| Detail (>2.0×) | Files + functions + references (current end-state) |

### What "depth-2" means

Collapse every leaf node to its second path segment.

- `src/events/worker/persister.ts` → supernode `src/events/`
- `src/viewer/shared/projection.js` → supernode `src/viewer/`
- `docs/superpowers/specs/foo.md` → supernode `docs/superpowers/`
- A file at the root (e.g. `README.md`) → stays as itself (depth-0 singleton)

The top-level directory alone (`src/`, `docs/`) does **not** appear — its
children at depth 2 do. That produces ~10–15 supernodes on a Cortex-sized
repo: enough shape, not crowded.

### Decisions at overview

Decisions are still always-visible, but their *position* no longer
co-dominates the layout. A new governance-gravity force (§2.3) pulls each
decision toward the centroid of its territory's visible members. They
float as satellites around the structural backbone. Territory hulls
wrap the governed supernodes tightly.

This matches the mental model: "decisions are esoteric and can have
larger contexts — they influence areas of the codebase rather than being
peers of them."

---

## §2 — Force model

Three new forces + one replacement + one adaptive scaling layer.

### 2.1 Soft boundary (replaces `forceRadial`)

```js
function forceBoundary(radius, strength, cx, cy) {
  function f(alpha) {
    for (const n of nodes) {
      const dx = n.x - cx, dy = n.y - cy;
      const d = Math.hypot(dx, dy);
      if (d > radius) {
        const excess = d - radius;
        const factor = strength * alpha * (excess / d);
        n.vx -= dx * factor;
        n.vy -= dy * factor;
      }
    }
  }
  // + initialize, strength, radius setters
}
```

- **Only active outside `radius`.** Inside the circle there is zero radial
  contribution. Nodes are free to cluster wherever group/charge/link
  forces settle them.
- **Strength scales with excess distance.** A node just outside the
  boundary feels a small nudge; one far outside feels a hard spring.
  This produces a soft wall with a natural "give."
- **`radius` is derived from viewport.** `R = min(W, H) * target_fraction`
  where `target_fraction ≈ 0.40` (tunable; prototype default).

Default strength: `0.8` (prototype-validated). Decisions feel the same
strength as supernodes — the boundary treats all kinds equally.

### 2.2 Group gravity (new)

Each leaf or depth-3 supernode feels a pull toward its path-group's
centroid (where the group is the immediate parent in the projection).
Supernodes themselves do **not** feel group gravity — they're the
anchors others pull toward.

```js
function forceGroup(strength) {
  function f(alpha) {
    // Compute group centroids from current positions
    // For each non-super node, vx += (groupCentroid.x - n.x) * strength * alpha
  }
}
```

Default strength: `0.35`. The Obsidian-like tightness comes from turning
this up to `0.6–0.9`; the v1 default is a compromise that still lets
individual nodes breathe.

### 2.3 Governance gravity (new)

Each decision feels a pull toward the centroid of its territory's
currently-visible members.

```js
function forceGovernance(strength) {
  function f(alpha) {
    for (const d of decisions) {
      const members = d.governs.map(id => byId[id]).filter(Boolean);
      if (!members.length) continue;
      const tx = mean(members.map(m => m.x));
      const ty = mean(members.map(m => m.y));
      d.vx += (tx - d.x) * strength * alpha;
      d.vy += (ty - d.y) * strength * alpha;
    }
  }
}
```

Default strength: `0.25`. Decisions with empty territories (all members
folded/filtered) fall back to free placement — no NaN, no drift.

### 2.4 Adaptive scaling (new)

`linkDistance` and `charge` scale inversely with `sqrt(visibleNodeCount)`
so the graph's natural radius stays ≈ `R` across bands.

```js
const adapt = 50 / Math.max(1, Math.sqrt(N_visible));
// link.distance(baseDist * userMultiplier * adapt)
// charge.strength(baseCharge * adapt)
```

Without this, N=17 (overview) and N=300 (detail) produce wildly
different natural radii. With it, the force equilibrium keeps the graph
close to the target size, and the soft boundary handles the remainder.

The prototype confirmed this: Overview → Mid → Close → Detail each settle
at ≈87% viewport fill with adaptation on; without adaptation the graph
grows to 3–4× viewport at Detail.

### 2.5 Retained forces

- **`forceLink`** — same role as today, distance formula updated per 2.4.
- **`forceManyBody`** (charge) — same role, strength formula updated.
- **`forceCollide`** — radius now derives from each node's dimensions
  (supernode `boxW × boxH` → bounding radius; decisions → `world + 8`;
  leaves → `world + 2`).

---

## §3 — Supernode sizing by label

Replaces the shipped `4 + 2*log2(members)` formula ([2026-04-18 §3](./2026-04-18-graph-viewer-lod-projection-design.md#the-sizeatkind-zoom-model)).

### Dimensions

```js
function supernodeDims(label) {
  ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
  const tw = ctx.measureText(label).width;
  return {
    w: Math.max(32, Math.round(tw + 18)),   // text + horizontal padding
    h: 20,                                   // constant height
    radius: Math.max(w, h) / 2,              // for collide + centering
  };
}
```

- **Width = label width + padding.** `src/ws/` (narrow) and
  `docs/superpowers/` (wide) have visibly different boxes.
- **Height constant.** Keeps alignment predictable.
- **Collide radius = half the bounding box diagonal.** Ensures labels
  never overlap at rest regardless of width.
- **Count pill unchanged** (`· 18`) below the rounded rect.

### Minimum width

`min_width = 32px` so even a `ws/` box doesn't look pinched. No
`max_width` — labels are truncated at 24 chars upstream (§4 of 2026-04-18
still applies).

### What about leaves, decisions, functions?

Their sizing is **unchanged** from the shipped model — circles/diamonds
with `world` radius clamped by `min_px/max_px`. Only supernodes get
label-fit sizing because only supernodes have labels that meaningfully
vary in length at overview zoom.

---

## §4 — Labels at each band

Refines [2026-04-18 §5](./2026-04-18-graph-viewer-lod-projection-design.md#rendering--transitions).

| Band | Supernodes | Decisions | Files | Functions |
|---|---|---|---|---|
| Overview (≤0.4×) | full path (`src/events/`) + count pill | title (trunc 24ch) | — | — |
| Mid (0.4–1.0×) | full path + count pill | title (full) | name at zoom ≥0.7× | — |
| Close (1.0–2.0×) | fade out as they expand | title | name | functions above degree threshold (tunable; default `deg ≥ 3`) |
| Detail (>2.0×) | — | title | name | name |

- **Hover at any band** pops a full-label tooltip with path, kind, and
  any truncated text in full.
- **Selected node** renders its label regardless of band (selection
  overrides label-visibility gating).
- **Search match** renders its label regardless of band (same override).

---

## §5 — Search navigates (A+C)

Replaces the current search handler, which only filters + dims.

### Behavior

1. **Typing a query** → debounced 200ms → projection forces matching leaves
   visible along with their ancestor supernode path (unchanged from
   shipped). Non-matches dim to 30% (unchanged).
2. **Plus new:** the camera animates to frame matches.
   - **1 match**: lerp camera to center the match. If the match lives in
     a folded supernode, first cross the band threshold so the match
     renders as itself, then center.
   - **2–N matches**: lerp camera to fit the bounding box of all matches
     (with 80px padding).
3. **Search bar result chip**: `3 matches ▾` appears adjacent to the
   input. Click → dropdown with one row per match (`kind icon` · `name`
   · `path`). Click a row → camera lerps to that specific match; other
   matches stay visible but the camera commits to the chosen one.
4. **`Esc` in search input**: clears the query AND lerps camera back to
   the state saved on search open (position, zoom, focus).

### Camera save/restore contract

```js
let preSearchCamera = null;

function onSearchOpen() {
  preSearchCamera = { x, y, k, focusRoot, band };
}

function onSearchClear() {
  if (preSearchCamera) {
    lerpCameraTo(preSearchCamera);
    preSearchCamera = null;
  }
}
```

This lets the user pop into a search, find something, and bail cleanly.

### Multi-match zoom policy

When fitting a bounding box, the resulting zoom may cross band thresholds
— that's fine and triggers the usual reheat chain. The camera lerp and
the reheat animations play in parallel; d3-force + alpha decay absorbs
the motion naturally.

If matches are spread across the whole graph, fit may produce an almost
overview-level zoom. That's correct behavior: "your query is all over
the place, here's the lay of the land."

---

## §6 — Pan/zoom is mode-aware (C)

Replaces the current unconditional pan+zoom controller.

### Overview/mid/close/detail modes (no focus active)

- **Wheel** = zoom through band thresholds. Camera auto-fits to the
  graph bounds after each reheat settles (or after `alpha < ε`).
- **Pan** = disabled. There's nothing off-canvas to pan to because
  auto-fit keeps the graph centered and full-width.
- **Dblclick on a supernode** → camera lerps to the band that unfolds
  it; stays in overview mode. The user wanted to "see inside," not
  escape to a sub-region view.
- **Dblclick on a leaf** → enters focus mode (below).

### Focus mode

Enter via dblclick on a non-supernode leaf, or via a search chip
selection if the user wants to pivot into the neighborhood.

- **On entry** — camera lerps to fit the focused subgraph's bounds
  (existing behavior from 2026-04-18 nav spec). Preserved.
- **Wheel** = normal geometric zoom (centered on cursor) — takes over
  from the band-stepping behavior of overview mode.
- **Pan** = enabled.
- **Soft boundary disabled** — you're exploring a sub-region; let the
  forces settle where they will.
- **Group + governance gravity** remain active, applied to whatever's
  visible in focus. They continue to clump siblings and anchor
  decisions to their territories inside the focused neighborhood.
- **Camera** does not auto-fit after reheat; user controls it.
- **Esc** (canvas focused) → exit focus, return to overview auto-fit.

### Toolbar + keyboard affordances

- **`F` / `R`** (recenter) → works in both modes; in overview it refits,
  in focus it centers on focused root at current zoom.
- **Recenter button** — same.
- Add a small mode indicator to the toolbar (`OVERVIEW` / `FOCUS: node-name`)
  so the user always knows which pan/zoom regime is active.

---

## §7 — Transitions + reheat (minor tweaks)

Keep the shipped reheat model and triggers (2026-04-18 §4). Two
promotions from the "deferred" list to v1 work:

### 7.1 Re-parenting on unfold

When a band crossing unfolds a supernode, its children should start at
the old supernode's position (§4.5 of 2026-04-18 called for this but
the feedback suggests it's not fully wired). This is the difference
between "the graph reshuffles" and "the supernode blooms open."

Verification: after a band cross that unfolds `src/events/`, the
spawning leaves should have initial positions within ~20px of where
`src/events/` was, not random.

### 7.2 Aggregate edge ↔ constituent cross-fade

Currently snaps. Per 2026-04-18 §5 taxonomy this was deferred. Promote
to v1: 220ms cross-fade.

### Everything else

- Reheat triggers: unchanged.
- Alpha values per trigger: unchanged.
- Transition durations: unchanged.
- Auto-fit adds a new trigger — it fires after a reheat settles, with
  its own camera-lerp animation (not a sim reheat).

---

## §8 — Module boundaries (delta from 2026-04-18)

| Module | Before | After |
|---|---|---|
| `shared/layout.js` | d3-force config | + `forceBoundary`, `forceGroup`, `forceGovernance`; adaptive scaling |
| `shared/sizing.js` | `sizeAt(kind, zoom)` constants | + `supernodeDims(label)` for label-fit sizing |
| `shared/groups.js` | Path-prefix + decision governance | + depth-cap logic (depth-2 at overview) |
| `shared/projection.js` | `project()` pure function | + revised band table output |
| `shared/camera.js` *(new)* | — | camera state, lerp, auto-fit, save/restore |
| `graph-viewer-2d.js` | projection ↔ sim wiring | + mode-aware pan/zoom, search-to-camera, mode indicator |
| `shared/search.js` | filter + dim | + match list + chip picker + camera integration |
| `shared/transitions.js` | enter/exit fade+scale | + re-parenting + aggregate-edge cross-fade |

All other modules (`state.js`, `shapes.js`, server/protocol) unchanged.

---

## §9 — Testing strategy

### Unit tests (additions)

**`shared/layout.test.js`**
- `forceBoundary` applies zero force inside radius, spring force outside.
- `forceGroup` pulls non-super nodes toward group centroid; leaves
  supernodes unaffected.
- `forceGovernance` pulls decision toward mean of visible territory; no
  NaN when territory is empty.
- Adaptive scaling: `adapt(N=17)` ≈ `12`; `adapt(N=300)` ≈ `2.9`; graph
  natural radius stays within ±20% across this range.

**`shared/sizing.test.js`** (additions)
- `supernodeDims('src/ws/')` returns narrower box than
  `supernodeDims('docs/superpowers/')`.
- Both ≥ `min_width` of 32.

**`shared/groups.test.js`** (additions)
- Depth-2 collapse: `src/events/worker/persister.ts` → `src/events/`.
- Root singletons preserved.

**`shared/camera.test.js`** (new)
- `lerpTo({x, y, k})` interpolates monotonically.
- `fitBounds({x0,y0,x1,y1})` produces k that contains bounds with padding.
- Save/restore round-trips exactly.

**`shared/search.test.js`** (additions)
- Single match → camera target equals match position.
- Multi match → camera target fits bounding box.
- Clear → camera target equals saved pre-search state.

### Integration / hand-verified

Re-run the 2026-04-18 hand-verified checklist, plus:

- Overview → Mid → Close → Detail: graph stays ≈ same viewport fill
  (between 70% and 95%) and circularity > 0.9 at each band.
- Soft boundary: drag a node to the far edge; release; it springs back
  inside.
- Label widths: `src/ws/` box visibly narrower than `docs/superpowers/`.
- Search `project`: camera lerps to matching supernode/leaf.
- Search `TODO` (many matches): camera fits all of them.
- Multi-match chip click → camera hops to that specific match.
- Esc in search: camera returns to pre-search position + zoom.
- Dblclick on `src/viewer/` supernode: camera lerps to band where it
  unfolds; stays in overview mode.
- Dblclick on a leaf file: enters focus mode; wheel now does geometric
  zoom; pan works; mode indicator shows `FOCUS: filename`.
- Esc in focus: exits to overview auto-fit.

### Not tested

- Exact post-reheat positions (non-deterministic).
- Frame-rate under load (current scale is comfortable).
- Obsidian-identical look (different aesthetic target; ours is "clean
  disc with clumps," theirs is "organic mesh").

---

## Deferred (unchanged from 2026-04-18 unless noted)

Still deferred:
- Conversation memory as graph nodes.
- Louvain / emergent clustering.
- Activity heat.
- Breadcrumb for deep focus/drill paths.
- Co-change clustering.
- Server-side aggregation.
- Empty-territory dashed halo.

**Promoted to v1 work in this revision:**
- Edge reclassify transitions (aggregate ↔ constituents cross-fade).

**New deferred:**
- Force regime interpolation by zoom (close-zoom relaxes `group`/`collide`
  for readability). V1 uses the one set of defaults that works at all
  bands; zoom-interpolated force params is a nice polish follow-up.
- Mode-indicator animation when switching between overview and focus
  (v1 = instant swap).

---

## Cross-references

- [2026-04-18 LOD projection design](./2026-04-18-graph-viewer-lod-projection-design.md) — the spec this revises.
- [2026-04-18 navigation + clustering](./2026-04-18-graph-viewer-navigation-and-clustering.md) — primitives (camera, search, focus) this extends.
- [2026-04-17 graph UI + activity stream](./2026-04-17-graph-ui-and-activity-stream-design.md) — thread + event model (unchanged).
- [Graph UI architecture](../../architecture/graph-ui.md) — top-level reference.

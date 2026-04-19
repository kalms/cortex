# Graph Viewer: LOD via Client-Side Projection Layer

> Design spec. Started 2026-04-18.
>
> **Builds on:**
> - [2026-04-17 Graph UI + activity stream design](./2026-04-17-graph-ui-and-activity-stream-design.md)
> - [2026-04-18 Graph viewer navigation + clustering](./2026-04-18-graph-viewer-navigation-and-clustering.md)

## Summary

The 2D graph viewer currently renders every leaf node at every zoom level. This doesn't scale past a few thousand nodes and blurs the user's primary mental model — which, for Cortex, is **decisions and architecture, with added context as you go deeper**.

This spec introduces a **client-side projection layer** that sits between the full graph state and the simulation/render. The projection decides what's visible at each zoom × focus × filter × search input, synthesizing supernodes from real structure in the data (directory paths and decision-governance relationships) rather than curated categories. All LOD, aggregation, sizing, and reheat behavior is driven by this one pure function.

The design is deliberately a **client-side-only change**: the server protocol, event bus, worker pipeline, mutation ops, and graph state model are untouched. Every piece of UX experimentation (zoom bands, aggregation sources, navigation mechanics, transitions, sizing curves) is a swap of one pure module.

## Design principles

1. **Two axes of depth**: zoom controls structural depth (modules → files → functions); selection controls informational depth (rationale → alternatives → commits → conversations).
2. **Primary activity is tracing decisions + finding/navigating.** Decisions + architecture are the always-visible floor.
3. **Ambient awareness is an undercurrent.** Activity pulses in the background regardless of what else the user is doing — never dominant.
4. **Logical-constraint grouping only.** Groups derive from real structure in the data (paths, governance relationships). Never curated categories.
5. **Client-only.** No protocol changes, no new mutation ops, no new server state.
6. **Pleasant transitions.** Every projection delta produces opacity/scale/position animations, not snaps.
7. **Legibility before density.** A node must never shrink below a per-kind apparent-size floor; if it would, it folds into its supernode instead.

## §1 — Core architecture

A single client-side projection function:

```js
project(graph, camera.zoom, focus, filters, search) →
    { visibleNodes, visibleEdges, groups }
```

**Properties:**
- **Pure.** Same inputs → same outputs.
- **Client-only.** Server continues to serve `/api/graph` + mutation stream unchanged.
- **Output is authoritative for both the simulation and the render.** The sim's `.nodes()` and `.force('link').links()` come from projection output, not raw state. Filter toggles, zoom-band crossings, search changes, and focus changes therefore reheat via the same `syncSimulation()` → `alpha(0.3).restart()` path that mutations already use (today, only mutations reheat — this is a v1 gap).
- **Groups are synthesized, not persisted.** They live only in projection output.
- **Leaves stay in `state` always.** Hidden leaves are not deleted; the projection just doesn't include them. Detail panel always has full fidelity.

### Module boundaries

| Module | Owns | Status |
|---|---|---|
| `shared/projection.js` | `project()` pure function | **new** |
| `shared/groups.js` | Path-prefix + decision-governance group derivation | **new** |
| `shared/sizing.js` | `sizeAt(kind, zoom)` curves + per-kind `{ world, min_px, max_px }` ranges | **new** |
| `shared/transitions.js` | Projection-diff → entering/exiting/reclassified transition state | **new** |
| `shared/layout.js` | d3-force config (reads `sizing`) | touched |
| `shared/shapes.js` | Shape primitives — adds rounded-rect for supernodes, hull polygon for territories | touched |
| `graph-viewer-2d.js` | Wires projection output into sim + render + interaction | touched |
| `shared/state.js` | Unchanged — still owns the full graph | untouched |
| Server, protocol, mutations, worker pipeline | All unchanged | untouched |

### Selection is a first-class render state

Fixing an existing viewer gap: `selectedId` is currently tracked but never consumed by the render path ([graph-viewer-2d.js:506](../../src/viewer/graph-viewer-2d.js#L506)).

- Single-click node → select (persistent highlight + detail panel opens).
- Click another node → replace selection.
- Click empty canvas → clear selection (closes panel).
- Selection ≠ focus. Select is a soft pin (everything stays visible). Focus is structural (dblclick, restricts visible set).
- Render contract: visual weight = `max(selectionLevel, hoverLevel) * searchDim`. Selection passes into the render alongside projection output, not into the projection itself (it's informational, not structural).

## §2 — Grouping derivation

Two sources, layered.

### a) Path hierarchy (primary, structural)

Derived from `file_path` and `qualified_name` on each leaf:

```
root/
  src/
    events/
      worker/        ← group:path:src/events/worker
        persister.ts
        git-watcher.ts
      bus.ts
    graph/
      store.ts
```

- Every directory with 2+ members becomes a candidate group. Singletons collapse up.
- Functions/references nest under their owning file (via `qualified_name` prefix match).
- Decisions don't live in this tree — they're always top-level.

### b) Decision-governance overlay (secondary, semantic)

For each decision node, collect its outgoing `GOVERNS` edge targets → this is the decision's **territory**. Territories are drawn as a translucent convex hull + fill cutting across the path hierarchy. A decision can govern files from `src/events/` and `src/ws/` simultaneously; the hull spans both.

### Group identity

Deterministic from source:
- Path groups: `group:path:<dirpath>`
- Territory groups: `group:decision:<decision_id>`

Same graph + same derivation settings → same group IDs across reloads. No group-id state to persist.

### Zoom band table (starting point — iterate)

| Zoom range | Visible |
|---|---|
| < 0.4× | Decisions + top-level path groups + territory hulls |
| 0.4 – 1.0× | Decisions + mid-depth path groups + territories |
| 1.0 – 2.0× | Decisions + leaf files + territories |
| > 2.0× | Decisions + files + functions/references |

Crossing a threshold triggers projection re-run + reheat (§4). Tuning is a one-file change.

## §3 — Zoom-aware sizing with legibility floors

Replaces the constant `SIZE[kind]` table ([layout.js:17](../../src/viewer/shared/layout.js#L17)).

### The `sizeAt(kind, zoom)` model

Each kind has three numbers:

```js
SIZE[kind] = { world, min_px, max_px }
```

- **`world`** drives the simulation (collide radius, link distance). Constant across zoom.
- **`min_px` / `max_px`** bound the apparent on-screen size.
- Rendered radius: `clamp(world * zoom, min_px, max_px) / zoom` (convert back to world for draw).

| Kind | world | min_px | max_px |
|---|---|---|---|
| decision | 10 | 14 | 22 |
| group (path) | `4 + 2*log2(members)` | 12 | 26 |
| file | 5 | 7 | 12 |
| component | 4.5 | 6 | 11 |
| reference | 3 | 5 | 9 |
| function | 2.5 | 5 | 8 |
| path | 2.5 | 5 | 8 |

### Consequences

- Ratios between kinds stay roughly consistent across zoom.
- Decisions no longer have a "constant world-size" special case — same rule as every kind, just the largest range.
- **Legibility floor** (`min_px`) composes with the band table (§2): the band table decides *when a kind is visible at all*; the floor decides *how small it can get while visible*. If a kind would be forced below its floor at a given zoom, it should already have been folded into its supernode by the band table. The floor is a safety net for search-forced / selection-forced visibility.

### Shape + color + shape = identifiable at floor

Three mechanisms keep kind identifiable at any size:
1. **Shape** — distinct per-kind shape (`SHAPE_FOR_KIND`) stays rendered at floor size.
2. **Color** — per-kind palette stable at all sizes.
3. **Fold before degrade** — band table prevents most floor-clamp cases. Floor catches edge cases.

### Edge stroke

Same range model per relation: `clamp(baseWorld * zoom, min_px, max_px) / zoom`. GOVERNS has higher floor (always visible connector); CALLS can thin more.

## §4 — Reheat model

### Triggers

| Trigger | Reheat? | Alpha | Notes |
|---|---|---|---|
| Graph mutation (add/remove node or edge) | yes | 0.3 | existing behavior |
| Kind filter toggle | yes | 0.3 | was render-only; now drives projection |
| Search input change | yes (debounced 200ms) | 0.2 | gentle — search dims before it folds |
| Zoom-band threshold crossing | yes | 0.4 | visible set changes substantially |
| Focus mode enter/exit | yes | 0.5 | sim's node set changes structurally |
| Selection change | no | — | pure render state |
| Pan / hover / panel open | no | — | render-only |
| Zoom within a band | no | — | render scales; no visible-set change |

### Single reheat path

```js
function onProjectionInputChange(reason) {
  const projected = project(state, camera.zoom, focus, filters, search);
  if (projectionDeltaIsInteresting(previous, projected)) {
    syncSimulation(projected);
    simulation.alpha(alphaFor(reason)).restart();
  }
  previous = projected;
}
```

`projectionDeltaIsInteresting(a, b)` is true when the set of visible node IDs differs, OR when any supernode's member set differs. Pure visual deltas (size curve output at current zoom, edge weight changes) do not count — they affect the render but don't warrant a reheat.

### Where new nodes start

**Inherit from parent.**

- Leaf entering because its path-group expanded → `(x, y)` = group centroid + small jitter.
- Group appearing because we zoomed out → centroid of its children (which just left the visible set).
- Decision-governed leaf forced-visible via search → no path parent; spawn near the decision's position.

Without this, d3-force assigns random positions and the graph re-rolls dice every time the visible set changes. With it, nodes emerge from where they logically belong.

### Batching

- Zoom events (~60/s from wheel): debounced to 16ms, reheat fires only when a band threshold is crossed. Pure intra-band zoom changes render at full rate without touching the sim.
- Search keystrokes debounce at 200ms.
- WS mutation bursts coalesce into one reheat per frame.

### Cost envelope

At 453 nodes / 572 edges a reheat is effectively free: O(N+E) projection + O(N+E) syncSimulation + ~50 ticks to settle (~800ms). Comfortable to ~5k nodes. Above ~10k the sim itself becomes the bottleneck — throttle tick rate or gate behind `alpha > ε`.

### Adjacent accommodation is automatic

When a new node enters the visible set, `forceCollide` / `forceManyBody` / `forceLink` push neighbors to make room during the reheat window. Gentle alpha + stable `world` sizes + continuous breathing = the cascade feels like the graph breathing rather than snapping to a new configuration.

## §5 — Rendering + transitions

### Supernodes

- **Shape**: soft-cornered rounded rect (distinct from triangle/square/circle).
- **Size**: per §3 (`4 + 2*log2(members)`, clamped `[12, 26]`).
- **Label**: directory basename (`worker/`, not the full path).
- **Member count pill**: `worker/ · 8`.

### Territory hulls (decision governance)

- **Shape**: rounded convex hull of currently-visible governed members (raw or via supernode representative).
- **Fill**: ~8% opacity, tinted from the decision's palette.
- **Stroke**: 0.5px in the decision's hover color.
- **Layer order**: drawn behind edges and nodes; no picking interference.
- **Empty territory** (decision visible, members all hidden): hull hides; decision gains subtle dashed halo signaling "has governance, zoom in to see."

### Aggregate edges

Edges whose both endpoints collapsed into supernodes merge:
- Stroke width: `1 + log2(count)`, clamped per §3.
- Color: majority relation's color; mixed → neutral grey.
- Tooltip: `12 CALLS, 3 IMPORTS`.
- Also applies to "dangling" edges from a forced-visible leaf to a folded supernode (one aggregate edge carrying that leaf's connections into the supernode).

### Selection visuals

- Selected node: full brightness + persistent 2px ring in the kind's hover color.
- Selected node's 1-hop edges: hover-bright permanently.
- Selected node's 1-hop neighbors: ~60% bright (between rest and hover).
- Everything else: rest-bright (not dimmed — dim is reserved for search).
- Hover composes on top of selection.
- Selected node's connected supernodes: subtle "contains neighbor" glow (signals "connected things live inside me" without revealing them).

### Transition taxonomy

**Entering** (∅ → visible): initial position = parent centroid + jitter; opacity 0→1 and scale 0→target over 280ms ease-out-back.

**Exiting** (visible → ∅): node leaves sim immediately but renders from a render-only transition set at last position; opacity 1→0 and scale→0.6× over 220ms ease-in; position linear-lerps toward parent centroid.

**Reclassifying** (leaf-leaf edges ↔ aggregate edge): aggregate and constituents cross-fade at 220ms.

**Hull appearance**: 200ms fade.

**Sim settling**: implicit via `alpha(0.3).restart()` — d3-force's own lerp, ~800ms.

### Transition state container

```js
anim.transitions = Map<id, {
  phase: 'entering' | 'exiting',
  age: number,
  duration: number,
  from: { x, y, opacity, scale },
  to:   { x, y, opacity, scale },
}>
```

Same shape as existing `anim.nodes` / `anim.synapses`. Advances per frame in `advance()`; read during `draw()`. Exits are cleaned up when `age >= duration`.

### Motion budget

| Transition | Duration |
|---|---|
| Entering | 280ms |
| Exiting | 220ms |
| Edge reclassify | 220ms |
| Hull opacity | 200ms |
| Selection ring | 180ms |
| Sim settle | ~800ms (alpha-driven) |

## §6 — Navigation + focus

### Action table

| Action | Effect |
|---|---|
| Single-click node | Select (persistent highlight + panel) |
| Single-click supernode | Select — panel shows member list + aggregate stats |
| Double-click node | Focus: project to node + 1-hop neighborhood; camera lerps to fit |
| Double-click supernode | Drill: camera animates to zoom level that unfolds this supernode |
| Click empty canvas | Clear selection |
| `Esc` (canvas focused) | Exit focus mode, refit to full visible set; selection preserved |
| `Esc` (search focused) | Clear search (existing) |
| `/` | Focus search (existing) |
| `f` / `r` | Recenter (existing) |
| Wheel / pinch | Zoom (crosses band thresholds per §4) |
| Drag on empty | Pan (existing) |

### Focus and select are orthogonal

- **Select** = informational pin. Non-destructive. Graph still fully visible.
- **Focus** = structural pin. Restrictive. Visible set contracts to focused subgraph.
- They compose. Clearing one doesn't clear the other.

### Supernode drill = zoom-to-band

Double-click on supernode computes the zoom level that places its children in the visible band (per §2's table) and lerps the camera there. Unfolding happens naturally via the band-threshold reheat path (§4). No special "drill-down" state needed.

### Search behavior

- Matching a folded leaf **forces it visible** along with its ancestor supernode path (so the match has visual anchor).
- Adjacents don't auto-reveal. Dangling edges from the match to folded neighbors render as aggregate edges into those neighbors' supernodes.
- User can **select** to highlight connections (neighbors glow inside their supernodes) or **focus** (dblclick) to reveal the full 1-hop neighborhood.
- Clearing search → forced-visible nodes exit via §5 exit transition.

### Focus × projection composition

Focus mode feeds `focus = { root, depth }` into the projection. Projection output becomes `{root} ∪ neighbors(root)` + ancestor supernodes needed for coherent hulls/groups. Band table still applies within the focused set (close-zoom shows functions, far-zoom shows files even in focus).

### Deferred in v1

- **Breadcrumb** for deep drills (`root → src/ → events/ → worker/`). Pure additive later; reads focus state + ancestor path.

## §7 — Ambient undercurrent

### Breathing

- Runs every frame on the **full state**, not the projection output. Invisible nodes keep breathing — cheap, gives them inertia when they re-enter.
- Suppressed for nodes in `entering`/`exiting` transitions — transition animation owns those frames.

### Synapses

- Triggered same as today (mutations + `decision.superseded` sequences).
- **Age regardless of visibility** — prevents "I zoomed out during a pulse and it stopped existing."
- **Render only when both endpoints are visible** (or in exit transition with valid position). Folded endpoint → pulse renders toward the supernode (the aggregate edge is the visible path).

### Activity heat (deferred)

Architecture has room: each node could carry `lastEventAt`; render reads it as soft glow fading over ~30s. Pure additive render pass, no simulation/projection/protocol changes.

### The undercurrent rule

| Layer | Max intensity |
|---|---|
| Breathing | ~2% position modulation, no opacity |
| Synapses (rest) | ~30% peak alpha on affected nodes/edges |
| Selection / focus / transitions | 100% — always win |

When layers compete on the same pixel, higher-priority layer stands; ambient layers don't accumulate on top.

## §8 — Testing strategy

### Pure modules — unit tests (vitest)

Following the existing `shared/*` test pattern.

**`shared/projection.test.js`**
- Given graph + zoom + focus + filters + search, returns expected output shape.
- Band crossings: below 0.4× emits supernodes only; above 2.0× emits all leaves.
- Focus restricts output to node + 1-hop, preserves ancestor supernodes.
- Search force-visible: matched leaf + ancestor path regardless of zoom.
- Dangling edges roll up to aggregate edges.
- Idempotence: same inputs → same output.

**`shared/groups.test.js`**
- Path-prefix: `src/events/worker/persister.ts` + `src/events/worker/git-watcher.ts` → `group:path:src/events/worker`.
- Singleton directory collapses up.
- Territory: decision + GOVERNS targets → `group:decision:<id>`.
- Deterministic group IDs.

**`shared/sizing.test.js`**
- `sizeAt(kind, zoom)` returns `world` scaled and clamped to `[min_px, max_px]`.
- Ratios stay consistent within unclamped range.
- Edge stroke follows same range model.

**`shared/transitions.test.js`**
- `diffProjection(previous, current)` returns `{ entering, exiting, reclassified }`.
- Entering transitions start at parent centroid + jitter.
- Exiting transitions keep rendering for exit duration, then clean up.
- Age advancement linear; interpolated values within [0,1].

### Simulation wiring — integration tests

**`tests/viewer/syncSimulation.test.js`**
- After projection change, `simulation.nodes()` equals projection's `visibleNodes`.
- After projection change, `simulation.alpha()` > 0.
- After non-visibility change (selection, hover), sim `.nodes()` and alpha unchanged.

**`tests/viewer/reheat-triggers.test.js`**
- Kind filter toggle → reheat.
- Zoom within a band → no reheat.
- Zoom crossing threshold → reheat with expected alpha.
- Search keystrokes debounce (one reheat per ~200ms window).

### Hand-verified (entry file + canvas)

Additions to existing checklist:

- Bloom on unfold / condense on fold look pleasant, not janky.
- Territory hull inflates smoothly as members move during reheat.
- Aggregate edge tooltip + weight correct.
- Selection ring persists through hover, search dim, focus changes.
- Search forces matches visible with ancestor path intact.
- Double-click drill on supernode crosses band threshold and unfolds cleanly.
- Ambient breathing + synapses continue playing throughout.

### Explicitly not tested

- Exact visual positions after reheat (d3-force + breathing is non-deterministic).
- Frame-rate under load (out of scope at current scale).
- Deferred layers (Louvain, conversation nodes, activity heat).

## Deferred / future

- **Conversation memory as graph nodes** — a new `kind` in the graph for conversation records (mostly consumed by the agent via `search_graph` / `trace_path`, visualized as a toggle layer for the human). Future scope; no v1 work.
- **Louvain / emergent clustering** — computed groups from call/import coupling; additional derivation strategy for `groups.js` without changing the projection interface.
- **Activity heat** — per-node glow decaying from `lastEventAt`. Pure render addition.
- **Breadcrumb** for deep focus/drill paths.
- **Co-change clustering** — groups derived from commit co-occurrence.
- **Server-side aggregation** — if client-side derivation gets too expensive (>10k nodes), move the group derivation stage into the worker pipeline and emit groups as part of `/api/graph`. The projection interface doesn't change — it just accepts pre-derived groups instead of deriving them.

## Cross-references

- [Graph UI architecture overview](../../architecture/graph-ui.md) — thread model, event flow, extension points.
- [2026-04-17 spec](./2026-04-17-graph-ui-and-activity-stream-design.md) — original system design.
- [2026-04-18 nav + clustering spec](./2026-04-18-graph-viewer-navigation-and-clustering.md) — the work that shipped camera/pan/zoom, force tuning, search + filters, focus mode. This spec layers on top of those primitives.

# Cortex — Session Handoff (2026-04-18)

## What Was Done This Session

### Plan B — 2D Graph Viewer (merged + pushed)

Shipped the complete nine-step ladder from the 2026-04-17 spec. 20 commits, then bundled and merged together with the follow-up below.

- **Six pure shared modules** — `state`, `colors`, `shapes`, `layout`, `animation`, `websocket` — all TDD'd in Vitest, no DOM dependency.
- **Ladder:** static render → force sim + ambient breathing → hover lerp + tooltip → WebSocket live mutations → synapse animations (ring / pulse) → supersession choreography → search + filter → detail panel → focus mode.
- **3D viewer moved** to `/viewer/3d`; 2D is the new default at `/viewer`.
- **Reconnecting WebSocket client** with heartbeat (30s ping), backfill-on-reconnect, event dedupe by ULID.
- **pickNodeAt refactor** extracted identical hit-test math from three handlers into one helper.

### Plan B follow-up — Navigation, clustering, search UX (merged + pushed)

Shipped on first-use feedback: the viewer had no way to navigate, the graph settled into a diffuse cloud instead of an Obsidian-style disk, and search hid non-matches (destroying context). 9 more commits.

- **New `shared/camera.js`** — pure camera state + transform math (`createCamera`, `clampZoom`, `worldToScreen`, `screenToWorld`, `fitToBounds`, `zoomAtPoint`, `lerpCamera`). 13 unit tests.
- **Pan** (drag empty canvas) + **zoom** (wheel / trackpad pinch via `wheel` + `ctrlKey`) + **fit-to-viewport on load** (triggers when `simulation.alpha() < 0.3`).
- **`F` / `R` key + toolbar button** → smooth recenter via `targetCamera` + per-frame `lerpCamera`.
- **Pan-to-fit on focus mode** — dblclick animates camera to fit the 1-hop subgraph; `Esc` animates back to full-graph fit. Esc-in-search-input is scoped to local clear+blur only.
- **Zoom-gated persistent labels** — decisions always; files fade in 0.4→0.6; everything else fades in 0.9→1.1. Screen-space, constant font size.
- **Force re-tune** for emergent disk: `forceCenter.strength 0.03→0.12`, link distances tightened (GOVERNS 70→45, CALLS 80→55, IMPORTS 100→70, co-changed 200→140), charges eased (decision -300→-220, file -100→-80, etc.). Same visuals, Obsidian-style shape.
- **Search UX rework** — `isVisible()` keeps only hide-style gates (focus + kind filter); search became a 0.15 dim multiplier on nodes/edges/labels. **Hover wins locally** over dim (the hovered node never dims). New `/` keybinding focuses search; Esc in search clears + blurs. Match count `N / M` indicator.

**Tests: 179 passing across 30 files** (119 backend + 42 Plan B viewer + 18 follow-up). Typecheck clean.

### Key artifacts

| Artifact | Path |
|---|---|
| Spec — Plan B | [docs/superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md](docs/superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md) |
| Plan — Plan B | [docs/superpowers/plans/2026-04-17-graph-viewer-2d.md](docs/superpowers/plans/2026-04-17-graph-viewer-2d.md) |
| Spec — follow-up | [docs/superpowers/specs/2026-04-18-graph-viewer-navigation-and-clustering.md](docs/superpowers/specs/2026-04-18-graph-viewer-navigation-and-clustering.md) |
| Plan — follow-up | [docs/superpowers/plans/2026-04-18-graph-viewer-navigation-and-clustering.md](docs/superpowers/plans/2026-04-18-graph-viewer-navigation-and-clustering.md) |
| Architecture doc | [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) — 2D viewer section documents module layout, render loop, extension recipes |

## Current State

- **Branch:** `main`, synced with `origin/main` (HEAD at `ba42486 Merge Plan B...`)
- **Tests:** 179 passing across 30 files
- **TypeScript:** `npx tsc --noEmit` clean
- **Dev viewer:** http://localhost:3334/viewer (2D, default); http://localhost:3334/viewer/3d (legacy 3D); MCP plugin instance uses :3333
- **WebSocket:** `ws://localhost:3334/ws` in dev
- **Visual verification:** **pending** — the next session should run `npm run dev` and walk the 10-item post-impl checklist at the end of the follow-up plan before building on top of this work.

## What's Next

### Primary: visual QA of the shipped viewer

Before starting new work, run the post-implementation checklist from the follow-up plan (section: "Post-implementation manual verification"). Key items:

- Fit-on-load frames the whole graph with padding
- Pan drags smoothly; clicking after a drag does NOT open the detail panel
- Wheel zoom pins the world-point-under-cursor
- `F` / `R` smoothly recenter with ~300ms lerp
- Zoom-gated labels fade (not pop)
- Focus-mode smoothly re-frames; Esc smoothly returns
- Force tuning: graph should form a visible disk with clusters you can see by eye
- Search "auth" (or any substring): matched subgraph bright, rest dim; hovering a dimmed node lights it up

If any step fails, it's either a regression or a tuning call (force params). Address before building on top.

### Secondary: Plan C — activity stream + graph↔stream sync

Not yet planned. Spec covers layout, event rendering, search/filter chips, live streaming behavior, backfill, graph↔stream click-sync. The backend already emits events; the 2D viewer already consumes mutations from the same WebSocket. Stream is mostly DOM + a new route at `/viewer/stream` — shares the WS connection with the graph.

Sensible next-session structure: brainstorm → spec → plan → implement, same cadence as Plans A/B.

### Tertiary: onboarding-gap brainstorm

Decision `4924bc84` from Plan A is still a brainstorm-in-waiting. Agents (including me this session and last) consistently ship significant architectural work without capturing decisions via `create_decision`, despite CLAUDE.md instructions. Options to explore: hook-based post-commit prompt, a `review-recent-commits` skill that sweeps and suggests, a more active SessionStart reminder, or mid-session triggers when a plan/spec doc lands.

## Tech Debt Carried Over (not blockers)

### Viewer / Plan B area

- **`anim.nodes` grows unbounded.** `setHover()` adds entries but never evicts them on `remove_node`. Over many add/remove cycles, ghost entries accumulate (harmless — their highlight lerps to 0 — but leaky). Fix: call `anim.nodes.delete(id)` from `onMutation`'s `remove_node` branch.
- **`syncSimulation()` reheats on every mutation including attribute-only `update_node`.** Visible as a light graph twitch when a decision's `status` flips. Short-circuit: `if (m.op !== 'update_node') rebuildNeighbors(); syncSimulation();`.
- **`seen` Set in `websocket.js` is unbounded.** ~26 MB at 1M events over a very long session. Add an LRU or `seen.size > N ? seen.clear()` guard.
- **Reconnect drift:** if the WS disconnects and mutations are emitted during the outage, they are not replayed. Inline `KNOWN LIMITATION` comment in `graph-viewer-2d.js`. Real fix is the spec-mentioned `>500 mutation → re-fetch /api/graph` recovery.
- **Fit-on-load has no tick-count fallback.** A degenerate simulation that never reaches `alpha < 0.3` would leave `hasInitiallyFit = false` forever. Add `|| tickCount > 60` as belt-and-braces.
- **Dblclick fires click first.** A double-click opens the detail panel AND enters focus mode. The panel shows the focus root — reasonable behavior, but unintentional. Decide UX and add `closeDetail()` in the dblclick handler if it feels wrong.
- **3D viewer toolbar lacks `file` kind checkbox.** Pre-existing; more visible now that `/viewer/3d` is documented as a persistent alternate entry point.
- **`graph-viewer-2d.js` is ~630 lines.** Detail-panel block (~100 lines) is the one section that isn't camera/search/hover/render — candidate for extraction to `shared/detail-panel.js` when Plan C lands and the file grows more.
- **Inconsistent keydown-handler activeElement checks.** Three `window` keydown listeners (`/`, `Escape`, `F/R`) with slightly different guards. A single dispatcher would centralize intent.

### Backend / Plan A area (carried from previous handoff, still open)

- **`src/ws/server.ts:~52`** — 5ms `setTimeout` before `hello` works around a same-process WebSocket frame-ordering quirk. TODO comment in place.
- **Bootstrap duplication** — `src/events/worker-bootstrap.mjs` and `tests/integration/worker-bootstrap.mjs` differ by ~15 lines.
- **`tsconfig.json`** doesn't copy `.mjs` to `dist/`. Matters only for `npm run build` + `npm start`; dev mode unaffected.
- **`tests/integration/end-to-end.test.ts`** still passes raw `NodeRow`-shaped objects to `snapshot_update`.

### Deferred from the follow-up spec (explicit out-of-scope)

- Node drag (d3-force `.drag()` wiring)
- Minimap
- Touch / pinch-zoom beyond the `wheel`+`ctrlKey` trackpad path
- Keyboard shortcuts beyond `F` / `R` / `Esc` / `/`
- Community detection (Louvain), cluster coloring, spatial separation
- Temporal slider, gap detection, decision-panel enrichments

## Quick Start for Next Session

```bash
cd ~/Development/cortex
git pull                              # sanity check
npm install                           # if deps changed
npm test                              # expect 179 passing
npx tsc --noEmit                      # expect clean
npm run dev                           # MCP + 2D viewer + WS on :3334
open http://localhost:3334/viewer     # the shipped 2D viewer
open http://localhost:3334/viewer/3d  # legacy 3D still available
```

To verify the viewer end-to-end (before building on top):

```bash
# Trigger a few mutations to watch synapse animations:
#   (in another shell — or via Claude Code with MCP tools enabled)
#   create_decision → new lavender diamond + ring ripple
#   link_decision   → new GOVERNS edge + pulse particle
#   supersede_decision → staggered pulses + ring on new node
#
# Check navigation: drag to pan, wheel to zoom, F to recenter, dblclick for focus, Esc to return
# Check search:     press /, type "auth" (or any substring), verify dim + hover-wins behavior
```

To start Plan C:

```
/brainstorm activity stream (Plan C) from the 2026-04-17 spec
```

Or pick up the onboarding-gap brainstorm instead. Both are outstanding.

## Key Files (new from this session)

| File | What it does |
|---|---|
| [src/viewer/shared/state.js](src/viewer/shared/state.js) | Pure graph state + `applyMutation` + `edgeKey` + `hydrate` |
| [src/viewer/shared/colors.js](src/viewer/shared/colors.js) | `PALETTE_REST`, `PALETTE_HOVER`, `EDGE_ALPHA`, `BACKGROUND`, `lerpRGB`, `rgbString` |
| [src/viewer/shared/shapes.js](src/viewer/shared/shapes.js) | `drawDiamond/Circle/Hex/Pill/Tri/Strike` + `SHAPE_FOR_KIND` |
| [src/viewer/shared/layout.js](src/viewer/shared/layout.js) | d3-force config + per-kind/relation tables; `createSimulation` |
| [src/viewer/shared/animation.js](src/viewer/shared/animation.js) | Hover lerp state + synapse queue + `advance` |
| [src/viewer/shared/websocket.js](src/viewer/shared/websocket.js) | Reconnecting client + heartbeat + backfill dedupe |
| [src/viewer/shared/camera.js](src/viewer/shared/camera.js) | Pure camera + transform math (pan/zoom/fit) |
| [src/viewer/shared/search.js](src/viewer/shared/search.js) | `searchMatch(node, query)` predicate |
| [src/viewer/graph-viewer-2d.js](src/viewer/graph-viewer-2d.js) | Entry — DOM wiring + render loop + interaction handlers |
| [src/viewer/3d/](src/viewer/3d/) | Legacy 3D viewer (unchanged, moved from `src/viewer/`) |

## Key Files (modified this session)

| File | Change |
|---|---|
| [src/mcp-server/api.ts](src/mcp-server/api.ts) | Routing: `/viewer` → 2D; `/viewer/3d` → 3D; `/viewer/<asset>` → static |
| [src/viewer/index.html](src/viewer/index.html) | Canvas + importmap (d3-force CDN) + toolbar (search + match-count + recenter + filters) + tooltip + detail panel |
| [src/viewer/style.css](src/viewer/style.css) | 2D canvas, tooltip, search group, recenter button, `.panning` cursor |
| [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) | Appended "2D viewer" section: module layout, render loop, extension recipes |
| [CLAUDE.md](CLAUDE.md) | "Viewer" pointer updated for 2D default + 3D alternate |
| [README.md](README.md) | "3D graph viewer" references updated to reflect new default |
| [package.json](package.json) | Added `d3-force@^3.0.0` as devDependency (served via CDN in browser) |

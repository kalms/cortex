# Frames Viewer — Design Spec

**Status:** Draft (autonomous, no user clarifying round). User redirects as needed.

## Goals

Wire the visual language defined in [docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html](../../specs/cortex-v0.3/cortex-frames-prototype-v5.html) up to live Cortex data. Replace the existing `src/viewer/` (graph-viewer-2d.js + shared/*) so the prototype HTML *becomes* the production viewer at `http://localhost:3334/viewer`.

Concretely the new viewer must, for the active project:

1. Render a frame per cluster from `nodes.data.frame_id`/`frame_label`, with a stable, deterministic layout.
2. Render file nodes inside their frame, sized/spaced as in the prototype.
3. Render edges between nodes (intra- and inter-frame).
4. Open a focused frame on click; show files clearly at that zoom.
5. Show decision marginalia (pills on focused frame's right edge) sourced from `.cortex/decisions.db` via `DECISION_LINKS` with relation `GOVERNS`.
6. Show ambient floating decisions in the background canvas.
7. Open a decision card sidepanel on click, populated from the real decision record (problem / resolution / rationale / alternatives / supersedes chain).
8. Project switcher in the toolbar (already implemented for the old viewer; ports forward).
9. Theme toggle (light / dark).

The old viewer at `src/viewer/{index.html,style.css,graph-viewer-2d.js,shared/*,3d/*}` is removed in the same chunk. No fallback, no compatibility shim.

## Non-Goals

Deferred until/unless follow-up demand:

- **Multi-agent simulation** — the prototype's `agents`, `agent-buttons`, auto-loop, agent heat, synapse animations, cursor traversal, frame heat. Cortex today has one user. All this is cut, not hidden — it would reference data we don't have.
- **PRs** — there is no `prs` table in `.cortex/db` yet. Cut all PR-related UI (floating PR nodes, PR cards, "merge" button, `introducesFrame`/`isFrameUncommitted` styling, PR touch indicators on nodes). Add back when the schema lands.
- **Live WebSocket updates** — the prototype is static-load anyway; refresh = reload page. WS integration is a separate follow-up.
- **Search** — the old viewer had a search box; the prototype doesn't. Out of scope. Use the MCP `search_graph` tool until/unless we re-add a search UI.
- **3D viewer** — `src/viewer/3d/` is deleted. The prototype's 2D-canvas language is the whole interface.
- **Entity-granular frames** — the spec calls for functions/classes to be frame-assigned too; for now only file-kind nodes carry `frame_id` (inject script already shipped). Functions render as orbiters of their file (the existing CBM `qualified_name` prefix relationship).

## Out of scope but worth knowing

- The user's clustering output is dominated by vendored C code in the cortex repo (tree-sitter, etc.), which is part of the codebase but not "what cortex is about." Labels like `tre`, `tslexer lexer`, `sitter ts_lex` reflect that. Re-clustering or tokenization tuning is a separate eval-driven concern; the viewer renders whatever the data says.

## Data model — prototype ↔ live mapping

The prototype's hardcoded data structures are replaced one-for-one with live data. Adapter logic runs **server-side** so the viewer JS is straight rendering, not modeling.

| Prototype | Live source | Notes |
|---|---|---|
| `FRAMES = [{id, name, x, y, w, h, count}]` | `/api/graph?project=` → group `nodes` by `data.frame_id` | `name` = `data.frame_label`. `x, y, w, h` derived client-side (see Frame Layout). `count` = member node count. |
| `NODE_CFG[frameId].count` | derived from grouping | Capped at a display limit per frame (e.g. 16) to avoid clutter; "+N more" indicator. |
| `FILE_NAMES[frameId]` | `nodes.file_path` per member | Use `basename(file_path)` for display. |
| `nodes[]` (in-frame) | file-kind nodes with matching `frame_id` | |
| `edges[]` | edges joined on the two endpoints' `project` filter; `interFrame` = `nodeA.frame_id !== nodeB.frame_id`. | |
| `DECISIONS[id]` | `.cortex/decisions.db` `decisions` + `decision_links` | Adapter exposes shape that matches prototype's `DECISIONS[id]` consumers (renderDecisionCard, marginalia). |
| `FRAME_GOVERNANCE[frameId] → [decisionId]` | `decision_links WHERE relation='GOVERNS'` and target is a file in that frame, OR target's qn-prefix lands in that frame | Rolled up server-side. |
| `PRS[id]` | (no source) | Cut. |
| `agents`/`AGENT`/`auto-loop` | (no source) | Cut. |

## API surface

Three endpoints. `api.ts` already serves `/api/graph` and `/api/projects` (added in the now-discarded old-viewer task chain — keep them as-is). Add:

| Endpoint | Purpose | Response shape |
|---|---|---|
| `GET /api/graph?project=<name>` | Existing. Returns `{nodes, edges, project}`. Used unchanged. | `nodes[]` carry `data.frame_id`/`frame_label`. |
| `GET /api/projects` | Existing. Returns `{projects, active}`. Used unchanged. | |
| `GET /api/decisions?project=<name>` | **New.** Returns decisions relevant to this project, with `governs` resolved to `{frameId, filePath, functionName}` shape the prototype's card expects. | `{decisions: AdaptedDecision[]}` |
| `GET /api/decisions/:id` | **New.** Returns one decision in full (problem/resolution/rationale/alternatives/supersedes/superseded_by/related_decisions). | `AdaptedDecision` |

`AdaptedDecision` matches the prototype's `DECISIONS[id]` consumers:

```ts
interface AdaptedDecision {
  id: string;
  summary: string;            // = title
  state: "active" | "proposed" | "superseded" | "deprecated" | "stale";
  problem: string | null;
  resolution: string | null;
  rationale: string;
  alternatives: { title: string; reason: string }[];   // mapped from {name, reason_rejected}
  proposedBy: string | null;  // = author
  proposedAt: string;         // = created_at (ISO)
  governs: GovernsRef[];
  supersedes: string | null;
  supersededBy: string | null;
  relatedTo: string[];
  dependsOn: string[];
  // PR-related fields elided — prototype guards on them where used:
  // introducedIn, implementedBy, challengedBy, discussedIn — all undefined here
}

type GovernsRef =
  | { kind: "frame"; id: string; label: string }
  | { kind: "file"; path: string }
  | { kind: "function"; path: string; name: string }
  | { kind: "symbol"; path: string; name: string };
```

The adapter resolves a decision's `GOVERNS` target (a qualified-name string or file path) to a `GovernsRef`. If the target is a `frame:<frame_id>` it stays a frame ref; if a file path, file ref; if a `path::symbol` qn, function/symbol ref. Targets that don't resolve are dropped from the array (silent — the adapter logs but doesn't fail).

## Frame layout

Frames must position deterministically so a reload doesn't reshuffle the canvas. The prototype hardcodes `x, y, w, h` per frame on a 0..1 stage. The new viewer derives them:

1. Build a grid of `ceil(sqrt(N))` columns × `ceil(N / cols)` rows for N visible frames.
2. Order frames by `member_count` desc, then by `frame_id` asc (stable).
3. Place each frame in the grid; cell width = stage W / cols, cell height = stage H / rows; frame size = cell minus padding (16px). Each frame is sized proportional to `sqrt(member_count)` capped at the cell size.
4. Centroid jitter is **disabled** (purely deterministic from inputs).
5. No d3-force, no physics. Static grid until/unless a follow-up adds a force layout.

If a follow-up wants force-directed positioning, this lives in a single file `src/viewer/layout.js` so it's a focused module to replace.

## File structure (new src/viewer/)

```
src/viewer/
  index.html          — copied from cortex-frames-prototype-v5.html, scripts split out
  style.css           — extracted from the prototype's <style> block
  viewer.js           — extracted from the prototype's <script> block; gutted of hardcoded data; takes a fetched VIEWER_DATA at boot
  data-fetch.js       — small module: fetchProjects/fetchGraph/fetchDecisions
  layout.js           — frame layout (grid → x/y/w/h)
  adapters.js         — client-side adapters (graph nodes/edges → in-memory shape; helpers)
```

Three-file viewer.js / data-fetch.js / layout.js / adapters.js plus index.html and style.css. Total ~5 files. The monolithic 3.7kLoC HTML is split BUT minimally — the goal is to preserve the prototype's behavior byte-for-byte where possible, not refactor.

**The simulation features (auto-loop, agent traversal, agent heat, synapses, cursors, merge animation, PRs) are removed during the extraction, not preserved-and-hidden.** That keeps the code base lean and makes the diff comprehensible.

## Server-side adapter

New file `src/mcp-server/api-decisions.ts`:

```ts
export interface AdaptedDecision { /* ...as above... */ }

export function buildAdaptedDecisions(
  decisions: Decision[],
  links: DecisionLink[],
  nodesByPath: Map<string, NodeRow>,
  nodeFramesByPath: Map<string, { frame_id: number; frame_label: string } | null>,
): AdaptedDecision[] { /* ... */ }
```

Used from `api.ts` `/api/decisions` handler. Pure function — fully unit-testable without a server. The shape conversion is mechanical; tests assert the key transforms (status → state, name → title in alternatives, governs ref resolution).

## Project switcher

The new viewer ports the toolbar `<select id="project-select">` and `loadGraph(project)` logic from the now-deleted graph-viewer-2d.js (commit `f7a0483`). Same `/api/projects` + `/api/graph?project=` backend; same default-active-project logic. Visually integrated into the prototype's existing toolbar / chrome (likely as a small floating select in the corner — the prototype's left-bottom `.controls` block is repurposed for project + theme since agents/merge buttons are cut).

## Old viewer removal

Same commit/PR that lands the new viewer removes:

- `src/viewer/graph-viewer-2d.js`
- `src/viewer/shared/{state,projection,groups,colors,websocket,layout,sizing,transitions,camera,animation,shapes,search}.js`
- `src/viewer/3d/{index.html,graph-viewer.js}`
- `src/viewer/index.html` (old)
- `src/viewer/style.css` (old)

Plus dead-code follow-on in `src/mcp-server/api.ts`: the `/viewer/3d` route is removed; the static-file routing collapses to a single `index.html` + sibling assets.

Tests that reference deleted modules go with them. New tests cover the new pure modules (`layout.js`, `adapters.js`, `api-decisions.ts`).

## Testing

Two categories:

1. **Unit (vitest)** on pure modules — `layout.js`, `adapters.js`, `api-decisions.ts`. Snapshot-shaped expectations on small fixtures (3 frames, 5 decisions, 8 links). Pure functions, fast.
2. **Hand-verify in browser (Gate 0)** — start dev server, navigate to `/viewer`, screenshot the canvas in default state + after clicking a frame + after opening a decision card. Compare to the prototype HTML rendered standalone as the visual baseline.

The new viewer.js is mostly canvas-drawing code — not unit-tested (the prototype isn't either). Visual regression is captured through screenshots committed to `.playwright-mcp/` (per workflow rules).

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Splitting the prototype's monolithic JS into modules breaks subtle scoping | Lift everything into a single `viewer.js` module first (verbatim minus the data + simulation), then extract the layout/adapters into siblings only after the verbatim copy renders identically to the standalone HTML. |
| The clustering output's frame labels look like vendored-C-token noise | Spec call: render whatever the data says. The label-quality conversation belongs in the algorithm eval, not the viewer. |
| Cortex's decisions DB has only 2 rows; marginalia/cards will look sparse | Acceptable for a viewer prototype. The marginalia behavior is testable; the demo just won't have many pills. |
| Frame layout grid will look ugly with 15 frames | Grid layout is the explicit MVP. Force-directed is a follow-up that drops in as `layout.js`. |
| WebSocket events from `src/events` are no longer routed to a viewer client | Server still emits — no consumer breakage. Adding back is a separate chunk. |

## Out-of-scope but worth flagging

- The prototype HTML stays in `docs/specs/` as the visual reference. Not deleted. (The user said "remove the old prototype"; I'm interpreting that as the old 2D viewer at `src/viewer/`, since the cortex-frames-prototype-v5.html is what we're wiring towards. If the user meant the HTML itself, that's a follow-up cleanup once the new viewer matches it.)

## Self-review

**Placeholder scan:** No TBDs. Every section has concrete answers — even the cut features have explicit rationale.

**Internal consistency:** The "out of scope" list mirrors the "non-goals" list; the data-mapping table covers everything the prototype consumes. API surface lists 4 endpoints, of which 2 are pre-existing and 2 are new (decisions list + decisions detail). The new file structure section lists 6 files, all referenced elsewhere in the spec.

**Scope check:** One implementation plan. Five tasks: (1) split prototype into module files preserving behavior, (2) wire `/api/graph` data fetch, (3) wire `/api/decisions` server adapter + client consumption, (4) port project switcher into new chrome, (5) delete old viewer + clean up routing/tests. Self-contained.

**Ambiguity check:** Frame layout is explicitly grid (not force). Decisions card maps to prototype's existing renderer (not a new component). Simulation features are cut not hidden. PRs are cut entirely. Project switcher reuses the existing API. Decisions adapter is server-side, not client-side. No ambiguities flagged.

# Graph UI and Activity Stream

**Date:** 2026-04-17
**Status:** Approved
**Extends:** 2026-04-12 3D graph viewer, 2026-04-13 CBM integration

## Goal

Add a 2D knowledge-graph viewer and a live activity stream as the primary visual interface for Cortex. The existing 3D viewer stays as `/viewer/3d`; the new 2D viewer becomes the default at `/viewer`. A persistent event log plus a WebSocket channel drive real-time updates in both the graph (as synapse-animated mutations) and the stream (as a vertical timeline of decisions and commits).

This spec covers three concurrent deliverables: a backend event pipeline, the 2D graph viewer, and the activity stream. The VS Code sidebar, phone PWA, and gap detection from the original concept are explicitly deferred; this spec documents the hooks we leave for them.

## Scope summary

**In scope (v1):**
- Backend: event bus, persisted event log, WebSocket broadcaster, git watcher
- Browser 2D viewer with force simulation, hover lerp, synapse animations
- Activity stream with search, filter chips, live streaming, backfill
- Graph ↔ stream synchronization via shared WebSocket
- Architecture documentation and code-level TSDoc as first-class deliverables

**Deferred (with prep notes in "Future extensibility"):**
- VS Code sidebar extension
- Phone PWA
- Gap detection
- Temporal slider
- Multi-user / collaboration
- Louvain clustering
- External event bus (Redis/Kafka/NATS)

## Architecture

Two-thread model inside the existing `cortex` process.

```
┌─────────────────────── Main thread ─────────────────────────┐
│                                                              │
│   MCP server (stdio) ──► DecisionService ──► cortex.db      │
│                              │                               │
│                              │ emits event                   │
│                              ▼                               │
│                         ┌─────────┐                          │
│   HTTP server (:3333) ──┤ Bridge  ├── postMessage ──┐       │
│   • /api/graph          └─────────┘                 │       │
│   • /viewer/*                  ▲                    │       │
│   WebSocket (:3333/ws)         │ postMessage back   │       │
│   • connection registry        │                    │       │
│   • broadcast loop ◄───────────┘                    │       │
└─────────────────────────────────────────────────────┼───────┘
                                                      │
┌─────────────────────── Worker thread ───────────────┼───────┐
│                                                     ▼       │
│   Event pipeline:                                           │
│   1. Persist event → events.db (own connection, WAL)        │
│   2. Derive graph mutations                                 │
│   3. Package broadcast messages                             │
│   4. postMessage back to main                               │
│                                                              │
│   Git watcher (chokidar on .git/logs/HEAD)                  │
│   • parses commit → emits into same pipeline                │
└──────────────────────────────────────────────────────────────┘
```

### Responsibilities

**Main thread:**
- MCP tool handlers (unchanged)
- `DecisionService` — SQLite writes to `cortex.db` (unchanged), plus one `postMessage(event)` to the worker after each successful mutation. Fire-and-forget. MCP latency unaffected.
- HTTP server — existing `/api/graph` and static viewer assets; adds WebSocket upgrade handler on `/ws`.
- WebSocket broadcaster — connection registry, heartbeat, message fan-out. Receives prepared broadcast messages from the worker via `postMessage` and sends them to all connected clients.

**Worker thread:**
- Owns a separate connection to `events.db` (WAL mode).
- Runs the event pipeline: persist → derive mutations → package broadcast messages → post back to main.
- Hosts the git watcher (chokidar + `git log` shelling out). Nothing on the main thread cares about commits except via events produced here.

### Why two threads

1. **MCP latency stays pristine.** Decision CRUD returns as soon as the `cortex.db` write completes. Event persistence, graph mutation derivation, and WebSocket broadcast happen asynchronously on the worker.
2. **Extension surface is ready.** Gap detection, Louvain clustering, and CBM re-index triggers all slot into the worker pipeline as additional stages. No future refactor needed to move them off the main thread.

### Why two databases

The existing graph DB (`.cortex/graph.db`, referred to throughout as `cortex.db` for brevity) and the new event log (`.cortex/events.db`) are separate SQLite files. Avoids cross-thread write contention on a single WAL. Events are a different concern from current graph state — backup and restore independently. The worker boundary plus the separate DB also make it easy to swap `events.db` for an external publisher (Redis/Kafka/NATS) later without touching the main thread.

## Event schema

### `events.db` table

```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,         -- ULID (sortable by time)
  kind        TEXT NOT NULL,            -- discriminator, dotted: '<entity>.<verb>'
  actor       TEXT NOT NULL,            -- 'claude' | '<git-author>' | 'system'
  created_at  INTEGER NOT NULL,         -- unix ms
  project_id  TEXT NOT NULL,            -- denormalized for future multi-project
  payload     TEXT NOT NULL             -- JSON; shape varies per kind
);

CREATE INDEX events_created_at ON events(created_at DESC);
CREATE INDEX events_kind ON events(kind, created_at DESC);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- used for last-seen git HEAD, server start timestamp, etc.
```

### Event kinds (v1)

```ts
type Event =
  | { kind: 'decision.created';    payload: { decision_id, title, rationale, governed_file_ids, tags } }
  | { kind: 'decision.updated';    payload: { decision_id, changed_fields: string[] } }
  | { kind: 'decision.deleted';    payload: { decision_id, title } }                  // title snapshot for tombstone display
  | { kind: 'decision.superseded'; payload: { old_id, new_id, reason } }
  | { kind: 'decision.promoted';   payload: { decision_id, from_tier, to_tier } }
  | { kind: 'decision.proposed';   payload: { decision_id, title, would_govern_file_ids } }
  | { kind: 'commit';              payload: { hash, message, files, decision_links } };
```

Every event has the common envelope (`id`, `actor`, `created_at`, `project_id`); only `payload` varies.

### Design choices

- **ULID** — sortable by time without a separate indexed timestamp; stable across future multi-project merges.
- **Dotted `kind`** (`<entity>.<verb>`) — future-proofs for `gap.detected`, `file.indexed`, etc.
- **`decision_links` on commits computed at emission**, not at render. Stream rendering is a pure read. Tradeoff: later GOVERNS edges don't retroactively appear on older commits. Acceptable.
- **Payload as JSON-as-text** — zero-migration cost when kinds evolve; queries never filter on payload fields.
- **Retention:** no pruning in v1. Low volume, cheap storage.

### Emission points

- `decision.*` — emitted from `DecisionService` methods in [src/decisions/service.ts](src/decisions/service.ts) after each successful SQLite write. One `postMessage` per mutation.
- `commit` — emitted by the git watcher in the worker, with `decision_links` computed at emission time as `SELECT decision_id FROM decision_governs WHERE file_path IN (?)`.

### Schema additions to `decisions` table

- `author TEXT NOT NULL DEFAULT 'claude'` — added now. MCP-initiated decisions default to `'claude'`; future UI-initiated flows will set explicitly.
- `visibility` field is **not** added. Requires multi-user context; deferred.

## WebSocket protocol

Same origin as the HTTP server. Path: `/ws`. Single-project implicit (client does not subscribe; server attaches to the project it was started with).

### Server → client messages

```ts
type ServerMsg =
  | { type: 'hello'; project_id: string; server_version: string }
  | { type: 'event'; event: Event }                     // stream item
  | { type: 'mutation'; mutation: GraphMutation }       // graph delta
  | { type: 'backfill_page'; events: Event[]; mutations: GraphMutation[]; has_more: boolean }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };

type GraphMutation =
  | { op: 'add_node';    node: Node }
  | { op: 'update_node'; id: string; fields: Partial<Node> }
  | { op: 'remove_node'; id: string }
  | { op: 'add_edge';    edge: Edge }
  | { op: 'remove_edge'; source: string; target: string; relation: string };
```

### Client → server messages

```ts
type ClientMsg =
  | { type: 'backfill'; before_id?: string; limit?: number }
  | { type: 'ping' };
```

An on-demand `query` message type (viewer requesting, e.g., commit diff details) was considered and deferred. The MCP server runs over stdio and isn't reachable from the viewer without adding a non-trivial routing layer. Fetching such details on demand goes to a future HTTP endpoint, not the WebSocket.

### Design choices

- **Events and mutations are separate message types.** One backend change often produces both (create_decision = 1 event + 1 add_node + N add_edges). Keeping them separate lets the viewer route cleanly: events → stream, mutations → graph.
- **Backfill is client-driven.** No spontaneous history push. Initial connection: client requests last 50 events after `hello`. Scroll-back: client requests more as the scroll position approaches top.
- **No subscribe message.** Single-project implicit. `hello` carries the `project_id` so the UI knows which project it's attached to.
- **Only emit mutations as a consequence of events.** A file's `lastModified` changing without a corresponding event does not produce a broadcast. Keeps the mutation stream semantically meaningful.
- **Heartbeat:** client pings every 30s. Miss 2 pongs → reconnect with exponential backoff (1s, 2s, 4s, max 30s). On reconnect, client sends `backfill` with `before_id = lastSeenId` to catch up; duplicates dedupe by ULID.

### Graph bootstrap sequence

```
1. GET /api/graph            → full current graph state (unchanged endpoint)
2. WS connect → hello         → initial backfill of last 50 events
3. Live events + mutations    → applied from now forward
```

No race between (1) and (2): backfill includes any events that occurred during the gap; client dedupes by ULID.

### Client state drift fallback

If backfill would return more than 500 mutations (client offline for a long stretch), client discards local state and calls `GET /api/graph` again to rehydrate from scratch.

## Git watcher

Lives in the worker thread. Single responsibility: detect new commits on the current branch and emit `commit` events.

- **Library:** `chokidar`.
- **Watch target:** `<project>/.git/logs/HEAD`. Append-only on every ref update to HEAD (commit, checkout, reset, merge). Cheaper and more reliable than watching `HEAD` itself.
- **Parsing:** on change event, shell out to `git rev-parse HEAD`. Compare to last-seen hash (stored in `events.db` `meta` table). Walk new commits with `git log <last-seen>..HEAD --format=%H%x00%s%x00%an%x00%at --name-status` — null-delimited, robust against any message content.
- **For each new commit:** emit one `commit` event with `{ hash, message, author, files, decision_links }`. `decision_links` = decisions governing any of the touched files.
- **Actor:** git `%an`; falls back to `'unknown'` if missing.

### Edge cases handled in v1

- **Not a git repo** — `.git/logs/HEAD` doesn't exist. Watcher logs once, stays idle.
- **First run** — no last-seen hash. Record current HEAD, emit nothing historical. Optional flag `CORTEX_BACKFILL_COMMITS=N` emits the last N commits (useful for demos).
- **Rebase / amend** — rewritten hashes emit as fresh commits. Accepted v1 behavior.
- **Checkout to older commit** — HEAD moves backward; `git log <last>..HEAD` returns empty; update last-seen without emitting.
- **Burst of commits** (e.g. pulling 20) — all emitted in order; no rate limiting in v1.

### Not in v1

- Worktrees and submodules (`.git` as a file). The watch target logic works identically once the gitdir pointer is resolved; small follow-up.
- Per-project watchers (multi-project mode).

## 2D viewer (browser)

New file [src/viewer/graph-viewer-2d.js](src/viewer/graph-viewer-2d.js). Becomes the default at `/viewer`; existing 3D viewer moves to `/viewer/3d`.

### Tech

- **d3-force** via ESM import map (no build step — matches existing viewer posture).
- **Canvas 2D** rendering (not SVG). Precise per-frame control over lerp-blended colors and opacities. Scales better at expected node counts (100s–1000s).
- **No framework.** Single entry file + a `shared/` directory.

### Module layout

```
src/viewer/
  graph-viewer.js            existing 3D viewer (unchanged)
  graph-viewer-2d.js         new 2D entry; wires everything
  shared/
    shapes.js                drawDiamond, drawCircle, drawPill, drawHex, drawTri
                             (drawDiamond uses per-side fitted dashes or ghost-fill per status)
    colors.js                palette constants + lerpRGB
    animation.js             per-node/edge lerp state manager, synapse pulses
    layout.js                d3-force config factory (distances, strengths per edge type)
    websocket.js             reconnecting client + event/mutation dispatcher
```

### Render loop

```
per frame:
  1. simulation.tick()      // d3-force integrates
  2. applyBreathing()       // micro-drift per node
  3. advanceLerps(dt)       // hover + synapse + fade states
  4. clearCanvas()
  5. drawEdges()
  6. drawNodes()
  7. drawLabels()           // zoom/hover-gated
  8. drawSynapsePulses()    // overlay particles
```

### Visual system

**Palette at rest (greyscale everywhere except decisions):**

| type | RGB (rest) | RGB (hover) |
|---|---|---|
| decision | 180,160,224 lavender | 190,170,235 |
| file | 102,102,102 | 140,200,210 cool teal |
| function | 85,85,85 | 130,170,140 muted green |
| component | 85,85,85 | 160,140,180 soft purple |
| reference | 68,68,68 | 140,130,160 warm grey-violet |
| path | 51,51,51 | 100,100,100 |

Background `#09090b`. Surface `#0d0d0d`.

**Shapes** (filled, no outlines at rest):

- decision — equal-sided diamond, r=7–8px
- file — circle, r=4–5.5px
- function — small circle (dot), r=2–3px
- component — pill (width ~1.8× height), same grey as function
- reference — hexagon, same scale as files, slightly darker
- path — triangle, darkest grey

**Status modifiers (option G — ghost fill):**

- `active` — filled at full opacity
- `proposed` — fill at **40% opacity**, no outline
- `superseded` — fill at 40% opacity + diagonal strike line

The 40% ghost-fill base is deliberate: the hover system dims non-highlighted nodes to 50% of base opacity; 40% × 50% = 20% keeps proposed/superseded readable. A lower base (e.g. 25%) would disappear when dimmed.

**Edge styles** — 0.5px white stroke at varying opacity:

| relation | rest α | hover α |
|---|---|---|
| GOVERNS | 0.05 | 0.35 |
| CALLS | 0.05 | 0.35 |
| IMPORTS | 0.035 | 0.35 |
| co-changed | 0.02 | 0.25 |

### Force simulation

```
forceLink:
  GOVERNS    distance 60–80px, strength 0.8
  CALLS      distance 80px,    strength 0.5
  IMPORTS    distance 100px,   strength 0.4
  co-changed distance 200px,   strength 0.1

forceManyBody (charge):
  decision  -300
  file      -100
  function   -50
  path       -30

forceCenter   strength 0.03
forceCollide  radius = node.size + 4
```

**Ambient breathing (always on):**

```
vx += sin(t * 0.008 + node.x * 0.01) * 0.0015
vy += cos(t * 0.006 + node.y * 0.01) * 0.0015
damping 0.92
```

On mutation, simulation alpha reheats to 0.3 (gentle, not 1.0). Equilibrium in ~2 seconds.

### Lerp hover

Per-node state `{ highlight: 0–1, colorMix: 0–1 }`. Per-edge state `{ highlight: 0–1 }`. Lerp factor 0.12/frame (~7 frames to 50%, ~20 to 95%).

On hover of node `h`:

- `h.highlight = 1, h.colorMix = 1`
- neighbors: `highlight = 0.6, colorMix = 1`
- others: `highlight = 0, colorMix = 0`

Interpolated per frame:

- opacity: `lerp(baseA * 0.5, baseA + 0.25, highlight)`
- color: `lerpRGB(greyPalette, hoverPalette, colorMix)`
- size: `base * (1 + highlight * 0.15)`
- label α: `lerp(0.07, 0.75, highlight)`
- edge α: `lerp(0.025, 0.35, highlight)`
- edge RGB: `lerpRGB(white, hoveredNodeHoverColor, highlight)`

### Synapse animations

Triggered by WebSocket mutations:

| trigger | visual |
|---|---|
| `add_node` | scale 0 → full over 60 frames, expanding ring ripple |
| `add_edge` | glow + pulse particle travels source→target |
| `remove_node` | fade 1 → 0 over 50 frames before deletion from data |
| `decision.superseded` event | choreographed 3s sequence: GOVERNS edges pulse staggered → old transitions to ghost-fill + strike → SUPERSEDES edge draws → new node enters with ring ripple → new GOVERNS edges fire pulses |

The superseded sequence is the only animation kicked off by an **event** rather than a mutation, because it's a choreography across multiple mutations.

### Mutation application

```js
function applyMutation(m) {
  switch (m.op) {
    case 'add_node':    nodes.set(m.node.id, m.node);
                        visual.set(m.node.id, { enterAge: 0, ...defaults });
                        simulation.nodes([...nodes.values()]);
                        simulation.alpha(0.3).restart();
                        break;
    case 'add_edge':    edges.set(edgeKey(m.edge), m.edge);
                        visualEdges.set(edgeKey(m.edge), { pulseAge: 0, ...defaults });
                        simulation.force('link').links([...edges.values()]);
                        break;
    case 'update_node': Object.assign(nodes.get(m.id), m.fields); break;
    case 'remove_node': visual.get(m.id).fadeOut = 1;
                        break;
    case 'remove_edge': visualEdges.get(...).fadeOut = 1; break;
  }
}
```

### Viewer shipping order (for implementation plan)

1. Static render: load graph, draw shapes, no animation, no interaction
2. Force sim + breathing
3. Hover lerp + tooltip
4. WebSocket wire-up + basic mutations (no synapse yet)
5. Synapse animations (add_node, add_edge, remove_node)
6. Supersession choreography
7. Search + filter
8. Detail panel (click-to-open)
9. Focus mode (local graph)

Steps 1–5 = v1 "good." Steps 6–9 = v1 "complete." Each independently shippable.

## Activity stream

New route `/viewer/stream` and a companion component inside the 2D viewer page. Same WebSocket hydrates both.

### Layout

- 1px rail at `left: 22px`, color `#131313`. Last-event rail fades to transparent.
- Event row: `padding: 18px 20px 18px 44px` (right padding is real, not flush).
- Compact rows: `padding: 12px 20px 12px 44px`.
- Dividers: `1px solid #111`.
- Marker: inline SVG, 12×12 for decisions, 10×10 for commits.
- All text greyscale. Color appears only on markers.

### Event rendering

- `decision.created` — full card: title, rationale, governed files
- `decision.superseded` — card with old title struck → new title
- `decision.updated` — compact inline
- `decision.promoted` — compact inline
- `decision.deleted` — compact inline (uses snapshot title)
- `decision.proposed` — full card with ghost-fill diamond marker
- `commit` — card with message, diff stats, linked decisions

### Toolbar

Sticky at top.

- Search input (left, flex: 1). `/` keybind focuses.
- Filter chips (right): `all` · `decisions` · `commits` · `proposals`. One active at a time. Count badges.
- `Escape` in search clears and blurs.

### Streaming behavior

- Incoming event prepends with `slideIn 0.4s ease-out` (opacity 0→1, translateY -8→0).
- Fresh-row tint `rgba(255,255,255,0.020)` for 2s, transitions out over 1.6s.
- Timestamps: relative, updated every 30s. `<1m = "now"`, `<60m = "Nm"`, `<24h = "Nh"`, then absolute date.
- If user has scrolled up into history, new events do **not** auto-scroll to top. A "↑ N new" pill appears at the top of the viewport; click to jump.

### Backfill behavior

- Infinite scroll upward. When top of scroll area comes within 200px of the topmost rendered event, client sends `{ type: 'backfill', before_id, limit: 50 }`.
- Server responds with `backfill_page`; client appends to top.
- `has_more: false` → hide loader, show "— end of history · YYYY-MM-DD HH:MM —".

### Graph ↔ stream sync

- Click stream event → graph highlights referenced nodes (lerp to hover state), pans to fit.
- Click graph node → stream scrolls to most recent event referencing that node. Flash-highlight on arrival if it was offscreen.

Both views consume the same WebSocket mutation/event stream — no additional plumbing.

## Error handling

| Failure | Response |
|---|---|
| Worker crash | Main restarts with exp backoff 1s/2s/4s/max 30s. MCP writes still succeed; events for the gap are lost (not persisted, not broadcast). Clients see it as quiet. |
| Main crash | Process restart is external (whoever started it). Clients reconnect with backoff. |
| SQLite write fail (worker) | Log, increment counter, drop event. Threshold (5 in 60s) → emit `system.degraded` event (future hook; v1 just logs). |
| `ws.send()` fail to one client | Remove from registry, close. Client reconnects. |
| Malformed client message | Respond `{type:'error'}`, do not disconnect. |
| Git watcher fail | Log once, stay idle, retry on next fs event. No worker crash. |
| Client state drift > 500 mutations | Client discards local state, re-fetches `GET /api/graph`, re-subscribes. |

## Testing strategy

**Unit (vitest):**

- `DecisionService` event emission — every mutating method emits one correctly-shaped event (mock bus).
- Event persister — event in → SQLite row out; schema invariants.
- Mutation deriver — per event kind, assert mutation sequence. Pure function, snapshot-able.
- Git watcher parser — fixture `.git/logs/HEAD` + mocked `git log` output → assert emitted event payload. Parser isolated from file-watching.
- WS message codecs — round-trip every variant.

**Integration:**

- End-to-end: main + worker in-process, create a decision → assert matching event at a test WS client. Repeat for update/supersede/promote/delete.
- Git: point watcher at temp repo, real `git commit` → event arrives within 500ms.
- Backfill: seed 120 events, connect client, assert newest-50 page with `has_more:true`, then scroll-back returns next 50.
- Crash recovery: kill worker mid-stream, assert auto-restart and resume.

**Browser (Playwright, smoke only):**

- Viewer loads, hydrates from `/api/graph`, renders nodes.
- Mock WS, push `add_node`, assert new node in `window.__cortex_viewer_state`.
- Push `decision.created` event, assert stream row appears.

**Not tested in v1:**

- Synapse animation timing (visual, hand-verified)
- Force equilibrium (emergent, non-deterministic)
- Cross-browser rendering (Chromium only; iterate if needed)

## Documentation deliverables

First-class, not afterthought.

### `docs/architecture/graph-ui.md`

Standalone architecture doc (~2000 words), complementary to this spec. Contents:

1. System overview (one paragraph)
2. Thread model diagram (polished version of the one above)
3. **Event flow walkthrough** — traced example of "Claude creates a decision," hop by hop from MCP call to pixel
4. Component boundaries (what each module owns, talks to, does not talk to)
5. **Design rationale** — every major choice with tradeoffs considered
6. **Extending the system** — how to add a new event kind, data source, mutation type, stream renderer, animation
7. Deferred / future work (from the list below)
8. Testing summary

### Code-level TSDoc standard

Every new public surface gets TSDoc with:

- What it does (one sentence)
- Why it exists (problem it solves, alternatives considered inline if non-obvious)
- Invariants (what must be true of inputs/outputs, what callers must guarantee)
- Boundaries crossed (MessagePort message, SQLite write, socket send, etc.)

Specific coverage targets:

- Every type in `src/events/types.ts` (events, mutations, WS messages)
- Every exported function/class in `src/events/`, `src/viewer/shared/`, `src/viewer/graph-viewer-2d.js`
- Every `MessagePort` contract (message shape documented explicitly)
- Every `DecisionService` method that emits

Inline comments only where *why* is non-obvious: reconnect/backfill sequencing, ordering guarantees (event emitted *after* SQLite commit), worker-boundary error propagation.

### README + CLAUDE.md

- [README.md](README.md) gains a "Graph UI" section linking to the architecture doc.
- [CLAUDE.md](CLAUDE.md) gains a pointer so future Claude sessions find the doc first.

## Future extensibility

Deferred items, with the prep we've built in so they drop in without structural refactors.

| Future feature | Prep already in v1 |
|---|---|
| **Multi-user / collaboration** | `actor` and `project_id` on every event; subscribe protocol is extensible (add `{type:'subscribe', project_id}` without breaking existing clients). `author` column on decisions. |
| **Gap detection** | Dotted `kind` taxonomy makes `gap.detected` drop-in. Worker pipeline is ready to host the detector as an additional stage. |
| **Temporal slider** | Persisted event log with `created_at` index — backfill is just a SQL query by time range. |
| **External event bus** (Redis/Kafka/NATS) | Worker boundary *is* the bridge point. Replace worker's `postMessage → main` with `postMessage → publish`; main thread untouched. |
| **Louvain clustering** | Worker pipeline has a natural slot. `/api/graph` can add a `cluster_id` field per node; viewer can draw convex hulls without any protocol change. |
| **CBM re-index triggers** | Same worker pipeline slot. CBM change events ride the same bus. |
| **VS Code sidebar extension** | WS protocol and data shapes reusable as-is. Only the renderer changes. Sidebar-specific layout concerns (narrow width, compact text, file-focused) are pure UI work. |
| **Phone PWA** | Same WS protocol. Focus-mode (local graph) and bottom-sheet detail panel are renderer-only additions. |

## Implementation shipping order

Backend-first, agreed during brainstorm. Each step is independently reviewable.

1. **Events infrastructure** — `events.db` schema, event bus, `DecisionService` emission sites, worker thread with MessagePort.
2. **Git watcher** — chokidar + parser + `meta` table for last-seen HEAD.
3. **WebSocket server** — upgrade handler, connection registry, heartbeat, backfill endpoint.
4. **2D viewer (static → animated)** — the nine-step ladder listed in the viewer section.
5. **Activity stream** — rendering, search/filter, backfill, live prepend.
6. **Graph ↔ stream sync** — click-to-navigate both directions.
7. **Error handling, reconnect logic, drift-recovery** — tested.
8. **Architecture doc + TSDoc coverage** — concurrent with implementation, not a last-pass sweep.
9. **Playwright smoke suite** — added at the end, covering the critical paths.

## Open items explicitly out of scope

Listed so future work doesn't forget them:

- Worktrees / submodules (`.git` as a file)
- Per-actor filter in stream
- Date-range filter in stream
- Pixel diff testing
- Non-Chromium browser testing
- Retention policy for `events.db`
- `author` sourcing when UI flows appear (today always `'claude'`)
- System event emission (`system.degraded`, etc.) — hooks mentioned in error handling but not emitted in v1

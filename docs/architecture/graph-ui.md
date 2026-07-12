# Graph UI Architecture

> Living document. Started 2026-04-17. Updated as the system is built.

## System overview

Cortex emits structured events for decision lifecycle and git activity, persists them to an append-only SQLite log, derives graph mutations from those events, and broadcasts both over a WebSocket. A 2D graph viewer and an activity stream consume the broadcasts in tandem. The system runs entirely inside the existing Cortex MCP process — no external broker, no separate service.

## Thread model

```
┌──────────────────────────── Main thread ────────────────────────────┐
│                                                                      │
│  stdio ──► MCP server ──► DecisionService ──► cortex.db             │
│                                   │                                  │
│                          emit(event)  [EventBus]                     │
│                                   │                                  │
│                     bus.onEvent listener in src/index.ts             │
│                                   │                                  │
│                           postMessage({ type:'event', event })       │
│                                   │                                  │
│  HTTP :3333                       │                           ▲      │
│  ├─ GET /api/graph                │          postMessage      │      │
│  ├─ GET /viewer/*                 │     { type:'broadcast',   │      │
│  └─ WS /ws ◄── ClientRegistry ◄──┼─────── bundle }           │      │
│        │  broadcast(bundle)        │                          │      │
└────────┼──────────────────────────┼──────────────────────────┼──────┘
         │  [WorkerSupervisor]       │                          │
┌────────┼───────────────────────── Worker thread ─────────────┼──────┐
│        │                          ▼                          │      │
│        │              on('message') handler                         │
│        │                          │                                 │
│        │                  EventPersister.insert()                   │
│        │                  └─► events.db  (WAL, worker-owned)        │
│        │                          │                                 │
│        │                  deriveMutations(event, lookup)            │
│        │                          │                                 │
│        │                  postMessage({ type:'broadcast', bundle }) ┘
│        │                                                            │
│        │  GitWatcher (chokidar on .git/logs/HEAD)                   │
│        │  └─► git log <range> --name-status                        │
│        │  └─► parseGitLogOutput()                                  │
│        │  └─► emit({ kind:'commit', ... }) into same pipeline      │
└─────────────────────────────────────────────────────────────────────┘
```

**Arrow labels:**
- `emit(event)` — synchronous call on `EventBus` (in-process, main thread only)
- `postMessage({ type:'event', event })` — MessagePort crossing main → worker
- `postMessage({ type:'broadcast', bundle })` — MessagePort crossing worker → main
- `registry.broadcast(payload)` — JSON string fan-out to all open WebSocket clients

## Event flow: "Claude creates a decision"

1. Claude invokes MCP tool `decision` with `action:"create"` (stdio).
2. Tool handler in `src/mcp-server/server.ts` calls `DecisionService.create()`.
3. `DecisionService.create()` writes to `cortex.db` via `GraphStore` (`src/graph/store.ts`).
4. `DecisionService` calls `bus.emit(event)` with a `decision.created` event (`src/events/bus.ts`).
5. The bridge listener registered in `src/index.ts` receives the event and calls `supervisor.current()?.postMessage({ type: 'event', event })`.
6. The worker (`src/events/worker.ts`) receives the message, calls `persister.insert(event)` — writes to `events.db`.
7. Worker calls `deriveMutations(event, lookup)` (`src/events/worker/mutation-deriver.ts`) — produces `add_node` + N×`add_edge` mutations.
8. Worker posts `{ type: 'broadcast', bundle: { events: [event], mutations } }` back to main.
9. Main's `worker.on('message')` handler in `src/index.ts` calls `wsHandle.broadcast(bundle)`.
10. `startWsServer`'s `broadcast()` in `src/ws/server.ts` iterates `bundle.events` and `bundle.mutations`, encodes each as `ServerMsg` via `encodeServer()`.
11. `ClientRegistry.broadcast(payload)` fans out to every open WebSocket client (`src/ws/client-registry.ts`).
12. Viewer clients receive separate `{ type:'event' }` and `{ type:'mutation' }` messages; stream renders the event, graph applies the mutation.

The read-path sync engine (projection deltas, catch-up, the viewer's reactive store and live change treatments) is documented in [viewer-sync-engine.md](viewer-sync-engine.md).

## Component boundaries

### EventBus (`src/events/bus.ts`)

**Owns:** In-process sync dispatch. A `Set<EventListener>`; `emit()` calls each in registration order.

**Talks to:** `DecisionService` (emitter), `src/index.ts` bridge (consumer).

**Does NOT talk to:** The worker, WebSocket, or SQLite. It is a pure in-process channel.

---

### EventPersister (`src/events/worker/persister.ts`)

**Owns:** The `events.db` SQLite connection (WAL mode). Schema apply, `insert`, `backfill`, `getMeta`/`setMeta`.

**Talks to:** `better-sqlite3` only.

**Does NOT talk to:** Main thread. The main thread holds a *separate* `EventPersister` instance opened read-only for backfill serving; it never calls `insert`. Cross-thread WAL concurrency is safe for one writer + multiple readers.

---

### `deriveMutations` (`src/events/worker/mutation-deriver.ts`)

**Owns:** The mapping from event kind → ordered `GraphMutation[]`.

**Talks to:** A `NodeLookup` callback (backed by an in-worker snapshot map populated from `/api/graph` at init).

**Does NOT talk to:** SQLite, MessagePort, or network. Pure function — input event + lookup → output mutations.

---

### Worker thread (`src/events/worker.ts`)

**Owns:** The `init` → `event` → `broadcast` message loop. Composes `EventPersister` + `deriveMutations` + `GitWatcher`.

**Talks to:** Main thread via `parentPort`, and `EventPersister` (SQLite).

**Does NOT talk to:** HTTP, WebSocket, or `cortex.db`.

---

### GitWatcher (`src/events/worker/git-watcher.ts`)

**Owns:** chokidar watch on `.git/logs/HEAD`, `git log` shelling, `parseGitLogOutput` call, commit → `Event` translation, `meta` table for last-seen HEAD.

**Talks to:** `EventPersister` (getMeta/setMeta), `emit` callback (into worker pipeline).

**Does NOT talk to:** Main thread directly. Does not write to the `events` table — it calls `emit()` which the worker's `scan` loop handles.

---

### WorkerSupervisor (`src/events/worker-supervisor.ts`)

**Owns:** Worker lifecycle. Spawns via provided factory, re-spawns on `error`/`exit` with exponential backoff (1s → 2s → 4s, cap 30s). Calls `onSpawn` after each start so the caller can re-send `init`.

**Talks to:** `Worker` (node:worker_threads).

**Does NOT talk to:** EventBus, WebSocket, SQLite. It is a pure lifecycle wrapper.

---

### ClientRegistry (`src/ws/client-registry.ts`)

**Owns:** The `Set<WsLike>` of connected clients. `add`/`remove`/`broadcast`/`forEachOpen`. Evicts dead clients on send failure.

**Talks to:** WebSocket instances (via duck-typed `WsLike` interface).

**Does NOT talk to:** SQLite, worker thread, or event bus.

---

### WebSocket server (`src/ws/server.ts`)

**Owns:** The `/ws` upgrade handler, `hello` send on connect, `ping`/`backfill` client message handling, `broadcast()` method that encodes and fans out to `ClientRegistry`.

**Talks to:** `ClientRegistry`, `EventPersister` (backfill reads only), `encodeServer`/`decodeClient` (`src/ws/protocol.ts`).

**Does NOT talk to:** Worker thread, EventBus, or `cortex.db`.

## Design rationale

### Why two threads, not a single-threaded event loop

MCP latency must stay sub-10ms. Event persistence + mutation derivation + WebSocket fan-out add non-trivial work after each `DecisionService` write. On a single thread, a 10-client broadcast with slow sockets would stall the next MCP call. The worker boundary isolates all of that. The extension surface (gap detection, Louvain, indexer re-index) slots in without any future refactor.

Alternative considered: async queue on main thread. Rejected because SQLite `better-sqlite3` is synchronous and would block the event loop on every insert.

### Why two SQLite files, not one with multiple tables

`cortex.db` is written by the main thread. `events.db` is written by the worker. A single WAL file with two writers across threads would require `BEGIN IMMEDIATE` serialization — killing the isolation benefit. Separate files also enable independent backup, retention policies, and a future swap of `events.db` for an external bus (Redis/NATS) without touching the graph store.

### Why ULID for event IDs, not autoincrement or UUIDv4

ULIDs encode wall-clock time in their first 10 bytes, so `ORDER BY id` equals `ORDER BY created_at` without an extra index. Monotonic factory ensures strict ordering within the same millisecond. UUIDv4 is random — queries need a separate `created_at` index and `ORDER BY created_at, id`. Autoincrement integers don't survive across multiple processes or future multi-project merges.

### Why pure mutation deriver, not mutations on the bus

`deriveMutations` has no side effects and is easy to test in isolation. Putting mutation logic on the bus would couple the derivation to the emission order and force every `EventBus` consumer to skip mutations it doesn't care about. The worker is the only entity that needs mutations; keeping derivation there avoids polluting the main-thread bus.

### Why client-driven backfill, not server push on connect

Server-push requires the server to track "what has each client seen" — stateful per-connection bookkeeping. Client-driven `{ type:'backfill', before_id?, limit? }` keeps the server stateless. Cursor pagination by ULID is stable even if events arrive while the client is scrolling back.

### Why single-project implicit subscribe, not explicit subscribe protocol

The Cortex process is always started for one project (the cwd). A `{ type:'subscribe', project_id }` message adds round-trip latency before the viewer renders anything and requires the server to validate project IDs. The implicit model lets `hello` immediately tell the client which project it's on, and the viewer can show content before the user does anything.

## Extending the system

### Adding a new event kind

1. Add the discriminant to `Event` in `src/events/types.ts`.
2. Add a case to `deriveMutations()` in `src/events/worker/mutation-deriver.ts` (return `[]` if the event has no graph impact).
3. Emit from the appropriate service method via `bus.emit(event)`.
4. Add a test case to `tests/events/mutation-deriver.test.ts`.

Nothing else changes — the event flows through the pipeline automatically.

### Adding a new data source (e.g., a filesystem watcher for non-git events)

1. Create a class in `src/events/worker/` similar to `GitWatcher` — accepts `emit: (event: Event) => void`.
2. Instantiate it in `src/events/worker.ts` on `init`, pass `(event) => { persister.insert(event); post(broadcast...) }` as the emit callback.
3. The new watcher feeds into the same persist → derive → broadcast pipeline.

### Adding a new graph mutation op

1. Add the op variant to `GraphMutation` in `src/events/types.ts`.
2. Handle it in `deriveMutations()`.
3. Handle it in the viewer's mutation applier (Plan C, a future `src/viewer/websocket.js` — WS integration is parked in the current iteration).

The wire protocol (`ServerMsg`) already carries `GraphMutation` as-is; no protocol change needed.

### Adding a new stream event renderer (Plan C — browser side)

Stream rendering is parked alongside the viewer's WebSocket integration in the current iteration. When it returns, it will live in the viewer (`src/viewer/`). The backend emits events unchanged; a renderer branch in the activity-stream component will key on `event.kind`. No backend change needed for new display-only formatting.

## Deferred / future work

- **`decision.proposed` emitter** — the event kind is declared in the type union and handled by the mutation deriver, but no v1 code path emits it. A "propose a decision" UI flow (Plan B) will add the emitter.
- **Multi-user / collaboration** — every event already has `actor` + `project_id`. Add `{ type:'subscribe', project_id }` to the protocol; server sends only matching events. No schema migration needed.
- **Gap detection** — add a gap-detector stage in the worker pipeline between `persister.insert()` and `deriveMutations()`. Emits `gap.detected` events when ULID timestamps show a hole.
- **Temporal slider** — `events.db` is append-only and ULID-ordered. A time-travel query is `SELECT * FROM events WHERE id <= <ulid-at-time> ORDER BY id`.
- **External event bus (Redis/Kafka/NATS)** — replace `EventPersister.insert()` in the worker with a publish call; subscribe in a separate consumer that writes to `events.db`. Main thread unaffected.
- **Louvain clustering** — add as a post-derivation stage in the worker. Input: mutation bundle + current node map. Output: additional `update_node` mutations with `cluster_id` field.
- **VS Code sidebar** — a separate extension process connects to `/ws` as an additional WebSocket client. No backend changes needed.
- **Phone PWA** — same as VS Code sidebar.

## Testing strategy

**`tests/events/ulid.test.ts`** — verifies monotonicity within the same millisecond and that IDs are 26-character strings. Pure unit test.

**`tests/events/bus.test.ts`** — verifies emit delivers to all listeners, listener errors don't stop delivery, and off() removes a listener. Pure unit test on `EventBus`.

**`tests/events/mutation-deriver.test.ts`** — verifies each `Event` kind produces the correct `GraphMutation[]`. Uses a Map-backed `NodeLookup` stub. Pure function tests — no I/O.

**`tests/events/git-log-parser.test.ts`** — verifies the parser handles multi-commit output, empty commits, rename/copy status, and the blank line real `git log` inserts between the format header and file list. Pure function tests — no I/O.

**`tests/events/persister.test.ts`** — verifies insert, backfill cursor pagination, and getMeta/setMeta against an in-memory SQLite database (`:memory:`). Tests the WAL-mode init and schema apply.

**`tests/integration/worker-crash.test.ts`** — verifies restart on worker exit, exponential backoff delay, and `stop()` preventing further restarts. Uses a fake `Worker` that emits `exit` on demand.

**`tests/ws/client-registry.test.ts`** — verifies add/remove/broadcast fan-out, non-OPEN client eviction on send failure, and the closed-without-error evict path. Uses plain objects satisfying `WsLike`.

**`tests/ws/protocol.test.ts`** — verifies `encodeServer` round-trips and `decodeClient` throws on malformed JSON, non-objects, and unknown `type` values.

**`tests/integration/git-watcher.test.ts`** — spins up a real git repo in a temp directory, creates a commit, calls `watcher.scan()` directly (deterministic, no chokidar timing), and asserts the emitted `commit` event has the correct fields and `decision_links`.

**`tests/integration/ws-server.test.ts`** — starts a real HTTP+WS server on a random port, connects a real `ws` client, and asserts: `hello` on connect; `pong` in response to `ping`; `backfill_page` in response to `backfill`; `error` on malformed message without disconnect.

**`tests/integration/worker.test.ts`** (and related) — covers the full worker message loop: `init` → `event` → `broadcast` round-trip using a real worker thread spawned via the bootstrap.

**`tests/viewer/data-adapt.test.js`** — verifies `adaptProjectData` (now `canvas/adapt.js`, re-exported through `app/data.ts`) turns the six raw API payloads into the exact bundle shape `engine.setData` expects — full member lists (the LOD dot budget caps at draw time, not adapt time) — and the `resyncProject` path that reuses `rawFrameMap` to keep frame positions stable across a live resync. Pure function tests — no I/O. (`tests/viewer/adapt.test.js` covers the direct `canvas/adapt.js` import path.)

**`tests/viewer/display.test.js`** — verifies `decisionDisplayId`/`todoDisplayId`/`projectDisplayName` (`app/display.ts`) fall back correctly when `seq`/`root_path` are absent. Pure unit tests.

**`tests/viewer/drawer-stack.test.js`** — verifies `openReplace`/`push`/`pop`/`closeAll` (`app/drawer/drawer-stack.ts`), including `push`'s de-dupe-against-top behavior so a same-record re-click doesn't grow the stack. Pure unit tests.

**`tests/viewer/selectors.test.js`** — verifies `fileCardData`, `resolveTodo`'s three-tier fallback (ambient → allTodos → removed snapshot), and `listRows`'s open-then-closed, newest-first ordering (`app/drawer/selectors.ts`). Pure unit tests.

**`tests/viewer/fuzzy.test.js`** — verifies the palette's fuzzy scorer (`app/palette/fuzzy.ts`) ranks contiguous/prefix matches above scattered ones and returns 0 for a non-match. Pure unit tests.

**`tests/viewer/search-index.test.js`** — verifies `buildSearchIndex`/`searchIndex` (`app/palette/search-index.ts`) produce one capped, score-sorted array per non-empty group in fixed `GROUP_ORDER`. Pure unit tests.

## Frames viewer

The viewer's rendering model is derived from the visual prototype at
[docs/specs/archive/cortex-v0.3/cortex-frames-prototype-v5.html](../specs/archive/cortex-v0.3/cortex-frames-prototype-v5.html).
Frames come from cluster output (`data.frame_id`/`frame_label` on file
nodes, written by `scripts/frame-extraction/inject-frames.ts` — see
[frame-extraction.md](frame-extraction.md) for the pipeline). Decisions
come from the out-of-repo sidecar `~/.cortex/<repoId>/decisions.db` via the
`/api/decisions` adapter. CALLS edges are pulled from `/api/graph` and filtered to
intra- and inter-frame pairs. Auxiliary content (locales, vendored,
`__snapshots__`, etc.) is bucketed by `groupAuxiliaryPaths` and surfaced
via `/api/aggregates`.

As of the viewer-v2 rewrite, the chrome (toolbar, drawer, command palette)
is a Vite + React 18 + TypeScript + zustand app under `src/viewer/app/`;
the canvas draw loop stays the original imperative `requestAnimationFrame`
engine under `src/viewer/canvas/`, wrapped behind a `createEngine(...)`
factory so React never draws to the canvas and the engine never touches
the DOM outside it (decision: "Viewer chrome in React 18 behind an
imperative canvas engine boundary"). The viewer is still load-then-live:
all data is fetched once on page load / project switch, but WebSocket
integration with the event stream **is** wired in this iteration (owned by
`CanvasHost`, see Data flow below) — live decision/todo changes update the
canvas and the entity store without a refetch of the whole graph.

### Module layout

| Module | Owns | Pure? |
|---|---|---|
| `app/main.tsx` | React entry point (`createRoot`) | no |
| `app/App.tsx` | Top-level layout; global keybindings (⌘K, Esc); syncs theme/`layerPrefs` to `localStorage` + the engine | no |
| `app/ui-store.ts` | zustand store — single source of UI state (`drawerStack`, `paletteOpen`, `projects`, `activeProject`, `layerPrefs`, `bundle`, sync status, `removedSnapshots`); `LS_KEYS` constants | no |
| `app/CanvasHost.tsx` | Owns the `<canvas>` element, the `createEngine` instance (`engineRef`), the entity store (`entityStore`), and `ws-client`; boot / project-switch / live-resync orchestration | no |
| `app/api.ts` | `fetchProjects/fetchGraph/fetchDecisions/fetchAggregates/fetchFileEdges/fetchFrames/fetchTodos` | yes |
| `app/data.ts` | `adaptProjectData` (pure bundle builder), `loadProject`, `resyncProject` | yes (adapter); I/O at the `load*`/`resync*` boundary |
| `app/display.ts` | `decisionDisplayId`/`todoDisplayId`/`projectDisplayName` | yes |
| `app/entity-store.js` (+`.d.ts`) | Reactive decisions/todos store (pre-React module, unchanged; now constructed and owned by `CanvasHost`) | no (mutable store) |
| `app/ws-client.js` | WS reconnect + resync client (pre-React module, unchanged; now constructed and owned by `CanvasHost`) | no |
| `app/toolbar/` | `Toolbar.tsx`, `ProjectSelect.tsx` (custom dropdown, click-outside-to-close), `LayersMenu.tsx` (layer toggles + legend, imports `LAYER_RGB` from the engine) | no |
| `app/drawer/` | `Drawer.tsx` (stack shell), `DecisionView.tsx`, `TodoView.tsx`, `FileCard.tsx`, `ListView.tsx`, `RefPill.tsx`, `drawer-stack.ts` (pure), `selectors.ts` (pure) | mixed — see table rows above |
| `app/palette/` | `Palette.tsx` (⌘K overlay), `actions.ts` (pure), `fuzzy.ts` (pure), `search-index.ts` (pure) | mixed |
| `canvas/engine.js` | `createEngine(...)` — the rAF draw loop, frame focus/hover, hit-testing, live-effects wiring; unchanged mechanics, now a boundary the React shell calls into | no (side-effectful) |
| `canvas/adapters.js` | `groupNodesIntoFrames`, `basenames`, `buildFrameGovernance`, `edgesInternalIndex`, `frameCoverage`, etc. — unchanged | yes |
| `canvas/live-effects.js` | Tombstone/birth/presence animation state — unchanged | mostly yes |
| `dist/` | **Committed** Vite build output (`index.html` + hashed `assets/*.js`/`*.css`) — what the server actually serves | n/a (build artifact) |

**The `createEngine` interface** (`canvas/engine.js`):

```js
const engine = createEngine({ canvas, store, callbacks: {
  onFrameFocus(id: string | null),          // frame focus changed (incl. cleared)
  onRecordClick(type: string, id: string),  // decision/todo dot clicked
  onRecordDismiss(),                        // in-canvas dismiss (e.g. click empty space)
  onFileClick({ filePath: string }),        // file node clicked
} });

engine.setData(bundle, { preserveFocus? });  // load/replace the render-state bundle
engine.applyLiveChanges(changes);            // apply entity-store deltas incrementally
engine.setLayerPrefs(prefs);                 // { showFrames, showDecisions, showTodos, layerTint }
engine.getLayerPrefs();                      // current prefs (React seeds ui-store from this at boot)
engine.focusFrame(id | null);
engine.setActiveRecord({ type, id } | null);
engine.getActiveRecord(); engine.getFocusedFrameId(); engine.frameIdForFilePath(path);
engine.start(); engine.resize(); engine.destroy();
```

`store` is the `entity-store.js` instance — the engine reads `store.state.decisions`/`store.state.todos` by reference (object identity is stable across live updates). Pure modules (`app/data.ts`, `app/display.ts`, `app/drawer/{drawer-stack,selectors}.ts`, `app/palette/{fuzzy,search-index,actions}.ts`, everything in `canvas/adapters.js`) are unit-tested in vitest; `canvas/engine.js` and the React components are hand-verified against the running dev server (canvas rendering/animation timing, and most DOM interaction, aren't practically testable headlessly).

The simulation features in the original prototype (multi-agent demo, synapse
animations, PR floating nodes, auto-loop, presence avatars, merge
animation, cursor traversal) remain out of scope — explicit non-goals for
the frames viewer.

### Layer lens (taxonomy milestone 1)

Every frame carries a deterministic architectural `layer`
(`interface | orchestration | domain | data | infrastructure | ceremony`),
classified at read time in `buildFrameMap` by
[`frame-kind.ts`](../../src/frame-extraction/frame-kind.ts) from directed
frame flows ([`frame-flow-rollup.ts`](../../src/frame-extraction/positioning/frame-flow-rollup.ts)),
path patterns, and content signals. The viewer's `layers` toolbar menu holds a
show-layers switch and the only legend; when on, frame fill/border/label take
a quiet per-layer hue — when off, rendering is pixel-identical to the lens-less
viewer (the draw path's `else` branches are the literal pre-lens expressions).
Classifier internals (confidence, per-source contributions) are deliberately
never serialized or rendered; they exist only in the eval harness
(`tests/frame-extraction/expected-layers.test.ts`, whose frozen fixture is the
regression net for classifier tuning). Milestone 1 left ranking and layout
untouched (classify → observe → enable; see
[the design spec](../superpowers/specs/2026-06-12-frame-layers-taxonomy-design.md));
the **enable slices** have since wired the layer into ranking:

- **Kind-weight (slice 3a, on by default)** — `score ×= kind_weight` per layer;
  `CORTEX_KIND_WEIGHT=0` opts out. Decision `D-g4qb`.
- **Layer-diversity (slice 3b, on by default since 0.8.20)** — a greedy
  layer-aware ambient-set *selection* in
  [`frame-diversity.ts`](../../src/frame-extraction/frame-diversity.ts)
  (`selectAmbientByDiversity`), consumed in `buildFrameMap`: geometric
  repeat-decay + ceremony cap, then bounded coverage repair (≥1 of
  domain/interface/data when present). `CORTEX_LAYER_DIVERSITY=0` opts out
  (restores the ranker's kind-weighted top-budget set). Flipped on after a
  positive corpus observe verdict. Decision `D-wvsz`;
  [design](../superpowers/specs/2026-06-15-layer-diversity-enable-slice-design.md).

- **Layer-adjacency layout force (layout slice part 1, shipped 0.8.21, ON by
  default since 0.8.22)** — a vertical `forceY(yTarget(sink))` in
  [`frame-layout.ts`](../../src/frame-extraction/positioning/frame-layout.ts) stratifies ambient
  frames surface→substrate from each frame's **measured** sink
  (`fanIn/(fanIn+fanOut)`; per-layer `NOMINAL_SINK` fallback for flowless frames),
  on the proven force base (pair-link clustering / charge / collide unchanged).
  The layout module stays layer-agnostic — `frame-map.ts` computes the effective
  sink and reads `CORTEX_LAYER_LAYOUT` (now an **opt-out**; set `"0"` to restore
  the byte-identical pre-slice `forceCenter` path). Flipped default-on after a
  positive corpus observe pass (Spearman(y, sink) mean ≈ 0.77). Decision `D-marq`;
  [design](../superpowers/specs/2026-06-16-layer-adjacency-layout-force-design.md).

- **Floating-entity placement (layout slice part 2, shipped 0.8.23)** — a pure
  server-side **gravity-centroid** pass in
  [`floating-placement.ts`](../../src/frame-extraction/positioning/floating-placement.ts) runs
  *after* the (byte-identical) ambient force-sim and positions the *satellites*:
  non-ambient frames at the pair-weighted centroid of the ambient frames they
  connect to (`rollupFramePairs`), and auxiliary aggregates via an
  **edge → path → margin** tie cascade
  ([`aggregate-ties.ts`](../../src/frame-extraction/positioning/aggregate-ties.ts): CALLS/USAGE/IMPORTS
  edges to frames, else shared directory ancestry, else a de-emphasized margin
  slot). `separateMovables` then guarantees **no satellite overlaps an ambient
  frame or another satellite** (0.8.24): a deterministic greedy free-slot placer —
  each satellite keeps its seed if free, else takes the nearest unoccupied spot
  found by scanning outward in integer grid rings (no trig → cross-platform
  deterministic). Positions are emitted in `/api/frames` (non-ambient frames) and
  `/api/aggregates` (via `aggregate-positioning.ts`); the viewer renders
  satellites de-emphasized **and the two fixed strips are gone**. Governance
  *selection* stays client-side (the viewer picks which non-ambient frames to
  render from `FRAME_GOVERNANCE`), but their *position* comes from the server —
  **supersedes the `D-xwxj` stopgap**. The pass depends only on `(final ambient
  positions, ties)`, never on *how* those positions were produced, so a future
  network/layered layout mode composes on top unchanged.
  [design](../superpowers/specs/2026-06-16-floating-entity-placement-design.md).

### Render loop

`mainLoop` runs once per `requestAnimationFrame`:

1. clear canvas, ease focus transition
2. `drawFrames(now)` — frame boxes + labels with focus-state styling
3. `drawEdges()` — intra- and inter-frame edges
4. `drawNodes(now)` — file nodes inside frames
5. `drawMarginaliaForFrame(focused, alpha)` when a frame is focused — decision pills
6. `drawFloatingDecisionNodes(now)` — ambient decision dots
7. `drawHoverPill(now)` / `drawCompactHoverBadge(now)` — hover affordances

`buildGraph()` (called from `setData`, the engine's public entry point for
a fresh load or a live resync) rebuilds the in-memory `nodes`
and `edges` arrays from `FRAMES`/`NODE_CFG`/`FILE_NAMES`. Edges are
real CALLS edges from `/api/graph`, filtered via
`edgesInternalIndex` (`adapters.js`) to keep only pairs whose endpoints
are both in the current frame set. Auxiliary content (locales, vendored,
generated dirs, …) is grouped via `groupAuxiliaryPaths`
(`src/frame-extraction/auxiliary-detection.ts`), positioned server-side at its
gravity centroid (see floating-entity placement above), and rendered as bare
dots near related frames — present but visually de-emphasised.

### Data flow

1. `CanvasHost`'s mount effect constructs `entityStore` (`entity-store.js`) and
   `createEngine({ canvas, store, callbacks })`, then calls its own `boot()`.
2. `boot()` calls `fetchProjects()` (`app/api.ts`), then
   `loadProject(active)` (`app/data.ts`), which runs the six fetchers
   (`fetchGraph/fetchDecisions/fetchAggregates/fetchFileEdges/fetchFrames/fetchTodos`)
   in parallel and pipes the results through `adaptProjectData` (now in
   `canvas/adapt.js`, re-exported by `app/data.ts` — part of the vendorable
   engine unit) — the pure function that owns everything the old `loadGraph`
   did between "data arrived" and "canvas graph rebuilt" (frame bucketing via
   `groupNodesIntoFrames`, frame positioning from `/api/frames`, governance
   maps; full member lists — the LOD dot budget decides draw-time counts).
3. `entityStore.hydrate({ decisions, todos, cursor })` seeds the reactive
   store; `engine.setData(bundle)` assigns render state and calls
   `buildGraph()`; `engine.start()` kicks off `mainLoop`.
4. **Project switch** — a zustand subscription in `CanvasHost` watches
   `activeProject`; on change it re-runs `loadProject`, calls
   `engine.setData(bundle)` (fresh focus, not preserved), and resets
   `drawerStack`/`focusedFrameId`.
5. **Live resync** — `ws-client.js`'s `resnapshot` callback (wired in
   `CanvasHost`) calls `resyncProject(project, prevBundle)`, which re-fetches
   only decisions + todos and re-runs `adaptProjectData` against the
   **original** `frameMap` retained on the bundle as `rawFrameMap` — frame
   positions are byte-identical across a resync, only entity data changes.
   `engine.setData(bundle, { preserveFocus: true })` keeps the current
   frame focus.
6. `entityStore.subscribe(changes)` (also wired in `CanvasHost`) forwards
   deltas to `engine.applyLiveChanges(changes)` for canvas-side live effects,
   and — for the "entity removed while its drawer is open" case — snapshots
   the removed record (`change.prev`) into `ui-store`'s `removedSnapshots` so
   the `Drawer` can keep rendering it instead of going blank.

`CanvasHost` is the only component that touches `entityStore`/`ws-client`
directly; everything else reads through `useUiStore` or the exported
`entityStore`/`engineRef` module singletons (`app/CanvasHost.tsx`).

### Extending the viewer

**Adding new frame visuals** — drawing happens in `canvas/engine.js`. Add a
helper near `drawFrames`; reference `frameBorderRGB()`/`frameFillRGB()`
for theme awareness. The engine stays plain JS by design — resist the urge
to convert it to TSX; if React needs to react to something new happening on
the canvas, add a callback to the `callbacks` object `createEngine` accepts
instead.

**Adding new chrome** (toolbar buttons, drawer views, palette actions) — this
is ordinary React work under `src/viewer/app/`: add a component, wire it
through `useUiStore`, and — if it needs to reach into the canvas — call a
method on `engineRef` (exported from `CanvasHost.tsx`) rather than reaching
for the DOM directly. Remember: any edit under `src/viewer/**` requires a
`npm run build:viewer` + committed `dist/` diff (see the committed-dist
contract below) before it will pass CI.

**WebSocket / live sync** — already wired via `ws-client.js` +
`entity-store.js`, both instantiated inside `CanvasHost`'s effect (see Data
flow above). See [viewer-sync-engine.md](viewer-sync-engine.md) for the
reconnect/backfill protocol; this doc only covers how the React shell owns
those pieces.

### The committed-dist contract

`src/viewer/dist` is **committed to git**; the server (`VIEWER_DIR` in
`src/mcp-server/api.ts`) serves it directly, with no build step at install
or runtime. This keeps `vite`/`react` as devDependencies only — plugin
users installing from git via `tsx` never run a viewer build.

- **Rule:** after **any** edit under `src/viewer/**`, run
  `npm run build:viewer` (`vite build src/viewer`) and commit the resulting
  `dist/` diff along with the source change.
- **CI enforces this** (`.github/workflows/ci.yml`, `ts-suite` job):
  1. *Viewer bundle freshness* — reruns `build:viewer`, then fails if
     `git diff --exit-code -- src/viewer/dist` finds a tracked-file diff, or
     if `git status --porcelain -- src/viewer/dist` finds any untracked file
     (a new hashed asset that wasn't committed).
  2. *Viewer typecheck* — `tsc -p src/viewer --noEmit`.
- **Merge conflicts in `dist/` are resolved by rebuilding** — never
  hand-merged. Resolve the conflict in `src/`, then re-run
  `npm run build:viewer`; the output filenames are content-hashed
  (`index-<hash>.js`), so a line-level merge of the built assets is
  meaningless anyway.
- **Never hand-edit files under `src/viewer/dist`.**
- **Dev workflows:**
  - `npm run dev` — the normal server (`tsx src/index.ts`); serves the
    committed `dist` bundle as-is (no HMR — this is testing the shipped
    build).
  - `npm run dev:viewer` — `vite dev src/viewer`; Vite's dev server proxies
    `/api` and `/ws` to `:3334` (see `src/viewer/vite.config.ts`) so the React
    app gets HMR against a live backend without rebuilding `dist`.

### Shared-contract invariants

A few values cross a language/tooling boundary and have to be kept in sync
by hand rather than by import:

- **`LS_KEYS`** (`app/ui-store.ts`) — the literal `localStorage` key strings
  (`cortex.viewer.layers`, `cortex.viewer.show.frames/decisions/todos`) must
  match the `SHOW_LS`/`LAYERS_LS_KEY` constants `canvas/engine.js` reads once
  at construction. React (`App.tsx`'s `layerPrefs` effect) owns writing them
  on every change; the engine only reads them at boot.
- **`MAX_FRAME_NODES`** — gone (2026-07): adaptation carries full member
  lists and the draw-time cap is the screen-area LOD dot budget
  (`canvas/lod.js`, `PX_PER_DOT`), so the old dual-constant coupling no
  longer exists. See `viewer-sync-engine.md` §"Camera, LOD, and embedding".
- **`LAYER_RGB`** — exported from `canvas/engine.js` as the single runtime
  source of truth for the per-layer palette; `LayersMenu.tsx` imports it
  directly for the legend swatches. `FileCard.tsx`'s `.dc-layer-chip.layer-*`
  rules in `style.css`, however, are a **hand-synced RGB copy** (CSS can't
  import a JS module) — if `LAYER_RGB` changes, `style.css` must be updated
  by hand to match.

### Drawer semantics

The drawer holds a **stack** (`DrawerView[]`, `ui-store.ts`'s
`drawerStack`), not a single view. `app/drawer/drawer-stack.ts` provides the
four operations: `openReplace` (replace the whole stack with one view),
`push` (append, deduped against the current top by `same()`), `pop`, and
`closeAll`.

- **Replace:** canvas selections (frame focus, record click, file click —
  wired through `createEngine`'s `callbacks` in `CanvasHost`) and palette
  selections always start a fresh single-entry stack — picking something new
  from the canvas or ⌘K abandons wherever you were in the drawer.
- **Push:** in-drawer navigation (`RefPill` clicks, `FileCard`'s
  co-change/connection links, `ListView` row clicks) uses `push`, so a
  pivot like A → B → A legitimately grows the stack — each hop is a real
  user click, bounded only by how many the user makes (no depth cap).
- **Esc** closes the whole drawer (`closeAll`) in one keystroke — `App.tsx`'s
  global `Esc` handler is guarded to close the palette first if it's open.
  The drawer's own back button (`‹`) pops one level at a time.
- **File records don't drive the canvas highlight** — `setActiveRecord` is
  only called for non-file drawer views (`App.tsx`'s `drawerStack` effect
  checks `top.type !== "file"`), so opening a file card never lights up a
  frame on the canvas.
- **Closed todos** (state `done`/`cancelled`): the canvas ambient layer
  excludes them (the engine only tracks `store.state.todos`, the live/open
  set), but the drawer/list/palette include them via `bundle.allTodos` —
  `ListView` mutes closed rows to the bottom of a newest-first sort
  (`selectors.ts`'s `listRows`), and `FileCard`/`RefPill` resolve through
  `allTodos` as a fallback when a todo isn't in the ambient set
  (`selectors.ts`'s `resolveTodo`).
- **Removed-while-open:** if a live change removes the entity currently open
  in the drawer, `CanvasHost`'s `entityStore.subscribe` snapshots `c.prev`
  into `ui-store`'s `removedSnapshots` keyed by id, so the drawer keeps
  rendering it instead of going blank. **Known gap (follow-up todo):** this
  only snapshots the top-of-stack entry — a removal of an entry *lower* in
  the stack still produces a blank pop-back when the user hits back.

### Palette

⌘K (or the toolbar's search button) opens `Palette.tsx`. A name-level search
index (`app/palette/search-index.ts`'s `buildSearchIndex`) is built
client-side from the current bundle + projects list — a `useMemo` keyed on
`[bundle, projects]`, so it rebuilds on load and on every project switch,
not incrementally.

- **Groups**, in fixed order: actions, frames, files, symbols, decisions,
  todos. Actions (`app/palette/actions.ts`'s `buildActions`) cover browsing
  records, switching project, the layer toggles, and the theme toggle.
- Fuzzy scoring (`app/palette/fuzzy.ts`) ranks and caps each group at 5
  (`searchIndex(entries, query, 5)`); an empty query shows a resting state
  of matched actions + the top 5 frames.
- **Explicitly out of scope:** no code-content grep (the index covers
  names/labels/paths only, never file contents) and no live index updates
  while the palette is open (a decision/todo change mid-session isn't
  reflected until the palette is reopened, since the index only rebuilds on
  `bundle`/`projects` identity change).

### Routes

- `/viewer` — frames viewer (default); serves
  `src/viewer/dist/index.html`.
- `/viewer/<asset>` — static asset serving from the **committed build
  output** `src/viewer/dist/` (`VIEWER_DIR` in `src/mcp-server/api.ts`), not
  from `src/viewer/` source — e.g. `/viewer/assets/index-<hash>.js`,
  `/viewer/assets/index-<hash>.css`. Traversal-safe (`safeStaticPath`). See
  the committed-dist contract above for how that bundle gets built.

### API

- `GET /api/graph?project=<name>` — `{ nodes, edges, project }`. Both
  `data.frame_id` (when present, from `inject-frames.ts`) and the raw
  graph fields are exposed; the viewer's adapters do the bucketing.
- `GET /api/projects` — `{ projects, active }`. Drives the toolbar
  project switcher.
- `GET /api/decisions?project=<name>` — `{ decisions: AdaptedDecision[] }`.
  `AdaptedDecision` resolves each decision's GOVERNS/REFERENCES/PR links
  into shapes the viewer can render directly (frame ids, file paths, PR
  numbers).
- `GET /api/decisions/:id` — `AdaptedDecision` for a single decision.
- `GET /api/aggregates?project=<name>` — `{ aggregates: [...] }`.
  Auxiliary-path groups computed by
  `groupAuxiliaryPaths(src/frame-extraction/auxiliary-detection.ts)` — one
  entry per auxiliary segment (e.g. `locales`, `vendored`,
  `__snapshots__`) with the list of contained file ids.

### HTTP API contract (v1)

As of contract v1 the `/api/*` surface above is a **versioned, Zod-enforced,
hardened contract**, not a set of hand-built `JSON.stringify` responses. One Zod
schema per response in `src/mcp-server/api-schemas.ts` is the single source of
truth: it validates at runtime, derives the TS types via `z.infer`, and
*generates* the JSON Schema docs under `docs/api/`. Every response goes through
the `respond()` chokepoint, which stamps `version` + freshness + `ETag`, honors
`If-None-Match` → `304`, and validates the payload; a middleware chain
(loopback-default bind, method gate, opt-in bearer auth, CORS allowlist,
traversal guard, security headers) hardens the surface, all inert by default for
local single-user use. See
[http-api-contract.md](http-api-contract.md) for the full model and the
"add an endpoint" maintenance workflow, and
[docs/api/README.md](../api/README.md) for the consumer reference.

# Viewer — Read-Path Sync Engine

> Living document. Audience: anyone touching the viewer's live-sync layer —
> [`src/viewer/store.js`](../../src/viewer/store.js),
> [`src/viewer/ws-client.js`](../../src/viewer/ws-client.js),
> [`src/viewer/live-effects.js`](../../src/viewer/live-effects.js),
> [`src/mcp-server/projection-deriver.ts`](../../src/mcp-server/projection-deriver.ts),
> the WS server ([`src/ws/server.ts`](../../src/ws/server.ts)), or the composition
> root ([`src/index.ts`](../../src/index.ts)).
> For the write-side pipeline — EventBus, worker thread, `events.db` —
> see [graph-ui.md](graph-ui.md). For the graph DB storage model, see
> [graph-storage.md](graph-storage.md).

## Problem and scope

The frames viewer was originally **static-load**: a full `/api/*` fetch on page
load, no connection to the event stream, and a manual reload to see any change.
This engine makes it **reactive** — decisions, TODOs, and future entity types
stream in as projection deltas over WebSocket and the canvas adapts
incrementally, without a reload.

Three load-bearing design principles, each chosen to support a future 40-person
shared-server case without a viewer rewrite:

1. **One ordered log, many readers → convergence by construction.** Every
   client replays the same ULID sequence from `events.db`. Because the viewer is
   **read-only**, there is no write conflict and no merge logic. N readers
   replaying the same ordered log converge to the same state automatically.

2. **One adapter, two transports.** The same `buildAdaptedDecision` and
   `buildAdaptedTodo` functions (in
   [`src/mcp-server/api-decisions.ts`](../../src/mcp-server/api-decisions.ts)
   and [`src/mcp-server/api-todos.ts`](../../src/mcp-server/api-todos.ts)) feed
   both the snapshot endpoints (`/api/decisions`, `/api/todos`) **and** the live
   delta packets. The server is the single source of truth for entity shape; the
   client never re-derives. This makes streaming correct-by-construction rather
   than drift-prone.

3. **Each delta carries the source event's ULID as its sync cursor.** That ULID
   is monotonic, sortable, and already the primary key of `events.db`. A
   bootstrap-snapshot-then-catch-up protocol falls directly out of the
   append-only log already present.

**Out of scope for this iteration:** central/hosted server, auth, multi-tenant,
external broker (NATS/Redis), client writes, optimistic mutations, and IndexedDB
persistence. These compose on top of the ordered log later (swap `events.db` for
a broker; add `subscribe { project_id }`; serialize the store to IndexedDB)
without a viewer rewrite. The store object is the designed seam for persistence.

## Architecture spine

```
 WRITE SIDE (unchanged)                      READ SIDE (this engine)
 ─────────────────────────────               ──────────────────────────────────
 MCP tool call / git event
   │
   ▼
 EventBus.emit(event)  [src/events/bus.ts]
   │  (main thread, in-process)
   ▼  postMessage({type:'event', event})
 Worker thread  [src/events/worker.ts]
   │
   ├─► EventPersister.insert(event)          ← append to events.db (ULID primary key)
   │                                              │
   └─► deriveMutations(event, lookup)             │  persister.since() / persister.head()
         │                                        │  (main thread reader, WAL concurrency)
         ▼                                        │
   postMessage({type:'broadcast', bundle})        │
         │                                        │
 ◄───────┘  (worker → main)                       │
 src/index.ts: onSpawn handler                    │
   │                                              │
   ├─► wsHandle.broadcast(bundle)                 │
   │     └─► graph event + mutation fan-out       │
   │                                              │
   └─► deriveProjectionDeltas(events, sources)  ◄─┘
         │   [src/mcp-server/projection-deriver.ts]
         │   reads sidecar DBs at derive time; reuses buildAdaptedDecision/buildAdaptedTodo
         │
         ▼
   wsHandle.broadcastProjections(deltas)
         │   [{type:'projection', delta}] × N per connected client
         ▼
   browser viewer
     ws-client.js → store.apply(delta) → rAF flush → applyLiveChanges → canvas
```

The engine inserts a single new stage — the **projection deriver** — between the
existing worker broadcast and the existing WS fan-out. The write side is
unchanged.

## The projection deriver

**Location:** [`src/mcp-server/projection-deriver.ts`](../../src/mcp-server/projection-deriver.ts)

**Thread:** main (the sidecar databases and adapters live on the main thread).

`deriveProjectionDeltas(events, src)` maps a batch of events to
`ProjectionDelta[]`. For each event kind it knows about, it:

1. Reads the entity's **current** state from the sidecar DB at derive time —
   not from the event payload. This is the key property that makes catch-up
   replay **state-converging**: replaying an old event range against today's DB
   yields today's entity shapes, and duplicate or overlapping application at the
   client is safe (the store upserts by id, so idempotency is automatic).

2. Feeds that record through `buildAdaptedDecision` or `buildAdaptedTodo` — the
   exact same adapters the HTTP snapshot endpoints use — producing a full adapted
   shape with resolved governance, frame ids, and link references already
   embedded. The client never needs to re-derive.

3. Packages the result as a `ProjectionDelta` whose `ulid` is the source event's
   ULID (the sync cursor advances to this value at the client).

```ts
// src/events/types.ts
export type ProjectionDelta =
  | { ulid: string; entity: ProjectionEntity; op: 'upsert'; data: Record<string, unknown> }
  | { ulid: string; entity: ProjectionEntity; op: 'remove'; data: { id: string } };

export type ProjectionEntity = 'decision' | 'todo';
```

`upsert` (not `add`/`update`) is deliberate: the store is keyed by id, making
upsert application idempotent and safe under reconnect overlap. `remove` carries
only `{ id }`.

The deriver handles these event kinds:

| Event kind | Action |
|---|---|
| `decision.created`, `decision.updated`, `decision.promoted`, `decision.proposed`, `decision.ratified` | `upsert` the decision |
| `decision.superseded` | `upsert` both `old_id` and `new_id` (their status fields change) |
| `decision.deleted` | `remove` by `decision_id` |
| `todo.proposed`, `todo.updated`, `todo.transitioned`, `todo.linked` | `upsert` the todo |
| `commit`, `pr.*` | no projection delta (stay on the event + graph-mutation channels) |

If the entity is absent from the DB at derive time (deleted before deriving), the
deriver emits nothing for `upsert` cases — a later `remove` event in the log
covers the deletion.

`pathIndices()` is lazy and memoized per batch (one call per batch of events,
regardless of how many decisions that batch touches), keeping graph-store reads
cheap even on noisy event bursts.

### ProjectionSources injection

The deriver depends on a `ProjectionSources` interface, injected by the
composition root:

```ts
export interface ProjectionSources {
  decisions: { get(id: string): DecisionRecord | null };
  decisionLinks: { findByDecision(id: string): DecisionLink[] };
  todos: { get(id: string): TodoRecord | null };
  todoLinks: { findByTodo(id: string): TodoLink[]; findBlocking(id: string): TodoLink[] };
  pathIndices(): { nodesByPath: Map<string, NodeRow>; framesByPath: Map<string, FrameInfo> };
}
```

`src/index.ts` wires these from the live `DecisionsRepository`,
`DecisionLinksRepository`, `TodosRepository`, and `TodoLinksRepository` instances.
`pathIndices()` re-reads the graph store per batch so a reindex mid-session is
picked up for free. Source freshness beats caching here because events are
low-rate (tool calls, commits).

## The WebSocket protocol layer

**Location:** [`src/ws/server.ts`](../../src/ws/server.ts),
[`src/events/types.ts`](../../src/events/types.ts)

The projection channel is a **separate `ServerMsg` variant** from the existing
graph `mutation` channel:

```ts
// src/events/types.ts
export type ServerMsg =
  | { type: 'hello'; project_id: string; server_version: string; head_ulid: string | null }
  | { type: 'event'; event: Event }
  | { type: 'mutation'; mutation: GraphMutation }
  | { type: 'projection'; delta: ProjectionDelta }            // ← NEW
  | { type: 'backfill_page'; events: Event[]; mutations: GraphMutation[]; has_more: boolean }
  | { type: 'catchup_result'; mode: 'replay' | 'snapshot'; deltas: ProjectionDelta[]; head_ulid: string | null } // ← NEW
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };

export type ClientMsg =
  | { type: 'backfill'; before_id?: string; limit?: number }
  | { type: 'catchup'; since: string }                       // ← NEW
  | { type: 'ping' };
```

`{ type: 'projection' }` carries one delta. `{ type: 'catchup_result' }` is the
catch-up response (see below). These additions are strictly additive — existing
`event` / `mutation` / `backfill_page` consumers are untouched and continue
operating on their own channels.

**Why a separate channel from graph mutations?** The graph-mutation channel
describes structural `cortex.db` nodes (`add_node`/`add_edge`). The projection
channel describes the viewer's *rendered* entities — a decision pill with
resolved governance, a TODO dot with its current state. Different lifecycles,
different consumers. Keeping them separate avoids coupling the projection store
to graph mutation handling and leaves the existing graph stream untouched.

### `head_ulid` in `hello`

On every new connection the server sends:

```json
{ "type": "hello", "project_id": "…", "server_version": "…", "head_ulid": "01J…" }
```

`head_ulid` is the newest event ULID in `events.db` at connection time, read by
`EventPersister.head()`. It anchors the client's sync cursor after a fresh
snapshot bootstrap.

## The ULID cursor and catch-up protocol

Bootstrap and reconnect share one protocol:

```
connect
  → server sends hello { project_id, head_ulid }

  Case A — no cursor (cold start):
    client calls resnapshot(head_ulid)
      → GET /api/decisions + GET /api/todos (parallel)
      → store.hydrate({ decisions, todos, cursor: head_ulid })
    deltas arriving during the snapshot are buffered in ws-client and replayed
    after hydrate (animate: false)
    status → "live"

  Case B — have cursor C (reconnect):
    client sends { type: 'catchup', since: C }
    server: calls persister.since({ since_id: C, limit: CATCHUP_REPLAY_LIMIT })

      Sub-case B1 — (head − C) ≤ 500 events (replay path):
        server replies { type: 'catchup_result', mode: 'replay', deltas: [...], head_ulid }
        client applies deltas one by one (animate: false), then setCursor(head_ulid)
        status → "live"

      Sub-case B2 — (head − C) > 500 events (snapshot path):
        server replies { type: 'catchup_result', mode: 'snapshot', deltas: [], head_ulid }
        client calls resnapshot(head_ulid) as in Case A
        status → "live"

live phase:
  { type: 'projection', delta } → store.apply(delta, { animate: animateNow() })
  cursor advances to delta.ulid on each apply
```

The 500-delta threshold (`CATCHUP_REPLAY_LIMIT` in `src/ws/server.ts`) is a
plain constant, tunable later. It exists so a client that was offline for a long
time re-snapshots rather than replaying tens of thousands of deltas. On localhost
either path is fast; the threshold matters at team scale.

`persister.since()` uses the same +1-row probe as `persister.backfill()`:
fetching `limit + 1` rows and checking whether `has_more` is true, then
answering `mode: 'snapshot'` when `has_more` is set or when `deriveProjections`
is not available (safe degraded mode).

The server remains **stateless per connection**. The client drives all
bootstrap/catch-up decisions. This mirrors the design rationale for the existing
`backfill` protocol.

### State-converging replay

Because the deriver reads the entity's **current** DB state at derive time (not
the state at event emission time), catch-up replay is **state-converging**:
replaying events `[C…head]` against today's DB always produces today's entity
shapes. Duplicate or overlapping application — normal on reconnect — is safe
because the client store upserts by id. A client that replays the same ULID
range twice ends up with the same state as a client that played it once. This
also means a catch-up delta is not a historical snapshot of what the entity
looked like at event time; it is always the latest adapted shape. Consumers
should treat it accordingly.

## Client reactive store

**Location:** [`src/viewer/store.js`](../../src/viewer/store.js)

The store replaces the old `DECISIONS`/`TODOS` globals that were rebuilt from
scratch via `buildGraph()` on every load. It owns the canonical client state;
the globals become **aliases with stable object identity**:

```js
const store = createStore();
const DECISIONS = store.state.decisions; // same Map object, forever
const TODOS     = store.state.todos;
```

Canvas draw code references these globals and sees mutations without any
notification; the subscriber callback handles the parts that need it (governance
rebuild, live-effects trigger).

### Internal structure

```js
state = {
  decisions: {},   // id → AdaptedDecision (mutated in place)
  todos:     {},   // id → AdaptedTodo
  cursor:    null, // last applied delta ULID
}
pending = new Map(); // key `${entity}:${id}` → change entry (coalesced per rAF)
```

### Hydration (in-place)

`store.hydrate({ decisions, todos, cursor })` clears existing keys and re-populates
the maps **in place** using `delete` + `Object.assign`. The Map objects themselves
are never replaced, so all alias references (global `DECISIONS`, `TODOS`) stay
valid without rebinding. This is the "non-big-bang migration" property: the store
becomes the owner while the canvas draw code changes minimally.

Any deltas that arrived between `apply()` calls before `hydrate()` is called are
buffered in a `queued` list and replayed (with their original `animate` flag)
immediately after hydration.

### Delta application

```js
store.apply(delta, { animate = true } = {})
```

1. If not yet hydrated, push to `queued` for post-hydrate replay.
2. Drop if `delta.ulid <= state.cursor` (reconnect overlap, safe deduplication).
3. For `upsert`: write `map[delta.data.id] = delta.data`; save `prev`.
4. For `remove`: delete `map[delta.data.id]`; save `prev` (undefined if never present).
5. Record a change entry in `pending`; call `requestFlush()`.
6. Advance `state.cursor = delta.ulid`.

### Coalesced rendering (the actual "smooth")

N `apply()` calls in one event-loop tick → **one** `requestAnimationFrame` flush.

```
200 deltas in 50 ms → one rAF → one subscriber call over 200 change entries
```

The rAF scheduler is injectable via `createStore({ schedule })` for tests (replace
with a synchronous callback). In production `schedule` defaults to
`requestAnimationFrame`.

Burst coalescing contract for `pending`: if the same entity is upserted then
removed within one flush window, the change entry's `prev` is the entity's state
**before the burst** (the first `prev` is kept), and `op` reflects the final
operation (`remove`). A consumer seeing `prev === undefined` on a `remove` knows
the entity was never rendered — it appeared and vanished atomically, so
animation/teardown can be skipped.

### Ghost-lifecycle contract

`remove` entries with `prev === undefined` indicate an entity that arrived and
was deleted within a single flush window. The live-effects layer skips them
(no tombstone, no presence pill for something never rendered). This contract is
documented in the store source and relied on by `applyLiveChanges` in `viewer.js`.

### Silent catch-up flag

`store.apply(delta, { animate: false })` applies the delta to the state and
records a change entry but marks it `animate: false`. The subscriber still fires,
but the live-effects gate in `applyLiveChanges` skips treatment triggering for
non-animated changes. This prevents a burst of stale animations after a laptop
wake or reconnect.

The same `animate: false` path runs for deltas that arrive while the browser tab
is hidden (`document.visibilityState !== 'visible'`). On tab restore all pending
state is already current; no animation backlog plays.

## WS client (reconnect + bootstrap)

**Location:** [`src/viewer/ws-client.js`](../../src/viewer/ws-client.js)

`connectLiveSync({ wsUrl, store, isLiveProject, resnapshot, onStatus })` wraps
a reconnecting WebSocket with exponential backoff matching the worker supervisor:
1 s → 2 s → 4 s → 8 s → 16 s → 30 s (capped).

The `isLiveProject()` predicate guards projection deltas: the server is bound to
one project, but the viewer's project switcher can show a different one. Deltas
for a non-live project are dropped **without advancing the cursor**, so the
cursor stays at the correct position for when the viewer switches back.

### Resnapshot buffering

When `resnapshot()` is in flight (the async `GET /api/decisions` + `/api/todos`
calls), live `projection` messages may arrive over the WebSocket. The client
buffers them in a local array and flushes them (`animate: false`) after
`store.hydrate()` completes. Because deltas carry full adapted entity state and
upserts are idempotent, this flush converges correctly whether or not the snapshot
already reflected the write:

- If the snapshot included the entity: the buffered upsert is a no-op by cursor
  deduplication (cursor was set to `head_ulid` by hydrate).
- If the snapshot was slightly stale: the buffered upsert refreshes to the correct
  shape.
- If the delta arrived before the entity existed in the snapshot: the upsert
  writes the entity correctly; the snapshot did not need to know about it.

### Connection status indicator

The WS client calls `onStatus('live' | 'syncing' | 'offline')` at key lifecycle
points. The viewer wires this to a `#sync-indicator` element — a small toolbar
dot and text label, hidden when the current project is not the server-bound live
project. No banners, no modals; disconnection locally is almost always the dev
server restarting and heals in seconds.

## Todo event emission

**Location:** [`src/todos/service.ts`](../../src/todos/service.ts)

`TodoService` depends on an optional `EventBus` and emits one event from each
write method:

| Service method | Event kind | Payload |
|---|---|---|
| `propose()` | `todo.proposed` | `{ todo_id, summary }` |
| `update()` | `todo.updated` | `{ todo_id, changed_fields }` |
| `transition()` | `todo.transitioned` | `{ todo_id, from, to }` |
| `link()` | `todo.linked` | `{ todo_id, target, relation }` |

These mirror the decision event pattern. When no `EventBus` is injected (e.g.,
in tests), `this.bus?.emit(event)` is a no-op. The projection deriver handles all
four kinds, so any todo write immediately generates a delta that flows to all
connected viewers.

## Composition wiring

**Location:** [`src/index.ts`](../../src/index.ts)

The composition root wires the engine after the viewer HTTP server starts but
before `server.connect(transport)`:

```
mainPersister (EventPersister, main thread, read-only)
projectionSources = { decisionsRepo, decisionLinksRepo, todosRepo, todoLinksRepo, pathIndices() }

supervisor.onSpawn:
  worker.on('message', msg => {
    wsHandle.broadcast(msg.bundle)               // graph event + mutation fan-out
    if (projectionSources) {
      deltas = deriveProjectionDeltas(msg.bundle.events, projectionSources)
      if (deltas.length) wsHandle.broadcastProjections(deltas)
    }
  })

wsHandle = startWsServer({
  httpServer, persister: mainPersister, projectId, serverVersion,
  deriveProjections: events => deriveProjectionDeltas(events, projectionSources),
})
```

`projectionSources` is set before the worker spawns, so no race exists between
worker init and the first broadcast handler. `deriveProjections` is also injected
into `startWsServer` so the WS catch-up handler can derive deltas for replay
without going through the worker message path.

## Live-effects grammar (E · v5 live)

**Location:** [`src/viewer/live-effects.js`](../../src/viewer/live-effects.js)

The change-treatment layer is a **pure state machine**: no canvas access,
injectable time. The canvas queries it on every `mainLoop` frame and reads the
current transient state from its getter functions.

The grammar is the locked treatment from the design review (option E). It
re-adopts the live-activity grammar from the original
[`cortex-frames-prototype-v5.html`](../specs/archive/cortex-v0.3/cortex-frames-prototype-v5.html)
— the layer dropped when the viewer moved to real data — now driven by real
projection deltas. **No pulse animations** (explicit constraint): every signal
is a state that decays, never an oscillation.

### Timing constants

| Constant | Value | Signal |
|---|---|---|
| `BIRTH_MS` | 500 ms | Outline → fill transition for new entities (v5 "added-node → merge-beat") |
| `HALO_MS` | 3500 ms | Halo lift drains linearly for updated entities (v5 `colorAmount` decay) |
| `LEADER_MS` | 580 ms | Leader-line intensity peak duration (v5 edge-intensity pattern, triangular) |
| `REMOVE_MS` | 500 ms | Fill drains back to outline and fades for removed entities |
| `HEAT_DECAY_MS` | 5500 ms | Frame border heat decays linearly (v5 `frameHeat` decay) |
| `HEAT_BUMP` | 0.5 | Heat added per change event to containing frame (capped at 1) |

These constants are locked in `src/viewer/live-effects.js` and match the v5
prototype exactly. Do not tune them without a Gate-0 visual QA pass; they are
perceptually calibrated against the canvas's continuous sine-ring animation.

### Treatment table

| Change kind | Visual treatment |
|---|---|
| **create** | Entity dot born as an **outline** ("sketch"), then **fills** over `BIRTH_MS` — the v5 added-node → merge-beat grammar. Leader lines fire once. |
| **update** | Leader lines fire once, peaking at alpha 0.7 over `LEADER_MS` (triangular envelope). Dot halo lifts and drains linearly back to baseline over `HALO_MS`. No scale change, no ring, no hue shift. |
| **remove** | Fill drains to outline then fades over `REMOVE_MS` (tombstone). No red color. |
| **residue** | Containing frame's border warms by `HEAT_BUMP` (capped at 1) and decays over `HEAT_DECAY_MS`. Repeated activity saturates rather than restarts the heat. At team scale, the canvas reads as warmth where work is happening. |
| **attribution** | **Always on.** Presence pill centered 11 px right of the dot: agent-colored fill for `actor === 'claude'` or `'system'` (with provider glyph), base-white fill for the user (`@name`). **One pill per actor** — a same-author burst shows a single pill that jumps to the latest changed dot (and refreshes its fade window), not a pill per change. Pill alpha fades over `HALO_MS`. Under `prefers-reduced-motion`, pills remain (information, not decoration) at a fixed 2 s window; all motion collapses to instant state changes. |

**Why this grammar, not A–D?** Options A (pulse + glow), B (recency tint), C
(ripple), and D (shimmer) were rejected after user review: they use treatment
alphas (0.6–0.7) louder than the viewer's loudest continuous element (0.45-alpha
sine ring), they break color semantics (hue is identity/state, never event; amber
= stale, red = blocked), and they introduce foreign materials (specular sweeps,
badge chips). The v5 grammar whispers: halos drain, heat warms, outlines fill.

### `noteChange` gateway

The live-effects layer is triggered by `onLiveChangesApplied` in `viewer.js`,
which runs after the store subscriber fires for animated changes:

```js
liveFx.noteChange({ kind, entity, id, frameIds, actor, now })
```

`kind` is one of `'create'` / `'update'` / `'remove'`, derived from the change
entry: `remove` when `c.op === 'remove'`, `create` when `c.prev === undefined`,
`update` otherwise. `frameIds` are the frame ids the entity governs (resolved the
same way as the bulk load path). Layer toggles (`showDecisions`, `showTodos`) gate
whether a change triggers effects.

The canvas reads the state machine each frame:

| Getter | Canvas use |
|---|---|
| `birth(id, now)` | Progress 0→1 for outline-fill animation |
| `haloLift(id, now)` | Residual alpha for halo overlay |
| `leaderBoost(id, now)` | Edge intensity multiplier (triangular peak) |
| `frameHeat(frameId, now)` | Extra border alpha for frame warmth |
| `tombstones(now)` | Active remove animations (fill-drain + fade) |
| `pills(now)` | Active presence pills with position + alpha |

`recordDotPos(id, x, y)` is called from the canvas draw loop each frame so pills
adopt the correct screen position even for newly created entities (lazy adoption
for fresh births where the dot position isn't known when `noteChange` fires).

## Component boundaries

### Projection deriver (`src/mcp-server/projection-deriver.ts`)

**Owns:** The mapping from `Event[]` → `ProjectionDelta[]`. Reads sidecar DBs at
derive time.

**Talks to:** `DecisionsRepository`, `DecisionLinksRepository`, `TodosRepository`,
`TodoLinksRepository`, `buildAdaptedDecision`, `buildAdaptedTodo`.

**Does NOT talk to:** The worker thread, WebSocket, or `events.db`. It is a pure
function from events + sources → deltas.

---

### WS server catch-up handler (`src/ws/server.ts`)

**Owns:** The `catchup` client message handler. Reads `events.db` via the
main-thread `EventPersister` instance; calls the injected `deriveProjections`
closure; replies with `catchup_result`.

**Does NOT talk to:** The worker thread or `cortex.db`.

---

### Client store (`src/viewer/store.js`)

**Owns:** The canonical client-side entity maps (`decisions`, `todos`) and the
sync cursor. Coalesced rAF flushing. Hydration in place (alias stability). The
`queued` pre-hydrate buffer.

**Does NOT talk to:** The network, the canvas, or the live-effects layer. Pure
state machine.

---

### WS client (`src/viewer/ws-client.js`)

**Owns:** The WebSocket lifecycle (connect, reconnect with backoff), the
bootstrap/catch-up protocol, the resnapshot buffer for in-flight snapshots, the
`isLiveProject` guard, and `onStatus` notifications.

**Does NOT talk to:** The canvas or live-effects layer directly. Feeds the store
only.

---

### Live effects (`src/viewer/live-effects.js`)

**Owns:** Transient change-treatment state (births, halos, leaders, heat,
tombstones, pills). Pure state machine — no canvas access, injectable time.

**Does NOT talk to:** The store, the network, or `viewer.js` directly. Read by
the canvas draw loop on each `mainLoop` frame.

---

### `viewer.js` (integration)

**Owns:** `applyLiveChanges` (store subscriber → governance rebuild → live-effects
trigger), `resyncEntities` (snapshot bootstrap/fallback), `showSyncStatus`
(toolbar indicator), `onLiveChangesApplied` (animate guard + `noteChange` gateway).

**Talks to:** all of the above, plus the canvas context and data-fetch module.

## Extending the system

### Adding a new projected entity (e.g., `pr`)

1. **Event kind** — ensure `pr.opened` / `pr.merged` / `pr.touched` are declared
   in the `Event` union in [`src/events/types.ts`](../../src/events/types.ts)
   (they already are).

2. **`ProjectionEntity` widening** — add `'pr'` to the `ProjectionEntity` union
   in `src/events/types.ts`.

3. **Deriver case** — add cases for `pr.opened`, `pr.merged`, etc. in
   `deriveProjectionDeltas()` in `src/mcp-server/projection-deriver.ts`. Build
   the adapted shape (or create a `buildAdaptedPR` adapter following the decision
   and todo patterns); emit `{ ulid, entity: 'pr', op: 'upsert', data }`.

4. **Store bucket** — add `prs: {}` to the `state` object in `store.js`. Add a
   `'pr'` case in the `bucket()` function. The coalesced flush and cursor logic
   need no changes.

5. **Treatment trigger** — in `viewer.js`'s `onLiveChangesApplied`, add a
   `c.entity === 'pr'` branch and call `liveFx.noteChange(...)` with the
   appropriate `frameIds` (PRs are governed by the frames they touch via
   `pr.touched` events).

6. **Canvas rendering** — draw PR dots in `viewer.js` using the same
   `liveFx.birth()` / `liveFx.haloLift()` / `liveFx.leaderBoost()` queries as
   decisions and todos.

Nothing else changes — the delta flows through the protocol automatically, the
store coalesces it, and the rAF flush delivers it.

### Adding a new event kind that affects existing entities

Follow the "Adding a new event kind" recipe in [graph-ui.md](graph-ui.md)
(for the graph-mutation pipeline), and also add a deriver case in
`deriveProjectionDeltas()` if the event warrants a projection update.

### Plugging in IndexedDB persistence

The store object is the designed seam. On cold start:

1. Deserialize `{ decisions, todos, cursor }` from IndexedDB into `store.hydrate()`.
2. The WS client detects `store.state.cursor !== null` and runs the `catchup`
   path instead of a full resnapshot.

The store's `apply()` method can call an IndexedDB `put()` after each delta to
keep the persisted state current. No other layer needs to change.

## Design rationale

### Why the deriver runs on the main thread, not the worker

The sidecar databases (`decisions.db`, `todos.db` columns of `decisions.db`) and
the adapter functions (`buildAdaptedDecision`, `buildAdaptedTodo`) live on the
main thread. Moving them to the worker would require either serializing two DB
file handles across the thread boundary (not safe with `better-sqlite3`) or
duplicating the entire adapter + DB stack in the worker. Running on the main
thread keeps the implementation straightforward, and the deriver is cheap: it
does a handful of SQLite point lookups per event, not a full graph scan.

### Why the deriver reads current DB state, not event payload state

The projection channel is a **read-path sync engine**, not a write-ahead log
replay. Its purpose is to keep the viewer's rendered entities consistent with the
server's authoritative state. Reading current DB state at derive time means:

- Catch-up replay is always state-converging (idempotent, safe to overlap).
- A burst of closely-spaced updates to the same entity produces a single
  "current" shape at derive time rather than N intermediate shapes.
- The client never needs to reduce event payloads — it just upserts the final
  shape.

The tradeoff is that replaying a historical range does not reconstruct
*historical* entity shapes. This is intentional: the viewer is a live canvas, not
a time-travel interface. The temporal slider deferred to future work uses
`events.db` directly and can reconstruct historical shapes from the append-only
log at query time.

### Why upsert, not add/update

`add` vs `update` semantics require the client to track whether it has seen the
entity before. `upsert` makes the store application stateless with respect to
prior history: write the data, advance the cursor. This is the correct choice for
a protocol where reconnect overlap and catch-up replay are expected and frequent.

### Why 500 deltas as the snapshot threshold

The threshold exists to bound catch-up latency at team scale. 500 events
corresponds to roughly 50–100 decision or todo writes (a single event may expand
to 1–3 deltas), which covers weeks of activity on an active team project. Below
500, replaying deltas over a reconnect is cheaper than a snapshot refetch (avoids
a round-trip serialize + deserialize of the entire entity set). Above 500, a
snapshot is both faster and simpler. On localhost either path completes in
milliseconds; the threshold is a guard for future server deployments.

## Deferred work

| Item | Notes |
|---|---|
| **IndexedDB persistence** | The store is the seam — see extension recipe above. Win is eliminating the cold-reload flash once entity counts grow. |
| **`pr` / `frame` / `commit` entity types** | Protocol is additive; `ProjectionEntity` widens to include them. The `pr.*` events already exist in the log. |
| **Broker substitution** | Replace `EventPersister.insert()` in the worker with a publish call to an external broker (NATS/Redis); subscribe in a consumer that writes to `events.db`. The projection deriver, WS server, and client are untouched. |
| **Multi-tenant** | Add `{ type: 'subscribe', project_id }` to `ClientMsg`; server filters deltas by project. No schema migration needed (`project_id` is already on every event envelope). |
| **Agent cursors** | v5 prototype designed presence trails traversing edges between changes; requires live presence data not currently streamed. |
| **Per-file touch tinting** | Per-file actor-hue tint on graph mutation nodes; can ride the graph-mutation channel when per-file change deltas are available. |

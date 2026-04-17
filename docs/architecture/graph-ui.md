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

1. Claude invokes MCP tool `create_decision` (stdio).
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

MCP latency must stay sub-10ms. Event persistence + mutation derivation + WebSocket fan-out add non-trivial work after each `DecisionService` write. On a single thread, a 10-client broadcast with slow sockets would stall the next MCP call. The worker boundary isolates all of that. The extension surface (gap detection, Louvain, CBM re-index) slots in without any future refactor.

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
3. Handle it in the viewer's mutation applier (Plan C, `src/viewer/shared/websocket.js`).

The wire protocol (`ServerMsg`) already carries `GraphMutation` as-is; no protocol change needed.

### Adding a new stream event renderer (Plan C — browser side)

Stream rendering lives in the viewer (`src/viewer/`). The backend emits events unchanged. Add a renderer branch in the activity-stream component keyed on `event.kind`. The stream receives raw `Event` objects — no backend change needed for new display-only formatting.

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

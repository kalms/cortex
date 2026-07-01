# Reactive Viewer — Read-Path Sync Engine (design)

> Status: **draft, brainstorm cut short** (laptop retirement — preserved for continuation).
> Date: 2026-07-01. Owner: rka.
> Companion prototype: [`assets/2026-07-01-viewer-change-treatments.html`](assets/2026-07-01-viewer-change-treatments.html)
> (open in a browser — the four change treatments animate on a faithful recreation of the viewer surface).

## Goal

Today the frames viewer is **static-load**: it fetches all data once on page load / project
switch, and you must **reload** to see any decision, TODO, PR, or graph change. Make the viewer
**reactive** — decision/TODO/PR/commit/graph changes stream in and the canvas adapts **gracefully**
(smooth, granular, animated), without a reload.

The user framed smoothness as **make-or-break**, and asked us to design so it doesn't paint into a
corner when the change stream later comes from a **team of ~40 people**.

## Framing decisions (settled during brainstorm)

1. **The viewer is a pure read-only projection** ("Mesh substrate"). It will *only ever* project
   reality; writes arrive via Mesh / the embedding IDE, never the viewer. Consequence: there is one
   server-authoritative, ordered writer, and the viewer only reads.

2. **Build scope = the local viewer.** Make every protocol/store choice multi-client-correct so the
   40-person shared-server case drops in later **without a viewer rewrite**, but build/verify against
   the existing **local single-server**. Explicitly **out of scope**: central/hosted server, auth,
   multi-tenant, external broker (NATS/Redis), and any client write/optimistic/conflict machinery.

3. **A read-path sync engine, not the full Linear engine.** More contributors do **not** make the
   viewer a writer, so conflict resolution / OT / CRDTs never enter. The single-writer ordered log
   means N readers **converge by construction** by replaying the same ULID sequence. What transfers
   from sync-engine designs: a normalized reactive store, ordered delta packets over a monotonic
   cursor, coalesced rendering, snapshot-vs-replay catch-up, and (optionally) local persistence.

## Architecture spine

```
 WRITE SIDE (exists, unchanged)               READ SIDE (this effort)
 ───────────────────────────────             ──────────────────────────
 MCP tool / git                                browser viewer
   │ writes sidecar DB / cortex.db               ▲  WS /ws (delta packets)
   ▼                                             │
 EventBus.emit(event) ── ULID-ordered ──┐        │
                                        ▼        │
                              worker: events.db (append-only ULID log)
                                        │        ▲
                            ┌───────────┴────────┴──────────┐
                            │  Projection deriver (NEW)      │
                            │  event → adapted entity delta  │
                            │  reuses buildAdaptedDecision / │
                            │  buildAdaptedTodo (one adapter)│
                            └───────────┬────────────────────┘
                                        ▼
                            ClientRegistry.broadcast(delta)  ── computed once, fanned to all
```

Three load-bearing principles, each chosen for the 40-person future though we build local:

1. **One ordered log, many readers → convergence by construction.** Every client replays the same
   ULID sequence. No merge logic, because the viewer is read-only.
2. **One adapter, two transports.** The *same* `buildAdaptedDecision` / `buildAdaptedTodo`
   (`src/mcp-server/api-decisions.ts`, `src/mcp-server/api-todos.ts`) feed **both** the snapshot
   endpoints (`/api/decisions`, `/api/todos`) **and** the live delta packets. The server is the
   single source of truth for *shape*; the client never re-derives. This makes streaming
   correct-by-construction instead of drift-prone.
3. **Each delta is keyed by its source event's ULID.** That ULID *is* the sync cursor —
   bootstrap-snapshot-then-catch-up falls out of the append-only log we already have.

## Delta protocol & catch-up

New `ServerMsg` variant (additive; existing `event` / `mutation` consumers untouched):

```ts
| { type: 'projection';
    ulid: string;                              // sync cursor = source event's ULID
    entity: 'decision'|'todo'|'pr'|'frame'|'commit';
    op: 'upsert'|'remove';
    data: AdaptedDecision|AdaptedTodo|...;      // upsert → full adapted shape; remove → { id }
  }
```

- **Separate channel from the existing graph `mutation`.** The graph-mutation channel describes
  structural `cortex.db` nodes (`add_node`/`add_edge`); the projection channel describes the viewer's
  *rendered* entities (a decision pill with resolved governance, a TODO dot with state). Different
  lifecycles, different consumers. Keeping them distinct leaves the existing graph stream untouched
  and gives the projection store one clean input type.
- **`upsert` (not add/update)** because the store is keyed by id → idempotent apply → safe replay.

Bootstrap + catch-up:

```
connect → hello{ project_id, head_ulid }
no local state    → GET snapshot (/api/decisions,/todos,…) → build store; cursor = head_ulid
have cursor C     → send backfill{ since: C }
      server: (head-C) small  → replay projection deltas C..head
              (head-C) large  → snapshot + new cursor          # snapshot-vs-replay threshold
live → deltas applied in ULID order; cursor advances to each ulid
```

- **Snapshot-vs-replay threshold** (the one piece that earns its keep at scale): a client gone a long
  time re-snapshots instead of replaying tens of thousands of deltas. ~15 lines; removes a cliff.
- **Idempotency/order:** deltas apply in ULID order; duplicate/overlap (reconnect) is safe (upsert by
  id; `remove` of an absent id is a no-op). Drop any delta whose `ulid <= cursor`.
- Server stays **stateless per-connection** (matches the existing client-driven-backfill rationale).

## Client reactive store

Replaces today's ad-hoc globals (`FRAMES`/`DECISIONS`/`NODE_CFG`/`FILE_NAMES`/`FRAME_GOVERNANCE`)
rebuilt wholesale via `buildGraph()` on every load.

```js
// src/viewer/store.js — id-keyed maps, the single client source of truth
store = {
  decisions: Map<id, AdaptedDecision>,
  todos:     Map<id, AdaptedTodo>,
  prs:       Map<number, AdaptedPR>,
  frames:    Map<id, Frame>,
  cursor:    ulid,
}
store.apply(delta)   // upsert/remove one entity; mark it dirty
store.subscribe(fn)  // observers (the renderer) fire after a flush
```

- **Coalesced rendering = the actual "smooth."** `apply()` marks the entity dirty and schedules a
  single `requestAnimationFrame` flush. A burst of 200 deltas in 50 ms → **one** flush over 200
  entities, not 200 repaints. The render loop already runs on rAF (`mainLoop`); it consumes a
  dirty-set so `buildGraph()` becomes **incremental** — only re-derive frames/governance touched by
  dirty entities.
- **Non-big-bang migration.** The store becomes the *owner*; existing globals become thin views over
  it (`DECISIONS = store.decisions`), so canvas draw code changes minimally while the *source* of
  state flips from "refetched blob" to "live store." Each step verifiable against the running viewer.
- Cost of a change becomes **O(changed entities)**, not O(all). The store is also the natural seam
  where **IndexedDB persistence** slots in later (serialize maps + cursor; hydrate on cold start) —
  designed-for, not built now.

## Backend gaps to fill

1. **`todo.*` event kinds do not exist.** `TodoService` (`src/todos/service.ts`) writes its DB and
   returns — **no `EventBus` dependency at all**. Decisions already emit; TODOs are the gap. Add
   `todo.proposed|updated|transitioned|linked` to the `Event` union (`src/events/types.ts`) and emit
   them from the todo write path (service or tool handler), mirroring the decision emit pattern.
2. **Projection deriver.** A worker-side stage mapping each event → an adapted entity delta, reusing
   `buildAdaptedDecision`/`buildAdaptedTodo` (and PR/commit equivalents). Distinct from the existing
   graph `deriveMutations`.
3. **Viewer WS client.** The viewer currently never connects to `/ws` (WS integration was cut to keep
   the frames-viewer diff focused). Add a reconnecting client (backoff already modeled in the WS
   design) that feeds `store.apply`.

## Graceful adaptation — change treatments (⚠ OPEN — user to pick)

How a live change announces itself on the canvas. Prototyped and **QA-verified in a real browser**
(see companion asset). Four options; **not mutually exclusive**:

- **A · Pulse & glow** — new = green grow-in w/ halo, update = amber pulse, remove = red fade+shrink.
  Fast settle, low residue, legible under bursts. *(Recommended base motion.)*
- **B · Recency tint + actor** — changed frame tints in its layer hue + draining "freshness" bar +
  a small **actor badge** (who). Built for the 40-person stream. More persistent, more visual load.
- **D · Shimmer sweep** — a soft specular sweep across the changed frame + a glint on the dot.
  Elegant, quiet, no color shift. Candidate specifically for the *update* treatment.
- **C · Activity ripple** — rings fire from the changed node along edges to connected frames. Most
  "alive"; needs rate-limiting under bursts.

**Shared across all:** enter (grow-in) / update / exit (fade) timing. They differ on **residue** (how
long the signal lingers) and **attribution** (whether who-did-it shows). Natural combos: *A's motion
+ B's actor badge*, or *shimmer as the update treatment* with pulse for create/remove.

**Decision needed:** base motion (A / C / hybrid), attribution (actor badge toggle: off local /
on multi-actor), and whether shimmer replaces the amber pulse for updates. The `actor` field already
rides on every event envelope, so wiring attribution through now costs nothing structurally.

## Non-goals / scope boundaries

- No write path, client optimistic mutations, or conflict resolution (viewer is read-only).
- No central/hosted server, auth, multi-tenant, or external broker — these **compose on top** of the
  ordered log later (swap `events.db` for a broker; add `subscribe{project_id}`) without a viewer
  rewrite.
- IndexedDB persistence / partial (viewport) hydration: **designed-for, deferred**. At local
  single-user scale the snapshot refetch on localhost is fast; persistence's win is killing the
  cold-reload flash, which matters mainly once entity count balloons.

## Deliverables

- `docs/architecture/viewer-sync-engine.md` — **dedicated first-class architecture page** (user
  request): the log→deriver→delta→store→render path, one-adapter-two-transports, the cursor/catch-up
  protocol, the coalesced-render model. Cross-linked from `docs/architecture/graph-ui.md`.
- Backend: `todo.*` events + emitter; projection deriver; `projection` `ServerMsg` variant + backfill
  extension; snapshot-vs-replay threshold.
- Client: `src/viewer/store.js` (normalized reactive store + coalesced flush); WS client; incremental
  `buildGraph`; the chosen change-treatment animation layer.

## Testing strategy

- **Pure/unit:** store apply (upsert/remove/idempotency/dirty-set), coalescing (N applies → 1 flush),
  projection deriver (event → adapted delta per kind), snapshot-vs-replay threshold selection.
- **Integration:** WS `projection` round-trip; reconnect catch-up (replay path + snapshot path);
  todo emit → delta end-to-end.
- **Gate 0 visual QA (on the running viewer):** the chosen change treatment under a single change and
  under a burst; final motion-fidelity tuning happens here.

## Open items at cut-off

1. **Change treatment not locked** (Section above) — needs the user's pick.
2. Reconnect/resync UX detail (Section "Delta protocol") — threshold value + user-visible state.
3. "Final polish" list never enumerated (brainstorm ended early).
4. Spec self-review + user review gate (brainstorming checklist) not completed.
5. Then: `writing-plans` to produce the implementation plan.
```

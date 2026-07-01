# Reactive Viewer — Read-Path Sync Engine (design)

> Status: **complete — all open items settled, ready for implementation planning.**
> Date: 2026-07-01. Owner: rka.
> Companion prototype: [`assets/2026-07-01-viewer-change-treatments.html`](assets/2026-07-01-viewer-change-treatments.html)
> (open in a browser — mode **E · v5 live grammar** is the locked treatment; A–D are kept
> for comparison).

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
      server: (head-C) ≤ 500  → replay projection deltas C..head
              (head-C) > 500  → snapshot + new cursor          # snapshot-vs-replay threshold
live → deltas applied in ULID order; cursor advances to each ulid
```

- **Snapshot-vs-replay threshold: 500 deltas** (settled). A client gone a long time re-snapshots
  instead of replaying tens of thousands of deltas. ~15 lines; removes a cliff. Plain constant,
  tunable later; on localhost either path is fast — the threshold exists so team scale has no cliff.
- **Catch-up applies silently** (settled): backfilled/replayed deltas update the store but do **not**
  fire change treatments — no burst of stale animations after a laptop wake. Only deltas received
  while live-connected animate. frameHeat starts cold after a resync.
- **Connection state = one quiet toolbar indicator, no banners** (settled): a small mono dot+word in
  the existing toolbar row — `live` (dot in base color) → `syncing` (text-3, during
  backfill/snapshot) → `offline` (text-4, once reconnect backoff kicks in). Disconnection locally is
  almost always the dev server restarting; the reconnecting client heals in seconds.
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

## Graceful adaptation — change treatment (✅ LOCKED: E · v5 live grammar)

**Settled after user review.** The first four prototyped options (A pulse & glow, B recency tint,
C ripple, D shimmer — kept in the companion asset for comparison) were rejected as below the
viewer's visual fidelity: they shout where the viewer whispers (halos at 0.6–0.7 alpha vs. a
canvas whose loudest continuous element is a 0.45-alpha sine ring), they break the color
semantics (hue is *identity and state*, never event — amber means stale, red means blocked), and
they introduce foreign materials (specular sweeps, filled badge chips).

The locked treatment instead **re-adopts the live-activity grammar the original
[`cortex-frames-prototype-v5.html`](../../specs/cortex-v0.3/cortex-frames-prototype-v5.html)
already designed** — the layer that was dropped when the viewer was wired to real data — now
driven by real projection deltas instead of the simulation. No pulse animations anywhere
(explicit user constraint): every signal is a **state that decays**, not an oscillation.

| Event | Treatment (v5 source) |
|---|---|
| **create** | The dot is born as an **outline** ("sketch"), then **fills** ("commit") — v5's added-node → merge-beat grammar. Eases with the standard `ease()` / card cubic-bezier. |
| **update** | The entity's connections (leader lines) **fire once, synapse-style** — alpha 0.3 → 0.7 peak and settle, v5's 580 ms edge-intensity pattern — while the dot's halo lifts (0.10 → ~0.26) and **drains back linearly over ~3.5 s** (v5's `colorAmount` decay). No scale change, no ring, no hue shift. |
| **remove** | Reverse of birth: the fill **drains back to outline**, then the sketch fades. No red. |
| **residue** | v5 **`frameHeat`**: the containing frame's border warms by `+0.15 · intensity` over the 0.08 base and decays over **~5.5 s**; repeated activity saturates intensity (`+= 0.03`, capped) rather than restarting. At team scale the canvas reads as *warmth where work is happening*. |
| **attribution** | **Always on** (settled). v5 **presence pills**: vertically centered on the changed node, 11 px right of its center — agent-colored fill, dark content, **provider glyph** + name (e.g. `✳ claude`); the **user is base-white with no glyph** (`@rka`). The pill rides the change and fades with the halo drain. The `actor` field already rides every event envelope. |

**Deferred v5 elements** (designed-for, not in this effort): agent cursors traversing edges
between changes (needs live presence data we don't stream) and per-file node touch-tinting
toward the actor's hue (needs per-file change deltas; can ride the graph-mutation channel later).

### Final-polish list (folded into implementation)

- **Burst behavior:** frameHeat saturates (v5 `+0.03` capped at 1), halo drains restart at max
  (not additive); the coalesced rAF flush already collapses N deltas → 1 repaint.
- **Hidden tab:** on `visibilitychange` → hidden, deltas apply silently (same rule as catch-up);
  no animation backlog plays on return.
- **`prefers-reduced-motion`:** treatments collapse to instant state changes.
- **Light mode:** all treatment colors route through the existing canvas theme helpers, as v5's did.
- **Pill edge-flip:** presence pills near the right canvas edge flip to the node's left (same
  logic the viewer's own node pills use).
- **Layer toggles:** no treatment fires for a hidden layer (`showDecisions` / `showTodos` off).
- **Removed-while-open:** if the entity whose drawer is open is removed, the card shows a quiet
  removed state instead of vanishing.
- **Project switch mid-stream:** deltas are keyed by project; stale-project deltas are dropped.

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
  extension; snapshot-vs-replay threshold (500).
- Client: `src/viewer/store.js` (normalized reactive store + coalesced flush); WS client with
  reconnect + silent catch-up + toolbar live/syncing/offline indicator; incremental `buildGraph`;
  the **E · v5 live grammar** treatment layer (frameHeat, synapse fire, outline→fill births,
  presence pills — constants ported from `cortex-frames-prototype-v5.html`).

## Testing strategy

- **Pure/unit:** store apply (upsert/remove/idempotency/dirty-set), coalescing (N applies → 1 flush),
  projection deriver (event → adapted delta per kind), snapshot-vs-replay threshold selection.
- **Integration:** WS `projection` round-trip; reconnect catch-up (replay path + snapshot path);
  todo emit → delta end-to-end.
- **Gate 0 visual QA (on the running viewer):** the E treatment under a single change and under a
  burst; reconnect indicator states; final motion-fidelity tuning happens here.

## Settled during review (2026-07-01, session 2)

1. **Change treatment: E · v5 live grammar** — locked (section above). A–D rejected on brand
   fidelity; treatment re-adopts the original prototype's live layer, delta-driven, pulse-free.
2. **Attribution: always on**, v5 presence pills; agent-made changes carry the provider glyph,
   the user renders base-white.
3. **Reconnect/resync:** 500-delta snapshot threshold; silent catch-up (no stale animations);
   quiet toolbar `live / syncing / offline` indicator, no banners.
4. **Final-polish list** enumerated (section above).

Next: `writing-plans` to produce the implementation plan.

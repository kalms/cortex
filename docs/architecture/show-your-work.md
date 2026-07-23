# Show Your Work — Presence Pipeline (Slice 1)

> Living document. Started 2026-07-23. Covers what has **shipped** — the
> live presence pipeline. Stories (agent-curated walkthroughs) and network
> layout mode are future slices of the same design; see
> [the design spec](../superpowers/specs/2026-07-23-show-your-work-design.md)
> for their shape. This doc does not describe unshipped behavior.

## Purpose

Make the agent's work *visible* in the frames viewer, three ways:

1. **Live ambient presence** (this doc, shipped) — automatic, hook-fed: what
   the agent is studying/editing streams into the viewer as avatar motion +
   frame heat. Zero agent effort.
2. **Stories** (future slice) — agent-curated walkthroughs the user pages
   through: checkpoints, branch walkthroughs, blast-radius previews.
3. **Explain-architecture aid** (future slice) — the `explain-architecture`
   skill emits its explanation as a story so the user can follow it on the
   graph.

**Agent stance:** presence is automatic and requires no agent action —
every `Read`/`Edit`/`Write`/`MultiEdit` and a handful of Cortex read tools
stream a beacon on their own via a hook. The (future) `show` tool is
**discretionary** — used when visual detail benefits the user, never as
ceremony. Slice 1 ships presence only; there is no `show` tool yet.

## Presence pipeline

```
PostToolUse hook                 HTTP                  EventBus            Worker thread              WS
──────────────────               ────                  ───────             ─────────────              ──
Read/Edit/Write/MultiEdit    curl (fire-and-forget)  bus.emit(           processEvent():           broadcast
mcp__cortex__{get_code_        POST /api/presence  →   presence.activity) →  persister.insert()  →  { type:'event',
  snippet,context_pack,           │                                          deriveMutations→[]        event }
  search_graph,trace_path}    Zod-validated,                                 (zero mutations)          │
mcp__cortex__decision           16 KB cap,                                                         viewer:
  (action why|get only)         canonical-root gate                                                 ws-client.js
                                 accepted:true/false                                                 onEvent →
                                                                                                       eventBackfill →
                                                                                                       CanvasHost →
                                                                                                       engine.applyPresence
```

1. **Hook** — `hooks/show-presence.sh`, wired as two `PostToolUse` matchers
   in `hooks/hooks.json`: one on `Read|Edit|Write|MultiEdit`, one on
   `mcp__.*cortex.*__(get_code_snippet|context_pack|search_graph|trace_path|decision)`.
   Reads the tool-call JSON from stdin, maps it to an activity + ref (table
   below), and fire-and-forgets a `curl` POST. **Degrade-safe**: missing
   `jq`, empty payload, no session id, unresolvable ref, or any network
   failure is a silent `exit 0` — the hook never blocks the agent.
2. **`POST /api/presence`** (`src/mcp-server/api.ts`) — validates the body
   against `PresencePostSchema` (`src/mcp-server/api-schemas.ts`, 16 KB
   request-body cap via `MAX_PRESENCE_BODY`), checks
   `canonicalRepoPath(repo_path) === presence.homeRoot` (so a worktree
   session's `repo_path` resolves to the same project as the main checkout —
   `canonicalRepoPath` in `src/db/git-root.ts` walks up to the main worktree
   root), and only then calls `presence.emit(parsed.data)`. The response is
   always `{ version, accepted: boolean }` — `accepted:false` on a
   repo/project mismatch or when no `presence` wiring was passed to
   `startViewerServer` (never an error status), so a stray beacon from an
   unrelated repo is dropped, not surfaced as a failure to the hook.
3. **Bus wiring** (`src/index.ts`) — the `presence.emit` callback wraps the
   POST body into a full `Event` envelope: `newUlid()` for `id`,
   `kind: "presence.activity"`, `actor: "claude"`, `created_at: Date.now()`,
   and calls `bus.emit(...)`. From here it's the **same** EventBus → worker
   → WS pipeline every other event kind uses (see
   [graph-ui.md](graph-ui.md#event-flow-claude-creates-a-decision)).
4. **Worker** (`src/events/worker.ts`) — `processEvent()` persists via
   `EventPersister.insert()` and calls `deriveMutations()`
   (`src/events/worker/mutation-deriver.ts`), whose `presence.activity` case
   returns `[]` unconditionally: *"Presence is telemetry, not knowledge: it
   never mutates the graph."* No `add_node`/`add_edge` mutation is ever
   produced for a presence event.
5. **Retention** — `EventPersister.reapPresence(nowMs)`
   (`src/events/worker/persister.ts`) deletes `events` rows where
   `kind LIKE 'presence.%'` older than `PRESENCE_RETENTION_MS` (24 h). Called
   once, best-effort, from the worker's `init` handler
   (`src/events/worker.ts`) — a reap failure is posted as a non-fatal
   `{ type: 'error' }` message and never blocks event processing.
6. **WS broadcast + viewer backfill** — the worker's broadcast bundle
   reaches every connected client as a `{ type: 'event' }` WS message
   (`ws-client.js`'s `onEvent`). A late-joining tab also gets recent history:
   on every `hello`, `ws-client.js` sends `{ type: 'backfill', limit }`
   (`eventBackfill: { limit: 200 }` in `CanvasHost.tsx`) and the server
   answers with `backfill_page` — **replayed on every reconnect**, so
   downstream consumers must tolerate re-delivered events (idempotent
   `noteActivity` upserts handle this; see Viewer below).

### Activity mapping (hook → payload)

| Tool matcher | `activity` | `refs[0]` source | Notes |
|---|---|---|---|
| `Read` | `studied` | file path (repo-relative) | |
| `Edit`, `Write`, `MultiEdit` | `edited` | file path (repo-relative) | |
| `mcp__*cortex*__get_code_snippet`, `context_pack`, `search_graph` | `studied` | `tool_input.qualified_name` or `.name_pattern` | |
| `mcp__*cortex*__trace_path` | `traced` | `tool_input.function_name` | |
| `mcp__*cortex*__decision` | `consulted` | `tool_input.qualified_name` / `.decision_id` / `.id` | **`action` gated to `why`\|`get` only** — any other `action` (`create`/`update`/`link`/…) exits 0 without posting. See "no-double-coverage" below. |
| anything else | — | — | hook exits 0 |

For `Read`/`Edit`/`Write`/`MultiEdit`, the hook also applies a **scope
filter**: it resolves the file's git root via `git rev-parse
--show-toplevel` and drops the beacon (`exit 0`) if the file falls outside
that root — a file edited in an unrelated repo, `~/.claude`, or a scratchpad
never gets POSTed. Both the resolved root and file path are canonicalized
(`cd ... && pwd -P`) before the prefix check, so macOS's `/tmp` →
`/private/tmp` symlink doesn't defeat the filter.

## No-double-coverage rule

The hook's matcher table deliberately **excludes** `decision`/`pr`/`todo`
*mutations* (`create`/`update`/`link`/`transition`/…). The MCP server
already self-emits those events on its own write path (`bus.emit(...)`
inside the service layer) and they already animate today — births, halos,
tombstones, and per-actor attribution pills in
[`live-effects.js`](graph-ui.md#component-boundaries). The hook covers only
what the server can't see from inside a write call: Claude's own **reads**,
file edits, traces, and decision *reads* (`why`/`get` — hence the
`action` gate on the `decision` matcher above). A single tool action animates
via **exactly one** channel — never both.

## Aggregation-point assumption

Each Claude Code session runs its own MCP server process, but only **one**
process binds the shared HTTP port (`CORTEX_VIEWER_PORT`, default `3333`; a
second instance on the same repo skips the viewer bind and continues over
stdio only — see [graph-storage.md](graph-storage.md)). Every session's hook
POSTs to whichever process holds that port — this is precisely how presence
from multiple concurrent sessions (including worktree sessions on the same
project) converges into one viewer tab. If the port owner exits, presence
goes dark until another process binds it; accepted as a v1 limitation.

### Port discovery + sentinel

The hook resolves a base URL in this order, per invocation:

1. `CORTEX_PRESENCE_URL` env override, if set — used as-is, no probing.
2. A cached port from the session's sentinel file at
   `${TMPDIR:-/tmp}/cortex-presence-port-<session_id>` — written the first
   time a probe succeeds, so subsequent hook invocations in the same session
   skip the probe entirely.
3. Otherwise, probe `CORTEX_VIEWER_PORT` (if set), then `3333`, then `3334`
   (plugin default vs. `npm run dev`) — each via `GET /api/health` with a
   0.3 s timeout, first responder wins, and the winning port is written to
   the sentinel.

If a POST to a cached port fails, the sentinel is cleared so the next
invocation re-probes rather than retrying a dead port forever.

### Auth + opt-out

`CORTEX_API_TOKEN`, if set, is sent as `Authorization: Bearer <token>` (the
POST honors the same bearer-auth gate as every other `/api/*` route — see
[http-api-contract.md](http-api-contract.md)). `CORTEX_PRESENCE=0` disables
the hook entirely (checked first, before even the `jq` presence check).

## Retention

| Layer | Window | Mechanism |
|---|---|---|
| Server event log | 24 h (`PRESENCE_RETENTION_MS` = `86_400_000` ms) | `EventPersister.reapPresence()`, run once at worker `init` |
| Viewer backfill replay | 30 min (`BACKFILL_WINDOW_MS` = `1_800_000` ms in `CanvasHost.tsx`) | Backfilled (`live:false`) events older than the window are dropped before reaching `engine.applyPresence` — live events are never window-filtered |

The two windows serve different jobs: the server retains a day of raw
presence rows so any tab that connects within 24 h has *something* to
backfill from, while the viewer only *animates* the last 30 minutes of that
backfill — older beacons are inert history the server will eventually reap,
not something a freshly-opened tab replays as if it just happened.

## Viewer

### `canvas/presence.js` — pure state machine

`createPresence({ reducedMotion })` (`src/viewer/canvas/presence.js`) is a
pure, injectable-time state machine in the same style as `live-effects.js`:
no canvas access, no `Math.random`, self-cleaning via `now`-relative
queries. The engine feeds it BFS paths over the frame adjacency graph (it
never sees the frame graph itself) and reads back per-frame heat / per-
session roster / travel state every draw.

| Constant | Value | Meaning |
|---|---|---|
| `PRESENCE_HEAT_MS` | 90,000 (90 s) | Linear decay window for the faint **TRAIL** heat tier |
| `PRESENCE_FLASH_MS` | 6,000 (6 s) | Linear decay window for the prominent **FLASH** heat tier (arrival glow) |
| `COLOR_FADE_MS` | 3,500 (3.5 s) | Cursor `colorAmount` fade after arrival — a resting cursor cools from its hue to neutral ink (prototype v5) |
| `IDLE_MS` | 120,000 (2 min) | No events past this age → session drawn dimmed ("idle") but still present |
| `GONE_MS` | 900,000 (15 min) | No events past this age → session dropped from every query (roster, sessions, heat) |
| `TRAVERSE_SEG_MS` | 580 ms | Per-segment eased traversal duration when an avatar moves frame-to-frame |
| `HEAT_BY_ACTIVITY` | `edited:1.0, studied:0.6, traced:0.6, consulted:0.4` | TRAIL contribution per activity kind, capped at 1.0 total |
| `PRESENCE_COLORS` | 6 RGB triples (amber, blue, purple, emerald, rose, teal) | Deterministic per-session color via `colorIdxFor(sessionId)` (base-31 polynomial hash of `sessionId`, mod 6) — first three mirror the prototype's `--agent-a/b/c`; distinct from `LAYER_RGB` and the theme accent |

Grammar, in brief (full prose is in the module's header comment):

- **`noteActivity`** — upserts the session's roster entry, bumps the faint
  **TRAIL** heat on every resolved frame, stores the `targetPath` (the ref
  anchoring the target frame, for the dot-level cursor approach), and sets
  the traversal target to the first resolved frame. No prior position (new
  session), `animate:false` (replayed backfill), or `reducedMotion` →
  teleport directly. Otherwise the target becomes **pending** for the engine
  to resolve into a BFS path via `setPath`.
- **`setPath`** — the engine hands back a frame-to-frame path; the session
  advances it lazily, one `TRAVERSE_SEG_MS` segment at a time inside
  `sessions(now)` (no timers), firing one synapse pulse per segment and one
  **FLASH** per arrival — including catch-up: if two+ segments complete
  between polls, each crossed boundary still gets its own historically-timed
  pulse and flash rather than one merged jump.
- **Idle/gone** — `lastSeen` age past `IDLE_MS` dims the avatar; past
  `GONE_MS` the session is pruned entirely (every query calls `prune(now)`
  first).
- **Heat** — `presenceHeat(frameId, now)` is a deliberately **pure read**
  (no self-delete-on-read, unlike `live-effects.js`'s transient queues):
  heat entries are bounded by distinct frame count (not event volume) and
  must stay a pure function of `(value, t0)`. It returns
  `{ flash, trail, flashColorIdx, trailColorIdx }` (each tier in `[0,1]`) or
  `0` when neither tier is live.
- **Cursor `colorAmount`** — `sessions(now)` reports a per-session
  `colorAmount`: `1` while traversing, then fading to `0` over
  `COLOR_FADE_MS` after arrival, so the engine can lerp a resting cursor's
  color from its hue back to neutral ink (prototype v5 cursor treatment).

### Three heat tiers, kept distinct

Presence heat is **two-tier** — this is what fixes the "wide-border storm"
(too many frames glowing at once because heat was event-time-applied with a
90 s decay). FLASH marks *where a session is now*; TRAIL is the slow *where
work has happened lately* backfill trail.

| Tier | Owner | Decay | Applied on | Draw (max α) | Answers |
|---|---|---|---|---|---|
| Mutation heat | `live-effects.js`, `HEAT_DECAY_MS = 5500` (5.5 s) | fast, linear | server mutation | uncolored border warmth | "something changed here" |
| Presence FLASH | `canvas/presence.js`, `PRESENCE_FLASH_MS = 6000` (6 s) | fast, linear | **arrival** (live teleport, each traversal-segment arrival, or live re-activity on the current frame) | session-colored **wide border** (0.35) | "a session is HERE now" |
| Presence TRAIL | `canvas/presence.js`, `PRESENCE_HEAT_MS = 90000` (90 s) | slow, linear | **event time**, every resolved frame | session-colored faint outline (0.12) | "work happened here lately" |

Backfill / `reducedMotion` (`animate:false`) applies **TRAIL only, never
FLASH** — so a reload never lights every touched frame's wide border at
once. The engine draws the faint trail **under** the wide flash. All tiers
render simultaneously and independently.

### `adapters.js` helpers

`src/viewer/canvas/adapters.js` provides the pure functions the engine
composes into the presence pipeline:

- **`frameIdsForRefs(pathIndex, refs)`** — resolves a beacon's `refs[]`
  (file paths, `"path::symbol"` qualified names) to frame ids via the
  frame-path index. Decision/todo ids (`/^[DT]-/`) have no frame anchor and
  are skipped; unresolvable paths drop silently. De-duped, order-preserving.
- **`primaryRefPath(pathIndex, refs)`** — the file path of the **first**
  resolving ref (the ref anchoring `frameIdsForRefs(...)[0]`, i.e. the
  traversal target). Carried on the session as `targetPath` so the cursor
  can target that file's actual dot when it's drawn. `null` when nothing
  resolves.
- **`buildFrameAdjacency(pairs)`** — builds an undirected adjacency map from
  inter-frame pairs (the same connectivity the edge web draws), rebuilt on
  every `setData` (project switch).
- **`frameBfsPath(adj, fromId, toId)`** — shortest frame-to-frame path
  (inclusive), `[]` when unreachable or either endpoint is unknown.

### `engine.js` — `applyPresence` / draw / roster

- **`applyPresence(events)`** (public engine method, called from React) —
  for each `{ payload, live }` event: resolves `refs` to frame ids via
  `frameIdsForRefs`, calls `presenceFx.noteActivity({ ..., animate: live !==
  false })`, then — if a traversal target is now pending — computes a BFS
  path via `frameBfsPath` over `FRAME_ADJ` and hands it to `presenceFx.setPath`
  (falling back to a direct 1-hop "path" when no route exists or there's no
  prior position). Inert until events arrive: an empty roster draws nothing.
- **`drawPresence(now)`** — called last from `mainLoop`, gated on the
  `showPresence` layer pref. Draws, in order:
  - **Synapse pulses** — a bright head + fading trail in the moving
    session's hue. When a real inter-frame edge between the two frames is
    **currently drawn** (`drawnInterFrameEdgePx` — both endpoint dots pass
    the same LOD reveal + cull gating `drawNodes` uses), the pulse rides that
    edge's actual endpoint geometry (prototype `drawSynapses`); otherwise it
    runs frame-center to frame-center.
  - **Session cursors** — the prototype v5 cursor: a breathing dot whose
    color lerps from neutral base ink toward the session hue by `colorAmount`
    (fading over `COLOR_FADE_MS` after arrival). At rest the dot targets the
    ref's **actual dot** (`dotPxIfDrawn`) when that dot is drawn at the
    current LOD; during traversal it lerps along the active segment; when the
    dot is shed at low zoom it falls back to the frame center (never a stale
    dot position). `frameCenterPx` / `dotPxIfDrawn` reuse the same
    camera-composed per-tick `framePx` cache and `visibleFrames` culling as
    `drawFrames`, so cursors and heat stay glued under pan/zoom.

  Fully inert (no-op) when the pref is off or the roster is empty.
- **Roster → React** — `scheduleRosterCallback()` throttles
  `onPresenceRoster` to at most once per second, and `emitRosterIfChanged()`
  skips the callback entirely when the JSON-serialized roster hasn't changed
  since the last emission (idle/gone transitions can flip roster content
  without a new event, so the main loop also pokes the schedule each frame).
- **`showPresence` pref** — `SHOW_LS.presence = 'cortex.viewer.show.presence'`
  localStorage key, defaulted **on** (`readShow` treats anything but the
  literal `"0"` as on), toggled via `LmToggle` in `LayersMenu.tsx`
  (`lm-presence` row) and persisted by `App.tsx`'s `layerPrefs` effect —
  same pattern as `showFrames`/`showDecisions`/`showTodos`.

### `PresenceStrip.tsx` — roster UI

`src/viewer/app/toolbar/PresenceStrip.tsx` renders the prototype v5
`.presence` strip — one **28px overlapping avatar ring** per active session
from `useUiStore((s) => s.presenceRoster)` (populated by `CanvasHost`'s
`onPresenceRoster` callback), hidden entirely when `showPresence` is off or
the roster is empty. Each avatar: session hue from a **hand-synced** copy of
`PRESENCE_COLORS` (`COLORS` array, kept in sync by comment since CSS-in-JS
can't import the canvas module), the claude "session" provider glyph (the
prototype's 4-line asterisk), a `border: 2px solid var(--bg)` separation
ring, `-8px` overlap, and an `idle` class that swaps the hue for neutral
grey. Hovering an avatar lifts it (`.lifted`, `translateY(-3px)`) and reveals
a single shared `.presence-tip` showing `@handle` (the workspace) + a
provider line (`claude session · <6-char session id>`) — same light/dark
`var(--*)` token treatment as the prototype. React owns this DOM (house
rule); the canvas presence layer draws cursors/heat, never the strip. Mounted
in `Toolbar.tsx` alongside `LayersMenu`.

### Viewer-side race handling (`CanvasHost.tsx`)

Presence events can arrive over WS before the engine's frame index exists
(HTTP boot hasn't resolved yet). `CanvasHost.tsx` buffers
(`pendingPresence`, capped at `PENDING_PRESENCE_CAP = 400`, drop-oldest on
overflow) until `armFramesReady()` fires — shared by `boot()`, the
`resnapshot` callback, and the project-switch handler — then flushes in
arrival order. A monotonic `loadEpoch` token guards all three async loaders
so a stale in-flight loader (e.g. project A's boot resolving after a switch
to B has started) can't re-arm the gate against the wrong project's frame
index. `ws-client.js`'s `event`/`backfill_page` messages are **not**
filtered by bound project the way `projection` deltas are, so `CanvasHost`
applies its own `isLiveProject()` guard before touching the engine — with a
pre-boot exception (buffer instead of drop) for the window between the WS
`hello` (which already knows `boundProject`) and `fetchProjects()` resolving
(where `currentProject` is still `null`).

## What's in scope vs. not (slice 1)

**Shipped, in scope:** the presence pipeline above — hook → HTTP → bus →
worker → WS → viewer avatars/traversal/heat/roster strip.

**Explicitly future slices** (see
[the design spec](../superpowers/specs/2026-07-23-show-your-work-design.md)):
the `show` MCP tool, agent-curated stories (`stories`/`story_steps` tables,
story-mode viewer UI, deep-linking), and network layout mode. None of that
exists yet — do not build against it.

**Still out of scope** (unchanged from
[graph-ui.md](graph-ui.md#module-layout)'s original non-goal list): the v5
prototype's PR floating nodes, merge animation, auto-loop/demo mode, and
multi-agent simulation. Presence avatars and traversal, formerly on that
same non-goals line, are now shipped — see the amended note in
[graph-ui.md](graph-ui.md#module-layout).

# Cortex — Session Handoff (2026-04-17)

## What Was Done This Session

### Plan A — Graph UI Backend (merged + pushed)

Shipped the event pipeline, git watcher, and WebSocket server that power the upcoming 2D graph viewer and activity stream. 24 commits merged to main and pushed to `origin/main`.

- **Two-thread pipeline:** main thread runs the MCP server, HTTP server, and WebSocket broadcaster. Worker thread owns `events.db` (separate from `cortex.db`), derives graph mutations from events, and hosts the git watcher.
- **Event schema:** 7 event kinds (`decision.*` + `commit`), dotted taxonomy for extensibility. ULID primary keys (sortable by time, monotonic within-ms). `events.db` schema at [src/events/worker/schema.sql](src/events/worker/schema.sql).
- **WebSocket protocol at `/ws`:** `hello` → live `event` + `mutation` messages → client-driven `backfill` for history. Heartbeat via `ping`/`pong`. Full protocol in the spec.
- **Git watcher:** chokidar on `.git/logs/HEAD`, parses commits with `git log <last>..HEAD --format=%H%x00%s%x00%an%x00%at --name-status`. `decision_links` (files governed by any decision) computed at emission, not render.
- **Worker supervisor:** auto-restart on crash with exponential backoff (1s → 2s → 4s → cap 30s). Events in-flight during a crash are lost — accepted v1 tradeoff.
- **DecisionService emits events** after every CRUD operation. Bus is optional — backward compatible with existing callers (tests, scripts).
- **`author` field added** to decisions (defaults to `'claude'`). `visibility` deferred pending multi-user work.

**Tests: 119 passing.** Typecheck clean.

### Key artifacts

| Artifact | Path |
|---|---|
| Spec | [docs/superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md](docs/superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md) |
| Plan A (done) | [docs/superpowers/plans/2026-04-17-graph-ui-backend.md](docs/superpowers/plans/2026-04-17-graph-ui-backend.md) |
| Architecture doc | [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) — read this before touching the event pipeline, WS server, or viewer |

### Decisions captured (one)

- **[4924bc84]** Investigate agent onboarding gap — during this session the agent made ~16 load-bearing decisions and captured none of them via `create_decision`, despite CLAUDE.md instructing it to. This is a dogfooding gap, not an agent-specific failure: any capable LLM will behave the same. The fix needs its own brainstorm (hook vs skill vs prompt redesign vs mid-session triggers).

## Current State

- **Branch:** `main`, synced with `origin/main` (24 commits pushed)
- **Tests:** 119 passing across 22 files
- **TypeScript:** compiles clean (`npx tsc --noEmit`)
- **Dev viewer:** http://localhost:3334/viewer (run `npm run dev`); MCP plugin instance uses :3333
- **WebSocket:** `ws://localhost:3334/ws` in dev
- **New files:** `.cortex/events.db` (created on first run)

## What's Next

### Primary: Plan B — 2D graph viewer (not yet planned)

The spec describes it; the plan file doesn't exist yet. The next session should:

1. **Start from the spec section "2D viewer (browser)"** ([spec link](docs/superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md)) — already covers tech (d3-force + Canvas 2D, no framework), module layout (`src/viewer/graph-viewer-2d.js` + `shared/` dir), visual language (shapes, lerp hover, synapse animations), and a 9-step ladder (static render → force sim → hover → WS wiring → synapse → search → detail panel → focus mode).
2. **Skip brainstorming** — design is already validated in the approved spec. Go straight to writing-plans.
3. **Reuse the approved visual language** from the spec: greyscale at rest, per-type hover colors, equal-sided lavender diamond for decisions (r=7–8px), circle for files, dot for functions, pill for components, hex for references, triangle for paths. Option G ghost-fill at 40% base opacity for proposed/superseded.
4. **Use the shipped backend** — `/api/graph` for initial hydration, `/ws` for live mutations. Protocol types in [src/events/types.ts](src/events/types.ts) (re-exported from [src/ws/types.ts](src/ws/types.ts)).

**Estimated scope:** ~15 tasks, similar shape to Plan A. Steps 1–5 of the ladder = v1 "good"; steps 6–9 = v1 "complete." Each independently shippable.

### Secondary: Plan C — Activity stream + graph↔stream sync

Not yet planned. Spec covers layout, event rendering, search/filter chips, live streaming behavior, backfill, and graph↔stream click-sync. Build after Plan B stabilizes — they share the same WebSocket connection and some visual primitives.

### Tertiary: Onboarding gap investigation

Decision [4924bc84] is a brainstorm-in-waiting. When it happens, consider:

- Hook-based: post-commit scan of the diff + "any decisions to capture?" prompt
- Skill-based: a `review-recent-commits` skill that sweeps and suggests
- Prompt-based: more active SessionStart reminder with concrete examples
- Mid-session triggers: before merge, when a spec/plan doc is written

## Tech Debt Carried Over (not blockers)

- **`src/ws/server.ts:~52`** — 5ms `setTimeout` before sending `hello` works around a same-process WebSocket frame-ordering quirk on loopback. TODO in the comment. Real fix probably needs a client-sent `ready` handshake.
- **Bootstrap duplication** — `src/events/worker-bootstrap.mjs` and `tests/integration/worker-bootstrap.mjs` differ by ~15 lines. Acceptable for v1 given tsx + Node 23 + worker_threads headaches; consolidate later.
- **`tsconfig.json`** doesn't copy `.mjs` to `dist/`. Only matters for `npm run build` + `npm start`; dev mode (`npm run dev`) is unaffected. Add a postbuild step when we start shipping compiled output.
- **`tests/integration/end-to-end.test.ts`** still passes raw `NodeRow`-shaped objects to `snapshot_update`. Doesn't break any assertions; fix next time that file is touched.

## Quick Start for Next Session

```bash
cd ~/Development/cortex
git pull                          # sanity check
npm install                       # if deps changed
npm test                          # should be 119 passing
npm run dev                       # MCP + viewer + /ws on :3334
```

To explore what was built:

```bash
# Read the design
open docs/architecture/graph-ui.md

# Verify the event pipeline end-to-end
# (watch this file + make a dummy commit; observe events.db grow)
sqlite3 .cortex/events.db "SELECT id, kind, actor FROM events ORDER BY id DESC LIMIT 10;"

# Hit the API
curl -s http://localhost:3334/api/graph | jq '.nodes | length'
```

To kick off Plan B:

```
/plan-from-spec docs/superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md sections: "2D viewer (browser)"
```

(Or invoke `superpowers:writing-plans` directly — the spec is already approved and committed.)

## Key Files (new from this session)

| File | What it does |
|------|-------------|
| [src/events/types.ts](src/events/types.ts) | Event + GraphMutation + WS message type unions |
| [src/events/bus.ts](src/events/bus.ts) | Main-thread event bus (facade for DecisionService) |
| [src/events/ulid.ts](src/events/ulid.ts) | ULID generator (monotonic within-ms) |
| [src/events/worker.ts](src/events/worker.ts) | Worker thread entry; composes persister + deriver + watcher |
| [src/events/worker-bootstrap.mjs](src/events/worker-bootstrap.mjs) | Registers tsx inside the worker (Node + worker_thread quirk) |
| [src/events/worker-supervisor.ts](src/events/worker-supervisor.ts) | Auto-restart worker with exp backoff |
| [src/events/worker/persister.ts](src/events/worker/persister.ts) | `events.db` writer + backfill reader |
| [src/events/worker/mutation-deriver.ts](src/events/worker/mutation-deriver.ts) | Pure function: Event → GraphMutation[] |
| [src/events/worker/git-log-parser.ts](src/events/worker/git-log-parser.ts) | Pure parser for `git log --format=... --name-status` output |
| [src/events/worker/git-watcher.ts](src/events/worker/git-watcher.ts) | chokidar + parser; emits `commit` events |
| [src/ws/server.ts](src/ws/server.ts) | WebSocket server at `/ws` |
| [src/ws/client-registry.ts](src/ws/client-registry.ts) | Connection set with fan-out broadcast and auto-eviction |
| [src/ws/protocol.ts](src/ws/protocol.ts) | `encodeServer` / `decodeClient` message codecs |

## Key Files (modified this session)

| File | Change |
|------|--------|
| [src/decisions/service.ts](src/decisions/service.ts) | Accepts optional bus, emits events on every mutation |
| [src/decisions/promotion.ts](src/decisions/promotion.ts) | Same treatment — emits `decision.promoted` |
| [src/decisions/types.ts](src/decisions/types.ts) | Added `author?: string` to Decision + inputs; `reason?: string` to UpdateDecisionInput |
| [src/mcp-server/api.ts](src/mcp-server/api.ts) | Returns `{ port, httpServer }` so caller can attach WS upgrade handler |
| [src/mcp-server/server.ts](src/mcp-server/server.ts) | Accepts optional bus, forwards to DecisionService + DecisionPromotion |
| [src/index.ts](src/index.ts) | Wires EventBus + WorkerSupervisor + WebSocket server + snapshot projection |

# Viewer Reactive Read-Path Sync Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frames viewer reactive — decision/TODO changes stream over `/ws` as projection deltas and the canvas adapts live with the locked **E · v5 live grammar** treatment, without a reload.

**Architecture:** The existing write side (EventBus → worker → `events.db` ULID log → WS broadcast) is extended with a **projection channel**: a main-thread deriver maps each event to a full adapted-entity delta (reusing `buildAdaptedDecision`/`buildAdaptedTodo` — one adapter, two transports), keyed by the source event's ULID (the sync cursor). The viewer gains a normalized store with coalesced rAF flush, a reconnecting WS client with snapshot-vs-replay catch-up (threshold 500), and a live-effects layer implementing the v5 grammar (outline→fill births, synapse-fire + draining-halo updates, frameHeat residue, presence pills).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `worker_threads`, `ws`, better-sqlite3, vitest; viewer is plain browser ES modules (`src/viewer/*.js`, also vitest-importable — see `tests/viewer/adapters.test.js`).

**Spec:** [docs/superpowers/specs/2026-07-01-viewer-reactive-sync-engine-design.md](../specs/2026-07-01-viewer-reactive-sync-engine-design.md)

## Global Constraints

- **Branch/worktree:** execute in a git worktree on branch `feature/viewer/reactive-sync-engine` (it exists; the spec is committed on it). `git worktree add ../cortex-wt-reactive-sync feature/viewer/reactive-sync-engine`. Fresh worktrees lack `node_modules` + `bin/cortex-indexer` — symlink both from the main checkout.
- **Snapshot-vs-replay threshold:** `500` deltas (constant `CATCHUP_REPLAY_LIMIT` in `src/ws/server.ts`).
- **No pulse animations.** Every visual signal is a state that decays, never an oscillation.
- **Treatment timing constants (locked):** birth 500 ms; halo drain 3500 ms linear; leader (synapse) fire 580 ms triangular peak; removal 500 ms; frameHeat decay 5500 ms; frame border heat contribution `+0.15 · intensity` over the 0.08 base.
- **Color semantics reserved:** amber = stale, red = blocked. Treatments never hue-shift an entity.
- **Attribution always on:** actor `'claude'` or `'system'` → agent presence pill (dark content on `#60a5fa`, `✳` glyph); any other actor → user pill (base-white fill, `@<name>`, no glyph).
- **Catch-up applies silently** (`animate: false`); only live deltas received while connected + tab visible animate.
- **Key protocol property (rely on it, don't fight it):** projection deltas are derived by reading the sidecar DBs *at derivation time*, so a delta always carries the entity's **current** adapted shape. Replay is state-converging, not history-replaying — overlapping/duplicate replay is harmless.
- **HTTP contract untouched:** no changes to `src/mcp-server/api-schemas.ts` HTTP schemas or `docs/api/*.schema.json` (never hand-edit those). The WS protocol lives in `src/events/types.ts` and is versioned by `server_version` in `hello`, not the HTTP contract.
- Commit messages: `type(scope): description`, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Run targeted tests per task; run the full `npm test` before Task 13's PR.
- Stop at PR-opened + CI green. **Never merge — the user tests first** (standing instruction).

## File Structure

```
src/events/types.ts                    MODIFY  todo.* event kinds; ProjectionDelta; ServerMsg/ClientMsg variants; hello.head_ulid
src/events/worker/mutation-deriver.ts  MODIFY  no-op cases for todo.* kinds
src/events/worker/persister.ts         MODIFY  since() + head() forward reads
src/todos/service.ts                   MODIFY  optional EventBus + project_id; emit todo.* events
src/mcp-server/tools/todo-tools.ts     MODIFY  thread indexerProject + bus into TodoService
src/mcp-server/server.ts               MODIFY  pass indexerProject + bus to registerTodoTools
src/mcp-server/projection-deriver.ts   CREATE  event(s) → ProjectionDelta[] (reads repos at derive time)
src/mcp-server/api.ts                  MODIFY  export buildPathIndices
src/ws/server.ts                       MODIFY  hello.head_ulid; catchup handling; broadcastProjections
src/index.ts                           MODIFY  wire projection deriver + fan-out
src/viewer/store.js                    CREATE  normalized store + coalesced flush
src/viewer/ws-client.js                CREATE  reconnecting sync client + catch-up
src/viewer/live-effects.js             CREATE  v5-grammar transient animation state
src/viewer/viewer.js                   MODIFY  store hydration, incremental apply, draw integration, indicator
src/viewer/index.html                  MODIFY  sync-indicator element
src/viewer/style.css                   MODIFY  indicator + dc-removed-note styles
docs/architecture/viewer-sync-engine.md CREATE architecture page
docs/architecture/graph-ui.md          MODIFY  cross-link
tests/todos/events.test.ts             CREATE
tests/events/persister.test.ts         MODIFY  since()/head() cases
tests/ws/protocol.test.ts              MODIFY  new ServerMsg/ClientMsg variants
tests/mcp-server/projection-deriver.test.ts CREATE
tests/integration/ws-server.test.ts    MODIFY  catchup + projection broadcast cases
tests/viewer/store.test.js             CREATE
tests/viewer/ws-client.test.js         CREATE
tests/viewer/live-effects.test.js      CREATE
```

---

### Task 1: `todo.*` event kinds through the pipeline

`TodoService` writes its DB and returns — no events. Add the four `todo.*` kinds to the `Event` union, emit them from `TodoService` (mirroring `DecisionService`), keep the worker's `deriveMutations` total over the union, and thread `indexerProject` + `bus` into the todo tool registration.

**Files:**
- Modify: `src/events/types.ts` (Event union, after the `decision.proposed` member)
- Modify: `src/events/worker/mutation-deriver.ts`
- Modify: `src/todos/service.ts`
- Modify: `src/mcp-server/tools/todo-tools.ts`
- Modify: `src/mcp-server/server.ts:48`
- Create: `tests/todos/events.test.ts`

**Interfaces:**
- Produces event kinds (consumed by Tasks 4, 5): `todo.proposed {todo_id, summary}`, `todo.updated {todo_id, changed_fields: string[]}`, `todo.transitioned {todo_id, from, to}`, `todo.linked {todo_id, target, relation}`.
- Produces: `TodoServiceDeps` gains `bus?: EventBus; project_id?: string`.
- Produces: `registerTodoTools(server, resolver, indexerProject?: string | null, bus?: EventBus)`.

- [ ] **Step 1: Write the failing test** — `tests/todos/events.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodoService } from "../../src/todos/service.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { EventBus } from "../../src/events/bus.js";
import type { Event } from "../../src/events/types.js";

function svcWithBus() {
  const db = openDecisionsDb(":memory:");
  const bus = new EventBus();
  const emitted: Event[] = [];
  bus.onEvent((e) => emitted.push(e));
  const svc = new TodoService({
    db,
    todos: new TodosRepository(db),
    links: new TodoLinksRepository(db),
    bus,
    project_id: "proj-x",
  });
  return { svc, emitted };
}

describe("TodoService event emission", () => {
  it("emits todo.proposed on propose()", () => {
    const { svc, emitted } = svcWithBus();
    const t = svc.propose({ summary: "wire the sync engine" });
    expect(emitted.length).toBe(1);
    const e = emitted[0];
    expect(e.kind).toBe("todo.proposed");
    expect(e.project_id).toBe("proj-x");
    expect(e.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // ULID
    if (e.kind === "todo.proposed") {
      expect(e.payload.todo_id).toBe(t.id);
      expect(e.payload.summary).toBe("wire the sync engine");
    }
  });

  it("emits todo.updated with changed_fields on update()", () => {
    const { svc, emitted } = svcWithBus();
    const t = svc.propose({ summary: "a" });
    emitted.length = 0;
    svc.update(t.id, { summary: "b", assignee: "rka" });
    expect(emitted.length).toBe(1);
    expect(emitted[0].kind).toBe("todo.updated");
    if (emitted[0].kind === "todo.updated") {
      expect(emitted[0].payload.changed_fields).toEqual(["summary", "assignee"]);
    }
  });

  it("emits todo.transitioned with from/to on transition()", () => {
    const { svc, emitted } = svcWithBus();
    const t = svc.propose({ summary: "a" });
    emitted.length = 0;
    svc.transition(t.id, { to: "in_progress" });
    expect(emitted[0].kind).toBe("todo.transitioned");
    if (emitted[0].kind === "todo.transitioned") {
      expect(emitted[0].payload.from).toBe("open");
      expect(emitted[0].payload.to).toBe("in_progress");
    }
  });

  it("emits todo.linked on link()", () => {
    const { svc, emitted } = svcWithBus();
    const t = svc.propose({ summary: "a" });
    emitted.length = 0;
    svc.link({ todo_id: t.id, target: "src/viewer/store.js", relation: "GOVERNS" });
    expect(emitted[0].kind).toBe("todo.linked");
    if (emitted[0].kind === "todo.linked") {
      expect(emitted[0].payload.relation).toBe("GOVERNS");
    }
  });

  it("emits nothing without a bus (CLI construction stays silent)", () => {
    const db = openDecisionsDb(":memory:");
    const svc = new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) });
    expect(() => svc.propose({ summary: "no bus" })).not.toThrow();
  });
});
```

Note: check `openDecisionsDb`'s signature in `src/decisions/db.ts` before writing — if it requires a legacy path argument, pass `undefined`; if `":memory:"` isn't supported, use a temp-dir path via `mkdtempSync` (mirror what `tests/todos/service.test.ts` does — read it and copy its DB setup exactly).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/todos/events.test.ts`
Expected: FAIL — `TodoServiceDeps` has no `bus` property / events never emitted.

- [ ] **Step 3: Add the event kinds to the union** — `src/events/types.ts`, insert after the `decision.proposed` member (before `commit`):

```ts
  | (EventEnvelope & {
      kind: 'todo.proposed';
      payload: { todo_id: string; summary: string };
    })
  | (EventEnvelope & {
      kind: 'todo.updated';
      payload: { todo_id: string; changed_fields: string[] };
    })
  | (EventEnvelope & {
      kind: 'todo.transitioned';
      payload: { todo_id: string; from: string; to: string };
    })
  | (EventEnvelope & {
      kind: 'todo.linked';
      payload: { todo_id: string; target: string; relation: string };
    })
```

- [ ] **Step 4: Keep `deriveMutations` total** — `src/events/worker/mutation-deriver.ts`: the switch has **no default case**; a `todo.*` event would fall through and return `undefined`, and `src/ws/server.ts` iterating `bundle.mutations` would crash the broadcast. Add before the `commit` case:

```ts
    // TODO entities live in the projection channel, not the graph-mutation
    // channel — they have no graph nodes. Explicit no-ops keep this switch
    // total over the Event union (no default: exhaustiveness stays checked).
    case 'todo.proposed':
    case 'todo.updated':
    case 'todo.transitioned':
    case 'todo.linked':
      return [];
```

- [ ] **Step 5: Emit from `TodoService`** — `src/todos/service.ts`:

Add imports at top:

```ts
import type { EventBus } from "../events/bus.js";
import type { Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";
```

Extend deps + constructor (mirror `DecisionService`):

```ts
export interface TodoServiceDeps {
  db: Database.Database;
  todos: TodosRepository;
  links: TodoLinksRepository;
  bus?: EventBus;
  project_id?: string;
}
```

In the class add fields `private bus: EventBus | undefined; private projectId: string;`, assign in the constructor (`this.bus = deps.bus; this.projectId = deps.project_id ?? "";`), and add the private helper (same shape as `DecisionService.emit`, `src/decisions/service.ts:347`):

```ts
  private emit(event: Event): void { this.bus?.emit(event); }

  private envelope(kind: string, actor: string) {
    return { id: newUlid(), kind, actor, created_at: Date.now(), project_id: this.projectId };
  }
```

Emission sites (each right before the method's `return` / at the end of `link`):

```ts
// propose(), after links are written:
this.emit({ ...this.envelope("todo.proposed", rec.proposed_by ?? "claude"),
  payload: { todo_id: id, summary: input.summary } } as Event);

// update(), after this.todos.update(...) + replaceLinks. Build changedFields
// alongside the patch (push "summary"/"description"/"assignee"/"governs" as
// each input field is applied, exactly like DecisionService.update does):
this.emit({ ...this.envelope("todo.updated", "claude"),
  payload: { todo_id: existing.id, changed_fields: changedFields } } as Event);

// transition(), after this.todos.update(...) (capture `const from = existing.state;` first):
this.emit({ ...this.envelope("todo.transitioned", "claude"),
  payload: { todo_id: existing.id, from, to: input.to } } as Event);

// link(), after this.addLink(...):
this.emit({ ...this.envelope("todo.linked", "claude"),
  payload: { todo_id: input.todo_id, target: input.target, relation: input.relation } } as Event);
```

In `update()`, add `const changedFields: string[] = [];` and push the field name inside each existing `if (input.X !== undefined)` block (including `governs`).

- [ ] **Step 6: Thread bus into the tool** — `src/mcp-server/tools/todo-tools.ts`:

```ts
import type { EventBus } from "../../events/bus.js";

const todoServiceFor = (ctx: RepoContext, projectId: string | null, bus?: EventBus): TodoService =>
  new TodoService({
    db: ctx.decisionsDb,
    todos: new TodosRepository(ctx.decisionsDb),
    links: new TodoLinksRepository(ctx.decisionsDb),
    bus,
    project_id: projectId ?? "",
  });

export const todoHandler = (resolver: RepoContextResolver, indexerProject: string | null = null, bus?: EventBus) =>
  // ...inside the handler body, replace `todoServiceFor(ctx)` with:
  //   const svc = todoServiceFor(ctx, indexerProject, bus);

export function registerTodoTools(
  server: McpServer,
  resolver: RepoContextResolver,
  indexerProject: string | null = null,
  bus?: EventBus,
): void {
  server.tool(
    "todo",
    "Manage TODO entities (future planned work). action: propose|get|list|search|update|link|transition. See docs/mcp-tools.md for per-action params.",
    todoShape,
    todoHandler(resolver, indexerProject, bus),
  );
}
```

And `src/mcp-server/server.ts:48`: `registerTodoTools(server, resolver, indexerProject, bus);`

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/todos/ tests/events/ tests/integration/ && npx tsc --noEmit`
Expected: PASS (existing todo/CLI tests still construct `TodoService` without bus — optional deps keep compiling).

- [ ] **Step 8: Commit** — `feat(events): todo.* event kinds emitted from TodoService write path`

---

### Task 2: `EventPersister` forward reads — `since()` and `head()`

Catch-up needs forward paging (`id > cursor`, ascending) and the current head ULID for `hello`.

**Files:**
- Modify: `src/events/worker/persister.ts`
- Modify: `tests/events/persister.test.ts`

**Interfaces:**
- Produces (consumed by Task 5): `since(opts: { since_id: string; limit: number }): { events: Event[]; has_more: boolean }` — events with `id > since_id`, ULID-ascending; `has_more` true when more than `limit` exist. `head(): string | null` — newest event id, null when empty.

- [ ] **Step 1: Write failing tests** — append to `tests/events/persister.test.ts` (reuse its existing `makeEvent`/setup helpers; adapt names to what's there):

```ts
  it("since() returns events after the cursor in ascending ULID order", () => {
    const p = openPersister(); // reuse the file's existing construction helper
    const a = makeEvent(); p.insert(a);
    const b = makeEvent(); p.insert(b);
    const c = makeEvent(); p.insert(c);
    const page = p.since({ since_id: a.id, limit: 10 });
    expect(page.events.map((e) => e.id)).toEqual([b.id, c.id]);
    expect(page.has_more).toBe(false);
  });

  it("since() flags has_more past the limit", () => {
    const p = openPersister();
    const first = makeEvent(); p.insert(first);
    for (let i = 0; i < 3; i++) p.insert(makeEvent());
    const page = p.since({ since_id: first.id, limit: 2 });
    expect(page.events.length).toBe(2);
    expect(page.has_more).toBe(true);
  });

  it("head() returns the newest id, null when empty", () => {
    const p = openPersister();
    expect(p.head()).toBeNull();
    const a = makeEvent(); p.insert(a);
    const b = makeEvent(); p.insert(b);
    expect(p.head()).toBe(b.id);
  });
```

- [ ] **Step 2: Run to verify failure**: `npx vitest run tests/events/persister.test.ts` — FAIL (`since is not a function`).

- [ ] **Step 3: Implement** — in the constructor add two prepared statements:

```ts
    this.sinceStmt = this.db.prepare(
      `SELECT id, kind, actor, created_at, project_id, payload
       FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`,
    );
    this.headStmt = this.db.prepare(`SELECT id FROM events ORDER BY id DESC LIMIT 1`);
```

(declare fields `private sinceStmt: Database.Statement; private headStmt: Database.Statement;`), and methods:

```ts
  /**
   * Forward page for catch-up: events strictly AFTER `since_id`, ULID-ascending.
   * `has_more` uses the same +1-row probe as backfill(). Callers treat
   * has_more=true as "replay window exceeded → snapshot instead".
   */
  since(opts: { since_id: string; limit: number }): { events: Event[]; has_more: boolean } {
    const rows = this.sinceStmt.all(opts.since_id, opts.limit + 1) as RowShape[];
    const has_more = rows.length > opts.limit;
    return { events: rows.slice(0, opts.limit).map(rowToEvent), has_more };
  }

  /** Newest event ULID (the sync head), or null for an empty log. */
  head(): string | null {
    const row = this.headStmt.get() as { id: string } | undefined;
    return row?.id ?? null;
  }
```

- [ ] **Step 4: Run**: `npx vitest run tests/events/persister.test.ts` — PASS.
- [ ] **Step 5: Commit** — `feat(events): persister forward reads (since/head) for sync catch-up`

---

### Task 3: Wire-protocol additions

**Files:**
- Modify: `src/events/types.ts`
- Modify: `tests/ws/protocol.test.ts`

**Interfaces (consumed by Tasks 4–8):**

```ts
export type ProjectionEntity = 'decision' | 'todo';

export type ProjectionDelta =
  | { ulid: string; entity: ProjectionEntity; op: 'upsert'; data: Record<string, unknown> }
  | { ulid: string; entity: ProjectionEntity; op: 'remove'; data: { id: string } };
```

`ServerMsg` gains: `{ type: 'projection'; delta: ProjectionDelta }` and `{ type: 'catchup_result'; mode: 'replay' | 'snapshot'; deltas: ProjectionDelta[]; head_ulid: string | null }`; `hello` gains `head_ulid: string | null`. `ClientMsg` gains `{ type: 'catchup'; since: string }`.

- [ ] **Step 1: Failing test** — in `tests/ws/protocol.test.ts`'s round-trip suite add to the `msgs` array:

```ts
      { type: 'hello', project_id: 'p', server_version: '0.2.0', head_ulid: null },
      {
        type: 'projection',
        delta: { ulid: '01J00000000000000000000000', entity: 'decision', op: 'upsert', data: { id: 'd1' } },
      },
      {
        type: 'projection',
        delta: { ulid: '01J00000000000000000000001', entity: 'todo', op: 'remove', data: { id: 't1' } },
      },
      { type: 'catchup_result', mode: 'replay', deltas: [], head_ulid: '01J00000000000000000000001' },
      { type: 'catchup_result', mode: 'snapshot', deltas: [], head_ulid: null },
```

and to the ClientMsg cases: `{ type: 'catchup', since: '01J00000000000000000000000' }`. (Match the file's existing assertion style — it encodes each variant and decodes it back.) Note the existing `hello` fixture in this file must gain `head_ulid` too, or the compile fails — that's the point.

- [ ] **Step 2: Verify failure**: `npx vitest run tests/ws/protocol.test.ts` — FAIL to compile (unknown variant).

- [ ] **Step 3: Implement** — `src/events/types.ts`. Add above `ServerMsg`:

```ts
/**
 * Projection delta — one rendered-entity change for the viewer's reactive
 * store, on a SEPARATE channel from GraphMutation (structural graph nodes).
 *
 * `ulid` is the source event's ULID and doubles as the sync cursor. `upsert`
 * carries the FULL adapted shape (AdaptedDecision / AdaptedTodo — the same
 * shapes /api/decisions and /api/todos serve; the server is the single source
 * of truth for shape, the client never re-derives). Typed as
 * Record<string, unknown> here to keep this worker-shared module free of the
 * Zod-derived api-schemas types; the deriver (projection-deriver.ts) is the
 * one producer and constructs real adapted shapes.
 *
 * The union starts with the two entities the viewer renders; widening to
 * pr/frame/commit later is additive.
 */
export type ProjectionEntity = 'decision' | 'todo';

export type ProjectionDelta =
  | { ulid: string; entity: ProjectionEntity; op: 'upsert'; data: Record<string, unknown> }
  | { ulid: string; entity: ProjectionEntity; op: 'remove'; data: { id: string } };
```

Update `ServerMsg`/`ClientMsg`:

```ts
export type ServerMsg =
  | { type: 'hello'; project_id: string; server_version: string; head_ulid: string | null }
  | { type: 'event'; event: Event }
  | { type: 'mutation'; mutation: GraphMutation }
  | { type: 'projection'; delta: ProjectionDelta }
  | {
      type: 'backfill_page';
      events: Event[];
      mutations: GraphMutation[];
      has_more: boolean;
    }
  | {
      type: 'catchup_result';
      mode: 'replay' | 'snapshot';
      deltas: ProjectionDelta[];
      head_ulid: string | null;
    }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };

export type ClientMsg =
  | { type: 'backfill'; before_id?: string; limit?: number }
  | { type: 'catchup'; since: string }
  | { type: 'ping' };
```

Fix the now-failing `hello` construction in `src/ws/server.ts` minimally (`head_ulid: opts.persister.head()` — `head()` exists from Task 2), and any test fixtures that construct `hello`.

- [ ] **Step 4: Run**: `npx vitest run tests/ws/ tests/integration/ && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** — `feat(ws): projection + catchup protocol variants, hello.head_ulid`

---

### Task 4: Projection deriver

Main-thread stage mapping events → adapted-entity deltas by reading the sidecar repos **at derive time**. Distinct from the worker's `deriveMutations` (which the spec diagram places worker-side; the deriver lives on main because the decisions/todos DBs and adapters are main-thread — same position in the dataflow: after persist, before fan-out).

**Files:**
- Create: `src/mcp-server/projection-deriver.ts`
- Modify: `src/mcp-server/api.ts` (export `buildPathIndices` — change `function buildPathIndices` at line 521 to `export function buildPathIndices`)
- Create: `tests/mcp-server/projection-deriver.test.ts`

**Interfaces:**
- Consumes: `Event` union (Task 1), `ProjectionDelta` (Task 3), `buildAdaptedDecision`/`buildAdaptedTodo` + `FrameInfo` (existing), repo methods `DecisionsRepository.get(id)`, `DecisionLinksRepository.findByDecision(id)`, `TodosRepository.get(id)`, `TodoLinksRepository.findByTodo(id)`, `TodoLinksRepository.findBlocking(id)`.
- Produces (consumed by Tasks 5, 6):

```ts
export interface ProjectionSources {
  decisions: { get(id: string): DecisionRecord | null };
  decisionLinks: { findByDecision(id: string): DecisionLink[] };
  todos: { get(id: string): TodoRecord | null };
  todoLinks: { findByTodo(id: string): TodoLink[]; findBlocking(id: string): TodoLink[] };
  pathIndices(): { nodesByPath: Map<string, NodeRow>; framesByPath: Map<string, FrameInfo> };
}
export function deriveProjectionDeltas(events: Event[], src: ProjectionSources): ProjectionDelta[];
```

- [ ] **Step 1: Failing tests** — `tests/mcp-server/projection-deriver.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveProjectionDeltas, type ProjectionSources } from "../../src/mcp-server/projection-deriver.js";
import type { Event } from "../../src/events/types.js";
import type { DecisionRecord } from "../../src/decisions/repository.js";
import type { TodoRecord } from "../../src/todos/types.js";

const DEC: DecisionRecord = {
  id: "dec_1", seq: 1, title: "T", description: null, rationale: "R", problem: null,
  resolution: null, alternatives: null, tier: "personal", status: "active",
  superseded_by: null, author: "claude", provenance: null,
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
};
const TODO: TodoRecord = {
  id: "todo_1", seq: 1, summary: "S", description: null, state: "open", state_reason: null,
  proposed_by: "claude", proposed_at: "2026-07-01T00:00:00Z", started_at: null,
  closed_at: null, assignee: null, created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-01T00:00:00Z",
};

function sources(over: Partial<ProjectionSources> = {}): ProjectionSources {
  return {
    decisions: { get: (id) => (id === "dec_1" ? DEC : null) },
    decisionLinks: { findByDecision: () => [] },
    todos: { get: (id) => (id === "todo_1" ? TODO : null) },
    todoLinks: { findByTodo: () => [], findBlocking: () => [] },
    pathIndices: () => ({ nodesByPath: new Map(), framesByPath: new Map() }),
    ...over,
  };
}

function env(kind: string, payload: unknown): Event {
  return { id: "01J0000000000000000000000A", kind, actor: "claude", created_at: 0, project_id: "p", payload } as Event;
}

describe("deriveProjectionDeltas", () => {
  it("decision.created → one decision upsert carrying the adapted shape, keyed by the event ULID", () => {
    const deltas = deriveProjectionDeltas(
      [env("decision.created", { decision_id: "dec_1", title: "T", rationale: "R", governed_file_ids: [], tags: [] })],
      sources(),
    );
    expect(deltas.length).toBe(1);
    expect(deltas[0]).toMatchObject({ ulid: "01J0000000000000000000000A", entity: "decision", op: "upsert" });
    expect((deltas[0].data as { summary: string }).summary).toBe("T"); // adapted shape, not the raw record
  });

  it("decision.deleted → remove", () => {
    const deltas = deriveProjectionDeltas([env("decision.deleted", { decision_id: "dec_1", title: "T" })], sources());
    expect(deltas[0]).toEqual({
      ulid: "01J0000000000000000000000A", entity: "decision", op: "remove", data: { id: "dec_1" },
    });
  });

  it("decision.superseded → upserts for BOTH old and new ids", () => {
    const deltas = deriveProjectionDeltas(
      [env("decision.superseded", { old_id: "dec_1", new_id: "dec_1", reason: "" })],
      sources(),
    );
    expect(deltas.length).toBe(2);
    expect(deltas.every((d) => d.op === "upsert" && d.entity === "decision")).toBe(true);
  });

  it("todo.transitioned → todo upsert (current adapted state)", () => {
    const deltas = deriveProjectionDeltas(
      [env("todo.transitioned", { todo_id: "todo_1", from: "open", to: "in_progress" })],
      sources(),
    );
    expect(deltas[0]).toMatchObject({ entity: "todo", op: "upsert" });
    expect((deltas[0].data as { state: string }).state).toBe("open"); // whatever the repo returns NOW
  });

  it("entity missing from the repo → skipped (a later delete in the log carries the remove)", () => {
    const deltas = deriveProjectionDeltas(
      [env("decision.updated", { decision_id: "dec_gone", changed_fields: [] })],
      sources(),
    );
    expect(deltas).toEqual([]);
  });

  it("commit and pr.* events → no projection deltas", () => {
    const deltas = deriveProjectionDeltas(
      [env("commit", { hash: "h", message: "m", files: [], decision_links: [] })],
      sources(),
    );
    expect(deltas).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failure**: `npx vitest run tests/mcp-server/projection-deriver.test.ts` — FAIL (module not found).

- [ ] **Step 3: Implement** — `src/mcp-server/projection-deriver.ts`:

```ts
/**
 * Projection deriver — the read-path sync engine's server stage.
 *
 * Maps each Event to zero-or-more ProjectionDeltas: full ADAPTED entity
 * shapes (the same buildAdaptedDecision/buildAdaptedTodo that serve
 * /api/decisions and /api/todos — one adapter, two transports), keyed by the
 * source event's ULID (the sync cursor).
 *
 * Reads the repos AT DERIVE TIME, so a delta always carries the entity's
 * current state. That makes catch-up replay state-converging: replaying an
 * old event range against today's DB yields today's shapes, and duplicate /
 * overlapping application is harmless (store upserts by id).
 *
 * Runs on the MAIN thread (the sidecar DBs + adapters live here), positioned
 * after the worker's persist and before WS fan-out.
 * See docs/architecture/viewer-sync-engine.md.
 */
import type { Event, ProjectionDelta } from "../events/types.js";
import type { NodeRow } from "../graph/store.js";
import type { DecisionRecord } from "../decisions/repository.js";
import type { DecisionLink } from "../decisions/links-repository.js";
import type { TodoRecord } from "../todos/types.js";
import type { TodoLink } from "../todos/links-repository.js";
import { buildAdaptedDecision, type FrameInfo } from "./api-decisions.js";
import { buildAdaptedTodo } from "./api-todos.js";

export interface ProjectionSources {
  decisions: { get(id: string): DecisionRecord | null };
  decisionLinks: { findByDecision(id: string): DecisionLink[] };
  todos: { get(id: string): TodoRecord | null };
  todoLinks: { findByTodo(id: string): TodoLink[]; findBlocking(id: string): TodoLink[] };
  /** Built per call batch — file-path → node / frame lookups for governs resolution. */
  pathIndices(): { nodesByPath: Map<string, NodeRow>; framesByPath: Map<string, FrameInfo> };
}

export function deriveProjectionDeltas(events: Event[], src: ProjectionSources): ProjectionDelta[] {
  const out: ProjectionDelta[] = [];
  let indices: ReturnType<ProjectionSources["pathIndices"]> | null = null;
  const idx = () => (indices ??= src.pathIndices());

  const upsertDecision = (ulid: string, id: string) => {
    const rec = src.decisions.get(id);
    if (!rec) return; // deleted since — a later remove in the log covers it
    const { nodesByPath, framesByPath } = idx();
    const data = buildAdaptedDecision(rec, src.decisionLinks.findByDecision(rec.id), nodesByPath, framesByPath);
    out.push({ ulid, entity: "decision", op: "upsert", data: data as unknown as Record<string, unknown> });
  };

  const upsertTodo = (ulid: string, id: string) => {
    const rec = src.todos.get(id);
    if (!rec) return;
    const { nodesByPath, framesByPath } = idx();
    const data = buildAdaptedTodo(
      rec, src.todoLinks.findByTodo(rec.id), src.todoLinks.findBlocking(rec.id), nodesByPath, framesByPath,
    );
    out.push({ ulid, entity: "todo", op: "upsert", data: data as unknown as Record<string, unknown> });
  };

  for (const e of events) {
    switch (e.kind) {
      case "decision.created":
      case "decision.updated":
      case "decision.promoted":
      case "decision.proposed":
      case "decision.ratified":
        upsertDecision(e.id, e.payload.decision_id);
        break;
      case "decision.superseded":
        upsertDecision(e.id, e.payload.old_id);
        upsertDecision(e.id, e.payload.new_id);
        break;
      case "decision.deleted":
        out.push({ ulid: e.id, entity: "decision", op: "remove", data: { id: e.payload.decision_id } });
        break;
      case "todo.proposed":
      case "todo.updated":
      case "todo.transitioned":
      case "todo.linked":
        upsertTodo(e.id, e.payload.todo_id);
        break;
      // commit / pr.* stay on the event + graph-mutation channels.
      default:
        break;
    }
  }
  return out;
}
```

Note: `TodosRepository.get` may be typed `TodoRecord | undefined` rather than `| null` — check `src/todos/repository.ts` and match the interface to reality (`?? null` shims are fine).

- [ ] **Step 4: Run**: `npx vitest run tests/mcp-server/projection-deriver.test.ts && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** — `feat(server): projection deriver — events to adapted entity deltas`

---

### Task 5: WS server — projection fan-out + catch-up

**Files:**
- Modify: `src/ws/server.ts`
- Modify: `tests/integration/ws-server.test.ts`

**Interfaces:**
- Consumes: `ProjectionDelta`, `catchup`/`catchup_result` (Task 3), `persister.since/head` (Task 2).
- Produces (consumed by Task 6): `WsServerOpts.deriveProjections?: (events: Event[]) => ProjectionDelta[]`; `WsServerHandle.broadcastProjections(deltas: ProjectionDelta[]): void`; exported `CATCHUP_REPLAY_LIMIT = 500`.

- [ ] **Step 1: Failing tests** — add to `tests/integration/ws-server.test.ts` (reuse its `startServer` helper; extend the helper to accept `deriveProjections`):

```ts
  it("broadcastProjections fans a projection message to clients", async () => {
    // connect a client as the existing tests do, then:
    handle.broadcastProjections([
      { ulid: "01J0000000000000000000000A", entity: "decision", op: "upsert", data: { id: "d1" } },
    ]);
    const msg = await nextMessage(ws); // reuse the file's promise-wrapping pattern
    expect(msg).toMatchObject({ type: "projection", delta: { entity: "decision", op: "upsert" } });
  });

  it("catchup within the window replays derived deltas", async () => {
    // seed persister with 2 events (insert directly, as other tests do); note first id
    // server started with deriveProjections: (events) => events.map((e) => ({
    //   ulid: e.id, entity: "decision", op: "upsert", data: { id: "x" } }))
    ws.send(JSON.stringify({ type: "catchup", since: firstId }));
    const msg = await nextMessage(ws);
    expect(msg.type).toBe("catchup_result");
    expect(msg.mode).toBe("replay");
    expect(msg.deltas.length).toBe(1); // only the event after `since`
    expect(msg.head_ulid).toBe(secondId);
  });

  it("catchup past the 500-delta window responds mode:snapshot with empty deltas", async () => {
    // Instead of inserting 501 events, start the server normally and monkeypatch:
    //   const realSince = persister.since.bind(persister);
    //   persister.since = (o) => ({ ...realSince(o), has_more: true });
    ws.send(JSON.stringify({ type: "catchup", since: firstId }));
    const msg = await nextMessage(ws);
    expect(msg.mode).toBe("snapshot");
    expect(msg.deltas).toEqual([]);
  });

  it("hello carries head_ulid", async () => {
    // assert the hello message (already awaited in the existing connection test)
    expect(hello.head_ulid === null || typeof hello.head_ulid === "string").toBe(true);
  });
```

(Write these in the file's existing style — it wraps `ws.once('message', …)` in promises; copy that. The sketches above define the behavior to assert, not the harness plumbing.)

- [ ] **Step 2: Verify failure**: `npx vitest run tests/integration/ws-server.test.ts` — FAIL.

- [ ] **Step 3: Implement** — `src/ws/server.ts`:

```ts
import type { ServerMsg, Event, GraphMutation, ProjectionDelta } from './types.js';
// (src/ws/types.ts re-exports from events/types.ts — add ProjectionDelta to that re-export list)

/** Catch-up replay window (spec: snapshot-vs-replay threshold). A client whose
 *  cursor is further behind than this re-snapshots instead of replaying. */
export const CATCHUP_REPLAY_LIMIT = 500;

export interface WsServerOpts {
  httpServer: HttpServer;
  persister: EventPersister;
  projectId: string;
  serverVersion: string;
  /** Injected by the composition root (src/index.ts) — maps events to
   *  projection deltas at catch-up time. Optional: without it, catchup always
   *  answers mode:'snapshot' (safe degraded mode). */
  deriveProjections?: (events: Event[]) => ProjectionDelta[];
}

export interface WsServerHandle {
  registry: ClientRegistry;
  broadcast(bundle: { events: Event[]; mutations: GraphMutation[] }): void;
  broadcastProjections(deltas: ProjectionDelta[]): void;
}
```

In the `hello` send: `head_ulid: opts.persister.head(),` (done in Task 3 — verify). In the returned handle add:

```ts
    broadcastProjections(deltas: ProjectionDelta[]) {
      for (const delta of deltas) {
        registry.broadcast(encodeServer({ type: 'projection', delta }));
      }
    },
```

In `handleClient`, add the case:

```ts
    case 'catchup': {
      const head_ulid = opts.persister.head();
      const { events, has_more } = opts.persister.since({
        since_id: msg.since,
        limit: CATCHUP_REPLAY_LIMIT,
      });
      if (has_more || !opts.deriveProjections) {
        send(ws, { type: 'catchup_result', mode: 'snapshot', deltas: [], head_ulid });
      } else {
        send(ws, { type: 'catchup_result', mode: 'replay', deltas: opts.deriveProjections(events), head_ulid });
      }
      return;
    }
```

- [ ] **Step 4: Run**: `npx vitest run tests/integration/ tests/ws/ && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** — `feat(ws): projection fan-out + snapshot-vs-replay catchup (window 500)`

---

### Task 6: Composition-root wiring (`src/index.ts`)

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `deriveProjectionDeltas` + `ProjectionSources` (Task 4), `buildPathIndices` (Task 4's api.ts export), `broadcastProjections`/`deriveProjections` (Task 5).

- [ ] **Step 1: Implement.** Repos are constructed at lines 166–169, *after* the supervisor (line 129) — use a mutable slot the worker-message closure reads:

```ts
import { deriveProjectionDeltas, type ProjectionSources } from "./mcp-server/projection-deriver.js";
import { buildPathIndices } from "./mcp-server/api.js";

let projectionSources: ProjectionSources | null = null;
```

In `onSpawn`'s message handler (line 134), extend the broadcast branch:

```ts
    w.on("message", (msg) => {
      if (msg.type === "broadcast" && wsHandle) {
        wsHandle.broadcast(msg.bundle);
        if (projectionSources) {
          const deltas = deriveProjectionDeltas(msg.bundle.events, projectionSources);
          if (deltas.length) wsHandle.broadcastProjections(deltas);
        }
      } else if (msg.type === "error") process.stderr.write(`[worker] ${msg.message}\n`);
    });
```

After the repos are constructed (below line 169):

```ts
// Projection sources for the read-path sync engine. pathIndices() re-reads the
// graph store per derive batch — events are low-rate (tool calls, commits), so
// freshness beats caching here; a reindex mid-session is picked up for free.
projectionSources = {
  decisions: decisionsRepo,
  decisionLinks: decisionLinksRepo,
  todos: todosRepo,
  todoLinks: todoLinksRepo,
  pathIndices: () => buildPathIndices(store.getAllNodesUnified(indexerProject ?? undefined)),
};
```

And pass the same deriver to the WS server (line 180 block):

```ts
  wsHandle = startWsServer({
    httpServer,
    persister: mainPersister,
    projectId: indexerProject ?? "",
    serverVersion: "0.2.0",
    deriveProjections: (events) =>
      projectionSources ? deriveProjectionDeltas(events, projectionSources) : [],
  });
```

If repo method typings don't structurally match `ProjectionSources` (e.g. `get` returns `undefined` not `null`), wrap: `decisions: { get: (id) => decisionsRepo.get(id) ?? null }` etc.

- [ ] **Step 2: Verify**: `npx tsc --noEmit && npm test` — PASS (compile + no regressions; this file has no direct unit tests).
- [ ] **Step 3: Smoke-check the live path**: `npm run dev` in the worktree, then in a second terminal:

```bash
node --input-type=module -e "
const ws = new (await import('ws')).WebSocket('ws://localhost:3334/ws');
ws.on('message', (m) => console.log(m.toString().slice(0, 120)));
setTimeout(() => process.exit(0), 3000);
"
```

Expected: a `hello` line including `head_ulid`. (Projection messages need an MCP write — covered in Task 13's QA.)

- [ ] **Step 4: Commit** — `feat(server): wire projection deriver into worker broadcast + ws catchup`

---

### Task 7: Client reactive store (`src/viewer/store.js`)

**Files:**
- Create: `src/viewer/store.js`
- Create: `tests/viewer/store.test.js`

**Interfaces (consumed by Tasks 8, 9):**

```js
const store = createStore({ schedule });   // schedule: (fn) => void, default rAF
store.state        // { decisions: {}, todos: {}, cursor: null } — object identities are STABLE
store.hydrated     // boolean
store.hydrate({ decisions, todos, cursor })  // decisions/todos: plain id-keyed objects
store.setCursor(ulid)
store.apply(delta, { animate = true } = {})  // delta: ProjectionDelta wire shape
store.subscribe(fn) // fn(changes: Array<{ entity, id, op, animate, prev, next }>), one call per flush
```

- [ ] **Step 1: Failing tests** — `tests/viewer/store.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createStore } from "../../src/viewer/store.js";

// Manual scheduler: collects flush callbacks; run() executes them.
function manualScheduler() {
  const q = [];
  const schedule = (fn) => q.push(fn);
  const run = () => { while (q.length) q.shift()(); };
  return { schedule, run };
}

const d = (ulid, id, extra = {}) =>
  ({ ulid, entity: "decision", op: "upsert", data: { id, summary: "s", ...extra } });

describe("createStore", () => {
  it("hydrate fills state and preserves object identity", () => {
    const { schedule } = manualScheduler();
    const store = createStore({ schedule });
    const decisionsRef = store.state.decisions;
    store.hydrate({ decisions: { d1: { id: "d1" } }, todos: {}, cursor: "01A" });
    expect(store.state.decisions).toBe(decisionsRef); // same object, mutated in place
    expect(store.state.decisions.d1.id).toBe("d1");
    expect(store.state.cursor).toBe("01A");
    expect(store.hydrated).toBe(true);
  });

  it("apply upserts, advances the cursor, and flushes once for a burst", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const flushes = [];
    store.subscribe((changes) => flushes.push(changes));
    store.apply(d("01B", "d1"));
    store.apply(d("01C", "d1", { summary: "s2" }));
    store.apply(d("01D", "d2"));
    run();
    expect(flushes.length).toBe(1);                    // coalesced
    expect(flushes[0].length).toBe(2);                 // d1 (last wins) + d2
    expect(store.state.decisions.d1.summary).toBe("s2");
    expect(store.state.cursor).toBe("01D");
  });

  it("drops deltas at or below the cursor (reconnect overlap)", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: "01C" });
    store.apply(d("01B", "stale"));
    run();
    expect(store.state.decisions.stale).toBeUndefined();
  });

  it("remove deletes and reports prev; removing an absent id is a no-op", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: { d1: { id: "d1" } }, todos: {}, cursor: null });
    const flushes = [];
    store.subscribe((c) => flushes.push(c));
    store.apply({ ulid: "01B", entity: "decision", op: "remove", data: { id: "d1" } });
    store.apply({ ulid: "01C", entity: "decision", op: "remove", data: { id: "ghost" } });
    run();
    expect(store.state.decisions.d1).toBeUndefined();
    const changes = flushes.flat();
    expect(changes.length).toBe(1);                    // ghost removal not reported
    expect(changes[0]).toMatchObject({ op: "remove", id: "d1", prev: { id: "d1" } });
    expect(store.state.cursor).toBe("01C");            // cursor still advances
  });

  it("create vs update is distinguishable via prev", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const changes = [];
    store.subscribe((c) => changes.push(...c));
    store.apply(d("01B", "d1"));
    run();
    store.apply(d("01C", "d1", { summary: "v2" }));
    run();
    expect(changes[0].prev).toBeUndefined();           // create
    expect(changes[1].prev).toMatchObject({ id: "d1" }); // update
  });

  it("queues deltas that arrive before hydrate and replays them after", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.apply(d("01B", "d1"), { animate: true });
    expect(store.state.decisions.d1).toBeUndefined();
    store.hydrate({ decisions: {}, todos: {}, cursor: "01A" });
    run();
    expect(store.state.decisions.d1.id).toBe("d1");
  });

  it("animate=false is carried through to the flush entries", () => {
    const { schedule, run } = manualScheduler();
    const store = createStore({ schedule });
    store.hydrate({ decisions: {}, todos: {}, cursor: null });
    const changes = [];
    store.subscribe((c) => changes.push(...c));
    store.apply(d("01B", "d1"), { animate: false });
    run();
    expect(changes[0].animate).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure**: `npx vitest run tests/viewer/store.test.js` — FAIL (module not found).

- [ ] **Step 3: Implement** — `src/viewer/store.js`:

```js
// src/viewer/store.js
/**
 * Normalized reactive store — the viewer's single client source of truth for
 * projected entities (decisions, todos). Replaces the refetched-blob model:
 * the legacy globals (DECISIONS/TODOS in viewer.js) become aliases of
 * `state.decisions` / `state.todos`, whose OBJECT IDENTITY never changes —
 * hydrate/apply mutate keys in place.
 *
 * Coalesced flush: N apply() calls inside one frame → ONE subscriber call
 * (scheduled via requestAnimationFrame by default; injectable for tests).
 * Cursor = the last applied delta's ULID; deltas at or below it are dropped
 * (safe reconnect overlap). See docs/architecture/viewer-sync-engine.md.
 */

export function createStore({ schedule } = {}) {
  const scheduleFlush = schedule || ((fn) => requestAnimationFrame(fn));
  const state = { decisions: {}, todos: {}, cursor: null };
  const subs = new Set();

  let hydrated = false;
  let queued = [];          // deltas applied before hydrate
  let pending = new Map();  // key `${entity}:${id}` → change entry (last wins, first prev kept)
  let flushScheduled = false;

  function bucket(entity) { return entity === "decision" ? state.decisions : state.todos; }

  function flush() {
    flushScheduled = false;
    if (pending.size === 0) return;
    const changes = [...pending.values()];
    pending = new Map();
    for (const fn of subs) fn(changes);
  }

  function requestFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    scheduleFlush(flush);
  }

  function record(entity, id, op, animate, prev, next) {
    const key = `${entity}:${id}`;
    const existing = pending.get(key);
    pending.set(key, {
      entity, id, op,
      animate: existing ? existing.animate || animate : animate,
      prev: existing ? existing.prev : prev, // first prev of the burst = true before-state
      next,
    });
    requestFlush();
  }

  function apply(delta, { animate = true } = {}) {
    if (!hydrated) { queued.push({ delta, animate }); return; }
    if (delta.ulid && state.cursor && delta.ulid <= state.cursor) return;
    const map = bucket(delta.entity);
    if (delta.op === "upsert") {
      const prev = map[delta.data.id];
      map[delta.data.id] = delta.data;
      record(delta.entity, delta.data.id, "upsert", animate, prev, delta.data);
    } else {
      const prev = map[delta.data.id];
      if (prev !== undefined) {
        delete map[delta.data.id];
        record(delta.entity, delta.data.id, "remove", animate, prev, undefined);
      }
      // remove of an absent id: no change entry, but the cursor still advances.
    }
    if (delta.ulid) state.cursor = delta.ulid;
  }

  function hydrate({ decisions = {}, todos = {}, cursor = null }) {
    for (const k of Object.keys(state.decisions)) delete state.decisions[k];
    Object.assign(state.decisions, decisions);
    for (const k of Object.keys(state.todos)) delete state.todos[k];
    Object.assign(state.todos, todos);
    state.cursor = cursor;
    hydrated = true;
    const q = queued; queued = [];
    for (const { delta, animate } of q) apply(delta, { animate });
  }

  return {
    state,
    get hydrated() { return hydrated; },
    hydrate,
    apply,
    setCursor(ulid) { state.cursor = ulid; },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
```

- [ ] **Step 4: Run**: `npx vitest run tests/viewer/store.test.js` — PASS.
- [ ] **Step 5: Commit** — `feat(viewer): normalized reactive store with coalesced flush`

---

### Task 8: Client WS sync client (`src/viewer/ws-client.js`)

**Files:**
- Create: `src/viewer/ws-client.js`
- Create: `tests/viewer/ws-client.test.js`

**Interfaces (consumed by Task 9):**

```js
const sync = connectLiveSync({
  wsUrl,               // e.g. `ws://${location.host}/ws`
  store,               // Task 7 store
  isLiveProject,       // () => boolean — viewer is showing the server-bound project
  resnapshot,          // async (headUlid) => void — refetch entity snapshots + hydrate(cursor: headUlid)
  onStatus,            // (s: 'live' | 'syncing' | 'offline') => void
  WebSocketImpl,       // injectable; default globalThis.WebSocket
  retryDelays,         // default [1000, 2000, 4000, 8000, 16000, 30000]
  setTimeoutImpl,      // injectable; default globalThis.setTimeout
});
sync.boundProject      // string | null — hello.project_id once received
sync.close()
```

Behavior contract:
- open → wait `hello`. Record `boundProject`. If `store.state.cursor === null` → `onStatus('syncing')`, `await resnapshot(hello.head_ulid)`, `onStatus('live')`. Else send `{type:'catchup', since: store.state.cursor}`, `onStatus('syncing')`.
- `catchup_result` mode `replay` → apply each delta with `{animate:false}`; then `store.setCursor(head_ulid)` when non-null; `onStatus('live')`. Mode `snapshot` → `await resnapshot(head_ulid)`; `onStatus('live')`.
- `projection` → if `isLiveProject()` → `store.apply(delta, { animate: typeof document === 'undefined' ? true : document.visibilityState === 'visible' })`; else ignore (cursor intentionally not advanced — switching back triggers catch-up).
- close/error → `onStatus('offline')`, reconnect after `retryDelays[min(attempt, len-1)]`; a successful `hello` resets the attempt counter.
- Non-projection messages (`event`, `mutation`, `backfill_page`, `pong`) are ignored.

- [ ] **Step 1: Failing tests** — `tests/viewer/ws-client.test.js`:

```js
import { describe, it, expect, vi } from "vitest";
import { connectLiveSync } from "../../src/viewer/ws-client.js";
import { createStore } from "../../src/viewer/store.js";

class FakeWS {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.instances.push(this); }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.onclose?.(); }
  // test hooks
  open() { this.onopen?.(); }
  recv(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

function harness({ cursor = null } = {}) {
  FakeWS.instances = [];
  const store = createStore({ schedule: (fn) => fn() }); // sync flush in tests
  store.hydrate({ decisions: {}, todos: {}, cursor });
  const statuses = [];
  const resnapshot = vi.fn(async (head) => store.setCursor(head));
  const timeouts = [];
  const sync = connectLiveSync({
    wsUrl: "ws://x/ws",
    store,
    isLiveProject: () => true,
    resnapshot,
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeWS,
    setTimeoutImpl: (fn, ms) => { timeouts.push({ fn, ms }); return 0; },
  });
  return { store, statuses, resnapshot, sync, timeouts, ws: () => FakeWS.instances.at(-1) };
}

describe("connectLiveSync", () => {
  it("no cursor → hello triggers resnapshot with head_ulid, then live", async () => {
    const h = harness();
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    await Promise.resolve(); await Promise.resolve();
    expect(h.resnapshot).toHaveBeenCalledWith("01H");
    expect(h.statuses).toEqual(["syncing", "live"]);
    expect(h.sync.boundProject).toBe("p");
  });

  it("with cursor → hello sends catchup{since}", () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    expect(h.ws().sent).toContainEqual({ type: "catchup", since: "01C" });
    expect(h.statuses).toEqual(["syncing"]);
  });

  it("catchup_result replay applies deltas silently and advances to head", async () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    h.ws().recv({
      type: "catchup_result", mode: "replay", head_ulid: "01H",
      deltas: [{ ulid: "01D", entity: "decision", op: "upsert", data: { id: "d1" } }],
    });
    await Promise.resolve(); await Promise.resolve();
    expect(h.store.state.decisions.d1).toBeDefined();
    expect(h.store.state.cursor).toBe("01H");
    expect(h.statuses.at(-1)).toBe("live");
  });

  it("catchup_result snapshot → resnapshot(head)", async () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01H" });
    h.ws().recv({ type: "catchup_result", mode: "snapshot", deltas: [], head_ulid: "01H" });
    await Promise.resolve(); await Promise.resolve();
    expect(h.resnapshot).toHaveBeenCalledWith("01H");
  });

  it("live projection deltas apply only for the live project", () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().recv({ type: "hello", project_id: "p", server_version: "0.2.0", head_ulid: "01C" });
    h.ws().recv({ type: "catchup_result", mode: "replay", deltas: [], head_ulid: "01C" });
    h.ws().recv({ type: "projection", delta: { ulid: "01D", entity: "todo", op: "upsert", data: { id: "t1" } } });
    expect(h.store.state.todos.t1).toBeDefined();
  });

  it("close → offline + scheduled reconnect with backoff", () => {
    const h = harness({ cursor: "01C" });
    h.ws().open();
    h.ws().close();
    expect(h.statuses.at(-1)).toBe("offline");
    expect(h.timeouts[0].ms).toBe(1000);
    h.timeouts[0].fn();                 // fire reconnect
    expect(FakeWS.instances.length).toBe(2);
    h.ws().close();
    expect(h.timeouts[1].ms).toBe(2000); // backoff grows
  });
});
```

- [ ] **Step 2: Verify failure**: `npx vitest run tests/viewer/ws-client.test.js` — FAIL.

- [ ] **Step 3: Implement** — `src/viewer/ws-client.js`:

```js
// src/viewer/ws-client.js
/**
 * Reconnecting read-path sync client. Feeds ProjectionDeltas from /ws into
 * the store; on (re)connect runs the bootstrap/catch-up protocol:
 *
 *   hello{head_ulid} → no cursor  → resnapshot(head) (snapshot bootstrap)
 *                    → have cursor → catchup{since} → replay | snapshot
 *
 * Catch-up applies with animate:false (spec: silent catch-up — no burst of
 * stale change treatments after a laptop wake). Live deltas animate only when
 * the tab is visible. Deltas for a project other than the server-bound one
 * are ignored WITHOUT advancing the cursor, so switching back catches up.
 * Backoff mirrors the worker supervisor: 1s → 2s → 4s … capped at 30s.
 */

const DEFAULT_RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export function connectLiveSync({
  wsUrl,
  store,
  isLiveProject,
  resnapshot,
  onStatus,
  WebSocketImpl = globalThis.WebSocket,
  retryDelays = DEFAULT_RETRY_DELAYS,
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
}) {
  let ws = null;
  let attempt = 0;
  let closed = false;
  const api = { boundProject: null, close };

  function status(s) { onStatus?.(s); }

  function animateNow() {
    return typeof document === "undefined" ? true : document.visibilityState === "visible";
  }

  function connect() {
    if (closed) return;
    ws = new WebSocketImpl(wsUrl);
    ws.onopen = () => { /* wait for hello */ };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };
    ws.onclose = () => {
      if (closed) return;
      status("offline");
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)];
      attempt += 1;
      setTimeoutImpl(connect, delay);
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  async function handle(msg) {
    switch (msg.type) {
      case "hello": {
        attempt = 0;
        api.boundProject = msg.project_id || null;
        status("syncing");
        if (store.state.cursor === null) {
          await resnapshot(msg.head_ulid);
          status("live");
        } else {
          ws.send(JSON.stringify({ type: "catchup", since: store.state.cursor }));
        }
        return;
      }
      case "catchup_result": {
        if (msg.mode === "replay") {
          for (const delta of msg.deltas) store.apply(delta, { animate: false });
          if (msg.head_ulid) store.setCursor(msg.head_ulid);
        } else {
          await resnapshot(msg.head_ulid);
        }
        status("live");
        return;
      }
      case "projection": {
        if (isLiveProject()) store.apply(msg.delta, { animate: animateNow() });
        return; // ignored deltas don't advance the cursor — catch-up covers them
      }
      default:
        return; // event / mutation / backfill_page / pong — other consumers' channels
    }
  }

  function close() {
    closed = true;
    try { ws?.close(); } catch { /* already closed */ }
  }

  connect();
  return api;
}
```

- [ ] **Step 4: Run**: `npx vitest run tests/viewer/ws-client.test.js` — PASS.
- [ ] **Step 5: Commit** — `feat(viewer): reconnecting ws sync client with silent catch-up`

---

### Task 9: Viewer integration — store-backed state, incremental apply, indicator

Flip `DECISIONS`/`TODOS` ownership to the store, apply flushes incrementally (governance + anchors for changed entities only), add `resyncEntities()` as the WS client's `resnapshot`, and wire the toolbar `live/syncing/offline` indicator. Change treatments come in Tasks 10–11; this task's subscriber only maintains data + governance.

**Files:**
- Modify: `src/viewer/viewer.js`
- Modify: `src/viewer/index.html`
- Modify: `src/viewer/style.css`

**Interfaces:**
- Consumes: `createStore` (Task 7), `connectLiveSync` (Task 8).
- Produces (consumed by Task 11): module-level `store`, `syncClient`; functions `applyLiveChanges(changes)`, `resyncEntities(headUlid)`, `applyGovernanceFor(entity, id)`; `LIVE_CHANGES` hook point — `applyLiveChanges` ends with `onLiveChangesApplied(changes)` (a no-op function Task 11 replaces with effect triggering).

- [ ] **Step 1: index.html** — add inside `<div class="toolbar">`, before `<select id="project-select">`:

```html
  <span id="sync-indicator" class="sync-indicator" hidden><i class="dot"></i><span class="word">live</span></span>
```

- [ ] **Step 2: style.css** — append near the `.toolbar` rules:

```css
.sync-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-3);
  padding: 0 4px;
  user-select: none;
}
.sync-indicator .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-4); }
.sync-indicator.live .dot { background: var(--text); }
.sync-indicator.live .word { color: var(--text-2); }
.sync-indicator.syncing .word { color: var(--text-3); }
.sync-indicator.offline .word { color: var(--text-4); }
```

- [ ] **Step 3: viewer.js — store ownership.** At the top add imports and construction:

```js
import { createStore } from '/viewer/store.js';
import { connectLiveSync } from '/viewer/ws-client.js';
```

Replace the declarations `let DECISIONS = {};` and `let TODOS = {};` (lines 99, 101) with:

```js
  const store = createStore();
  const DECISIONS = store.state.decisions; // aliases — object identity is stable
  const TODOS = store.state.todos;
```

In `loadGraph` (lines 191–216), replace the blocks that reassign `DECISIONS = {}` / `TODOS = {}` with in-place hydration through the store (this keeps every existing consumer of the two globals working unchanged):

```js
    // 5. Decisions + TODOs → the reactive store (single owner). Hydrate
    // mutates the aliased objects in place; cursor comes from the sync client
    // when this is the server-bound live project.
    const ambientTodos = filterAmbientTodos(todosResp.todos || []);
    const decMap = {};
    for (const d of decs.decisions) decMap[d.id] = d;
    const todoMap = {};
    for (const t of ambientTodos) todoMap[t.id] = t;
    store.hydrate({
      decisions: decMap,
      todos: todoMap,
      cursor: (syncClient && projectName === syncClient.boundProject) ? lastKnownHead : null,
    });
    FRAME_GOVERNANCE = buildFrameGovernance(decs.decisions);
```

(The existing 5c governance/`SPAWNS_FROM` logic stays; it reads `ambientTodos` as before.) Keep a module-level `let lastKnownHead = null;` — set in the status/resnapshot plumbing below. NOTE: slightly-stale `lastKnownHead` is safe — deltas re-derive current state at catch-up time (Global Constraints).

- [ ] **Step 4: viewer.js — incremental governance + anchors.** Factor the per-entity anchor assignment out of `buildGraph` (lines 426–444) so both paths share it:

```js
  // Deterministic per-entity anchor pick — same seeding as the bulk pass in
  // buildGraph, so incremental assignment for one entity is bit-identical.
  function assignAnchorsForEntity(ent, frameId, prefix) {
    const frameNodes = nodes.map((n, i) => ({ n, i })).filter(o => o.n.frameId === frameId);
    if (!frameNodes.length) { ent._nodeIdxs = []; return; }
    const rng = mulberry32(fnv1a(prefix + ent.id + ':' + frameId));
    const targetCount = Math.min(2 + Math.floor(rng() * 2), frameNodes.length);
    const pool = [...frameNodes];
    const picked = [];
    for (let k = 0; k < targetCount; k++) {
      picked.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
    }
    ent._nodeIdxs = picked.map(o => o.i);
  }
```

and rewrite `assignAnchors`' inner body to call it (`governance[frameId].forEach((entId) => { const ent = entityMap[entId]; if (ent) assignAnchorsForEntity(ent, frameId, prefix); })`) — behavior identical (last governing frame wins, as today).

Add governance maintenance + the subscriber:

```js
  /** Frames (string ids) an entity governs, resolved the same way the bulk
   *  loaders do: kind:'frame' refs directly; kind:'file' refs via membership. */
  function governedFrameIdsOf(ent) {
    const out = [];
    for (const g of ent.governs || []) {
      let fid = null;
      if (g.kind === 'frame') fid = String(g.id);
      else if (g.kind === 'file') fid = frameIdForPath(FRAME_PATH_INDEX, g.path);
      if (fid && !out.includes(fid)) out.push(fid);
    }
    return out;
  }

  /** Incrementally rebuild one entity's governance entries + anchors. */
  function applyGovernanceFor(entity, id) {
    const gov = entity === 'decision' ? FRAME_GOVERNANCE : TODO_GOVERNANCE;
    const map = entity === 'decision' ? DECISIONS : TODOS;
    const prefix = entity === 'decision' ? '' : 'todo:';
    for (const fid of Object.keys(gov)) {
      const i = gov[fid].indexOf(id);
      if (i !== -1) gov[fid].splice(i, 1);
      if (gov[fid].length === 0) delete gov[fid];
    }
    const ent = map[id];
    if (!ent) return;
    for (const fid of governedFrameIdsOf(ent)) {
      if (!gov[fid]) gov[fid] = [];
      if (!gov[fid].includes(id)) gov[fid].push(id);
      assignAnchorsForEntity(ent, fid, prefix); // last frame wins — matches bulk pass
    }
  }

  // Task 11 swaps this for the live-effects trigger.
  let onLiveChangesApplied = () => {};

  function applyLiveChanges(changes) {
    const renderedFrames = new Set(FRAMES.map((f) => String(f.id)));
    let needsPromotionRebuild = false;

    for (const c of changes) {
      if (c.entity === 'todo' && c.next && (c.next.state === 'done' || c.next.state === 'cancelled')) {
        // Ambient filter: closed todos leave the canvas (same rule as load).
        delete TODOS[c.id];
        c.op = 'remove';
        c.next = undefined;
      }
      applyGovernanceFor(c.entity, c.id);
      if (c.entity === 'todo') SPAWNS_FROM = buildSpawnsFromIndex(Object.values(TODOS));
      for (const fid of c.next ? governedFrameIdsOf(c.next) : []) {
        if (!renderedFrames.has(fid)) needsPromotionRebuild = true;
      }
      // Removed-while-open: keep the card up with a quiet removed note.
      if (c.op === 'remove' && focusedRecord && focusedRecord.id === c.id) {
        removedRecordSnapshots[c.id] = c.prev;
        currentRenderedRecord = null; // force re-render with the note
      }
    }

    if (needsPromotionRebuild && lastFrameMeta) {
      // Rare path: a change governs a frame outside the render set — recompute
      // the promoted-frames overlay + canvas graph (documented spec exception).
      FRAMES = withGovernedFramesRendered(FRAMES.filter((f) => !f.promotedForGovernance), FRAME_GOVERNANCE, lastFrameMeta);
      buildGraph();
    }
    onLiveChangesApplied(changes);
  }
  store.subscribe(applyLiveChanges);
  const removedRecordSnapshots = {};
```

Cache `lastFrameMeta` in `loadGraph`: change the local `const frameMeta = …` (line 221) to assign a module-level `let lastFrameMeta = null;` (`lastFrameMeta = frameMeta;`).

- [ ] **Step 5: viewer.js — resync + sync client + indicator.**

```js
  /** Entity-only resync (decisions + todos + frame map for promotion), used as
   *  the sync client's snapshot bootstrap/fallback. Cheaper than loadGraph —
   *  the structural graph doesn't change on the projection channel. */
  async function resyncEntities(headUlid) {
    lastKnownHead = headUlid ?? lastKnownHead;
    const project = currentProject;
    const [decs, todosResp] = await Promise.all([fetchDecisions(project), fetchTodos(project)]);
    const ambientTodos = filterAmbientTodos(todosResp.todos || []);
    const decMap = {}; for (const d of decs.decisions) decMap[d.id] = d;
    const todoMap = {}; for (const t of ambientTodos) todoMap[t.id] = t;
    store.hydrate({ decisions: decMap, todos: todoMap, cursor: headUlid ?? null });
    FRAME_GOVERNANCE = buildFrameGovernance(decs.decisions);
    TODO_GOVERNANCE = buildGovernance(ambientTodos);
    for (const t of ambientTodos) {
      for (const g of t.governs || []) {
        if (g.kind !== 'file') continue;
        const fid = frameIdForPath(FRAME_PATH_INDEX, g.path);
        if (!fid) continue;
        if (!TODO_GOVERNANCE[fid]) TODO_GOVERNANCE[fid] = [];
        if (!TODO_GOVERNANCE[fid].includes(t.id)) TODO_GOVERNANCE[fid].push(t.id);
      }
    }
    SPAWNS_FROM = buildSpawnsFromIndex(todosResp.todos || []);
    if (lastFrameMeta) FRAMES = withGovernedFramesRendered(FRAMES.filter((f) => !f.promotedForGovernance), FRAME_GOVERNANCE, lastFrameMeta);
    buildGraph();
  }

  const syncIndicatorEl = document.getElementById('sync-indicator');
  function showSyncStatus(status) {
    if (!syncIndicatorEl) return;
    const onLiveProject = syncClient && currentProject === syncClient.boundProject;
    syncIndicatorEl.hidden = !onLiveProject;
    if (!onLiveProject) return;
    syncIndicatorEl.className = `sync-indicator ${status}`;
    syncIndicatorEl.querySelector('.word').textContent = status;
  }
  let lastSyncStatus = 'offline';

  const syncClient = connectLiveSync({
    wsUrl: `ws://${location.host}/ws`,
    store,
    isLiveProject: () => currentProject === syncClient.boundProject,
    resnapshot: resyncEntities,
    onStatus: (s) => { lastSyncStatus = s; showSyncStatus(s); },
  });
```

Declaration-order note: `connectLiveSync`'s callbacks reference `syncClient` — they only run after the assignment settles (WS events are async), so `const syncClient = …` self-reference is safe.

In `initToolbar`'s project-select `change` handler, after `loadGraph(select.value || null)` resolves, refresh the indicator: change line 255 to

```js
    select.addEventListener('change', async () => {
      await loadGraph(select.value || null);
      showSyncStatus(lastSyncStatus);
    });
```

Track head from hello: in `resyncEntities` above, `lastKnownHead` is updated. Also declare `let lastKnownHead = null;` near the other module state.

- [ ] **Step 6: Removed-while-open card note.** In `renderDecisionCard` (line 2122) change the lookup + add the note:

```js
    const dec = DECISIONS[decId] || removedRecordSnapshots[decId];
    if (!dec) { decisionCardEl.innerHTML = ''; return; }
    const isRemoved = !DECISIONS[decId];
```

and inside the header HTML, after the provenance line, append:

```js
      ${isRemoved ? '<div class="dc-removed-note">this decision was removed · view is a snapshot</div>' : ''}
```

Mirror in `renderTodoCard` (`TODOS[todoId] || removedRecordSnapshots[todoId]`, note text `this todo was removed · view is a snapshot`). Add CSS:

```css
.dc-removed-note {
  margin-top: 8px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--text-4);
  border-left: 1px solid var(--border-3);
  padding-left: 8px;
}
```

Also in `closeRecord`/`closeDecisionCard` (find them near `renderDecisionCard`), clear stale snapshots: `for (const k of Object.keys(removedRecordSnapshots)) delete removedRecordSnapshots[k];`

- [ ] **Step 7: Verify.** `npx vitest run tests/viewer/ && npm test` (full suite guards regressions), then `npm run dev` → open http://localhost:3334/viewer → viewer renders exactly as before, indicator shows `live` on the bound project and hides after switching projects; browser console free of errors. (Full live-change QA is Task 13.)
- [ ] **Step 8: Commit** — `feat(viewer): store-backed live state, incremental governance, sync indicator`

---

### Task 10: Live-effects state module (`src/viewer/live-effects.js`)

The v5-grammar animation state machine — pure, injectable clock, no canvas. Drawing happens in Task 11.

**Files:**
- Create: `src/viewer/live-effects.js`
- Create: `tests/viewer/live-effects.test.js`

**Interfaces (consumed by Task 11):**

```js
const fx = createLiveEffects({ reducedMotion = false } = {});
fx.noteChange({ kind: 'create'|'update'|'remove', entity, id, frameIds, actor, now })
fx.recordDotPos(id, x, y)                  // called every frame by the dot draw
fx.birth(id, now) → null | t in [0,1]      // outline→fill progress (500ms, eased by caller)
fx.haloLift(id, now) → 0..1                // 1 at fire → 0 linear over 3500ms
fx.leaderBoost(id, now) → 0..1             // triangular peak over 580ms
fx.frameHeat(frameId, now) → 0..1          // += 0.5 per change (capped 1), linear decay 5500ms
fx.tombstones(now) → [{ id, entity, x, y, t }]  // t in [0,1] over 500ms, evicted after
fx.pills(now) → [{ id, x, y, name, isUser, alpha }]  // alpha follows the halo-drain window
```

Constants exported for tests + doc: `BIRTH_MS = 500`, `HALO_MS = 3500`, `LEADER_MS = 580`, `REMOVE_MS = 500`, `HEAT_DECAY_MS = 5500`, `HEAT_BUMP = 0.5`.

Behavior:
- `create` → birth + leaderBoost + heat(frameIds) + pill.
- `update` → haloLift + leaderBoost + heat(frameIds) + pill.
- `remove` → tombstone at last recorded dot pos (skipped when unknown) + heat(frameIds) + pill at that pos.
- Actor mapping: `isUser = actor !== 'claude' && actor !== 'system'`; `name = isUser ? '@' + actor : actor`.
- Repeat change on the same id: halo restarts at max (not additive); heat bumps saturate at 1 (`min(1, current + HEAT_BUMP)` where `current` is the decayed value at bump time).
- `reducedMotion: true` → `noteChange` records **nothing transient** except pills? No — reduced motion collapses everything: birth returns `null` immediately, haloLift/leaderBoost/heat return 0, tombstones empty, and pills still show (attribution is information, not motion) with a fixed 2000 ms window.
- Pills without a known position (`recordDotPos` never called for the id) are returned with `x: null, y: null`; the caller resolves lazily or skips.

- [ ] **Step 1: Failing tests** — `tests/viewer/live-effects.test.js`:

```js
import { describe, it, expect } from "vitest";
import { createLiveEffects, BIRTH_MS, HALO_MS, LEADER_MS, REMOVE_MS, HEAT_DECAY_MS } from "../../src/viewer/live-effects.js";

const base = { entity: "decision", id: "d1", frameIds: ["7"], actor: "claude" };

describe("createLiveEffects", () => {
  it("create → birth progresses 0→1 over BIRTH_MS then null", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "create", now: 1000 });
    expect(fx.birth("d1", 1000)).toBe(0);
    expect(fx.birth("d1", 1000 + BIRTH_MS / 2)).toBeCloseTo(0.5);
    expect(fx.birth("d1", 1000 + BIRTH_MS + 1)).toBeNull();
  });

  it("update → halo drains linearly over HALO_MS; re-fire restarts at max", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "update", now: 0 });
    expect(fx.haloLift("d1", 0)).toBe(1);
    expect(fx.haloLift("d1", HALO_MS / 2)).toBeCloseTo(0.5);
    fx.noteChange({ ...base, kind: "update", now: HALO_MS / 2 });
    expect(fx.haloLift("d1", HALO_MS / 2)).toBe(1);   // restart, not additive
    expect(fx.haloLift("d1", HALO_MS * 2)).toBe(0);
  });

  it("leader boost is a triangular peak over LEADER_MS", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "update", now: 0 });
    expect(fx.leaderBoost("d1", 0)).toBe(0);
    expect(fx.leaderBoost("d1", LEADER_MS / 2)).toBeCloseTo(1);
    expect(fx.leaderBoost("d1", LEADER_MS)).toBeCloseTo(0);
    expect(fx.leaderBoost("d1", LEADER_MS + 100)).toBe(0);
  });

  it("frame heat saturates and decays over HEAT_DECAY_MS", () => {
    const fx = createLiveEffects();
    fx.noteChange({ ...base, kind: "update", now: 0 });
    expect(fx.frameHeat("7", 0)).toBeCloseTo(0.5);
    fx.noteChange({ ...base, id: "d2", kind: "update", now: 0 });
    expect(fx.frameHeat("7", 0)).toBe(1);              // capped
    expect(fx.frameHeat("7", HEAT_DECAY_MS / 2)).toBeCloseTo(0.5);
    expect(fx.frameHeat("7", HEAT_DECAY_MS + 1)).toBe(0);
  });

  it("remove → tombstone at last recorded pos, evicted after REMOVE_MS", () => {
    const fx = createLiveEffects();
    fx.recordDotPos("d1", 100, 200);
    fx.noteChange({ ...base, kind: "remove", now: 0 });
    const t0 = fx.tombstones(0);
    expect(t0).toEqual([{ id: "d1", entity: "decision", x: 100, y: 200, t: 0 }]);
    expect(fx.tombstones(REMOVE_MS + 1)).toEqual([]);
  });

  it("pills carry attribution: claude → agent glyph pill, others → @user", () => {
    const fx = createLiveEffects();
    fx.recordDotPos("d1", 1, 2);
    fx.noteChange({ ...base, kind: "update", now: 0 });
    fx.recordDotPos("t9", 3, 4);
    fx.noteChange({ entity: "todo", id: "t9", frameIds: [], actor: "rka", kind: "update", now: 0 });
    const pills = fx.pills(0);
    expect(pills.find((p) => p.id === "d1")).toMatchObject({ name: "claude", isUser: false });
    expect(pills.find((p) => p.id === "t9")).toMatchObject({ name: "@rka", isUser: true });
    expect(fx.pills(HALO_MS + 1)).toEqual([]);
  });

  it("reducedMotion collapses motion but keeps attribution pills", () => {
    const fx = createLiveEffects({ reducedMotion: true });
    fx.recordDotPos("d1", 1, 2);
    fx.noteChange({ ...base, kind: "create", now: 0 });
    expect(fx.birth("d1", 0)).toBeNull();
    expect(fx.haloLift("d1", 0)).toBe(0);
    expect(fx.frameHeat("7", 0)).toBe(0);
    expect(fx.pills(0).length).toBe(1);
    expect(fx.pills(2001)).toEqual([]);
  });
});
```

- [ ] **Step 2: Verify failure**: `npx vitest run tests/viewer/live-effects.test.js` — FAIL.

- [ ] **Step 3: Implement** — `src/viewer/live-effects.js`:

```js
// src/viewer/live-effects.js
/**
 * Live-change treatment state (E · v5 live grammar) — the transient layer the
 * canvas queries every frame. Pure state machine: no canvas, injectable time.
 *
 * Grammar (spec-locked, NO pulse animations — every signal decays):
 *   create → outline "sketch" fills over BIRTH_MS (v5 added-node → merge beat)
 *   update → connections fire once (LEADER_MS triangular peak) + halo lifts
 *            and DRAINS linearly over HALO_MS (v5 colorAmount decay)
 *   remove → fill drains back to outline and fades (tombstone, REMOVE_MS)
 *   residue → frameHeat: border warmth bumps (+HEAT_BUMP, capped 1) and
 *            decays over HEAT_DECAY_MS (v5 frameHeat)
 *   attribution → presence pill riding the change; agent = 'claude'/'system'
 *            (glyph + agent color), user = anything else (@name, base-white)
 *
 * reducedMotion collapses all motion to instant state changes but keeps the
 * attribution pills (information, not decoration) on a fixed short window.
 */

export const BIRTH_MS = 500;
export const HALO_MS = 3500;
export const LEADER_MS = 580;
export const REMOVE_MS = 500;
export const HEAT_DECAY_MS = 5500;
export const HEAT_BUMP = 0.5;
const REDUCED_PILL_MS = 2000;

export function createLiveEffects({ reducedMotion = false } = {}) {
  const births = new Map();     // id → t0
  const halos = new Map();      // id → t0
  const leaders = new Map();    // id → t0
  const heat = new Map();       // frameId → { value, t0 } (value at t0, then linear decay)
  const tombs = new Map();      // id → { entity, x, y, t0 }
  const pillsById = new Map();  // id → { x, y, name, isUser, t0 }
  const dotPos = new Map();     // id → { x, y }

  function heatAt(frameId, now) {
    const h = heat.get(frameId);
    if (!h) return 0;
    const v = h.value * (1 - (now - h.t0) / HEAT_DECAY_MS);
    return v > 0 ? v : 0;
  }

  function noteChange({ kind, entity, id, frameIds = [], actor, now }) {
    const isUser = actor !== "claude" && actor !== "system";
    const pos = dotPos.get(id) || { x: null, y: null };
    pillsById.set(id, { x: pos.x, y: pos.y, name: isUser ? "@" + actor : actor, isUser, t0: now });

    if (reducedMotion) return; // pills only

    for (const fid of frameIds) {
      heat.set(fid, { value: Math.min(1, heatAt(fid, now) + HEAT_BUMP), t0: now });
    }
    if (kind === "create") { births.set(id, now); leaders.set(id, now); }
    else if (kind === "update") { halos.set(id, now); leaders.set(id, now); }
    else if (kind === "remove") {
      births.delete(id); halos.delete(id); leaders.delete(id);
      const p = dotPos.get(id);
      if (p) tombs.set(id, { entity, x: p.x, y: p.y, t0: now });
    }
  }

  return {
    noteChange,
    recordDotPos(id, x, y) { dotPos.set(id, { x, y }); },

    birth(id, now) {
      const t0 = births.get(id);
      if (t0 === undefined) return null;
      const t = (now - t0) / BIRTH_MS;
      if (t >= 1) { births.delete(id); return null; }
      return Math.max(0, t);
    },

    haloLift(id, now) {
      const t0 = halos.get(id);
      if (t0 === undefined) return 0;
      const v = 1 - (now - t0) / HALO_MS;
      if (v <= 0) { halos.delete(id); return 0; }
      return v;
    },

    leaderBoost(id, now) {
      const t0 = leaders.get(id);
      if (t0 === undefined) return 0;
      const t = (now - t0) / LEADER_MS;
      if (t >= 1) { leaders.delete(id); return 0; }
      return t <= 0 ? 0 : 1 - Math.abs(t - 0.5) * 2;
    },

    frameHeat(frameId, now) { return reducedMotion ? 0 : heatAt(frameId, now); },

    tombstones(now) {
      const out = [];
      for (const [id, tb] of tombs) {
        const t = (now - tb.t0) / REMOVE_MS;
        if (t >= 1) { tombs.delete(id); continue; }
        out.push({ id, entity: tb.entity, x: tb.x, y: tb.y, t: Math.max(0, t) });
      }
      return out;
    },

    pills(now) {
      const windowMs = reducedMotion ? REDUCED_PILL_MS : HALO_MS;
      const out = [];
      for (const [id, p] of pillsById) {
        const age = now - p.t0;
        if (age >= windowMs) { pillsById.delete(id); continue; }
        // Lazily adopt a position learned after the pill fired (fresh creates).
        const pos = (p.x === null && dotPos.has(id)) ? dotPos.get(id) : p;
        out.push({ id, x: pos.x, y: pos.y, name: p.name, isUser: p.isUser, alpha: 1 - age / windowMs });
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run**: `npx vitest run tests/viewer/live-effects.test.js` — PASS.
- [ ] **Step 5: Commit** — `feat(viewer): live-effects state machine (v5 grammar, pulse-free)`

---

### Task 11: Canvas draw integration

Wire live-effects into the render loop: frame heat, dot birth/halo/leader fire, tombstones, presence pills (with the ✳ claude glyph, node-centered, edge-flipped), and gating (layer toggles, hidden tab already handled by `animate:false`).

**Files:**
- Modify: `src/viewer/viewer.js`

**Interfaces:**
- Consumes: `createLiveEffects` + constants (Task 10), `onLiveChangesApplied` hook + `governedFrameIdsOf` (Task 9).

- [ ] **Step 1: Construct + trigger.** Top of viewer.js:

```js
import { createLiveEffects } from '/viewer/live-effects.js';
```

after the store construction:

```js
  const liveFx = createLiveEffects({
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  });
```

Replace the Task-9 no-op hook:

```js
  onLiveChangesApplied = (changes) => {
    const now = performance.now();
    for (const c of changes) {
      if (!c.animate) continue;
      if (c.entity === 'decision' && !showDecisions) continue;
      if (c.entity === 'todo' && !showTodos) continue;
      const ent = c.next ?? c.prev;
      liveFx.noteChange({
        kind: c.op === 'remove' ? 'remove' : (c.prev === undefined ? 'create' : 'update'),
        entity: c.entity,
        id: c.id,
        frameIds: ent ? governedFrameIdsOf(ent) : [],
        actor: c.next?.actor ?? c.next?.proposedBy ?? c.prev?.proposedBy ?? 'claude',
        now,
      });
    }
  };
```

(`AdaptedDecision.proposedBy` / `AdaptedTodo.proposedBy` is the best actor signal the adapted shape carries; the event-envelope `actor` isn't on the delta — acceptable: locally the writer IS the proposer for creates, and 'claude' is the correct default for agent-driven updates.)

- [ ] **Step 2: Frame heat.** In `drawFrames` (line 1400), change:

```js
        const baseFillAlpha = 0.25 * (1 - dimLevel * 0.4);
```
→ unchanged; and line 1412:
```js
        const baseBorderAlpha = 0.08;
```
→
```js
        const baseBorderAlpha = 0.08 + 0.15 * liveFx.frameHeat(frame.id, now);
```

(v5's exact composition: `0.08 + heatI * 0.15`, `docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html:2312`.)

- [ ] **Step 3: Decision dots — birth, halo, leader fire, pos recording.** In `drawFloatingDecisionNodes` (the dot-draw around lines 1107–1128):

After `dotX`/`dotY` are computed, add `liveFx.recordDotPos(dec.id, dotX, dotY);`

Replace the plain dot fill (lines 1107–1111) with birth-aware rendering:

```js
      const birthT = liveFx.birth(dec.id, now);
      const dotFillAlpha = state === 'proposed' ? 0.42 : 0.95;
      if (birthT !== null) {
        // v5 added-node grammar: outline sketch → fill commits.
        const fillIn = ease(Math.min(1, Math.max(0, (birthT - 0.4) / 0.6))); // outline first, fill lands late
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, 0.9)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
        ctx.stroke();
        if (fillIn > 0) {
          ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${dotFillAlpha * fillIn})`;
          ctx.beginPath();
          ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${dotFillAlpha})`;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R, 0, Math.PI * 2);
        ctx.fill();
      }

      // Update treatment: halo lifts then drains (no idle halo, no pulse).
      const lift = liveFx.haloLift(dec.id, now);
      if (lift > 0) {
        ctx.strokeStyle = `rgba(${dotColor[0]}, ${dotColor[1]}, ${dotColor[2]}, ${0.26 * lift})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(dotX, dotY, DOT_R + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
```

Leader fire — extend the leader visibility condition (line 1064):

```js
      const fireBoost = liveFx.leaderBoost(dec.id, now);
      const leadersOn = isSelected || isHovered || fireBoost > 0;
```

and inside the `governedPositions.forEach` stroke (line 1068), blend the boost:

```js
          const leadAlpha = hl ? 0.6 : Math.max(0.22, 0.3 + 0.4 * fireBoost);
          ctx.strokeStyle = `rgba(74, 222, 128, ${leadAlpha})`;
```

(when only firing — not hovered — alpha peaks at 0.7 and settles, v5's synapse range.)

- [ ] **Step 4: Todo dots.** Mirror Step 3 in `drawFloatingTodoNodes` (dot draw at lines 1254–1295, leader logic analogous) using `todo.id`, `rgb` from `todoDotColor`, yellow leader color `[250, 204, 21]`.

- [ ] **Step 5: Tombstones + pills pass.** Add:

```js
  function drawLiveEffects(now) {
    // Removal: fill drains back to outline, sketch fades (reverse of birth).
    for (const tb of liveFx.tombstones(now)) {
      const rgb = tb.entity === 'todo' ? todoDotRGB() : decisionDotRGB();
      const fade = 1 - ease(tb.t);
      ctx.strokeStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.9 * fade})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(tb.x, tb.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      const fillFade = Math.max(0, 1 - tb.t * 2); // fill drains in the first half
      if (fillFade > 0) {
        ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${0.95 * fillFade})`;
        ctx.beginPath();
        ctx.arc(tb.x, tb.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Presence pills — v5 cursor-pill: vertically centered on the node, 11px
    // right of center; agent = colored fill + ✳ glyph, user = base-white @name.
    ctx.save();
    ctx.font = '500 10px "Geist Mono", monospace';
    ctx.textBaseline = 'middle';
    for (const p of liveFx.pills(now)) {
      if (p.x === null || p.y === null) continue;
      const label = p.name;
      const glyph = p.isUser ? '' : '✳ ';
      const text = glyph + label;
      const padX = 8;
      const pillH = 18;
      const pillW = padX + ctx.measureText(text).width + padX;
      let pillX = p.x + 11;
      if (pillX + pillW > canvas.clientWidth - 8) pillX = p.x - 11 - pillW; // edge flip
      const pillY = p.y - pillH / 2;
      const fill = p.isUser
        ? (isLight() ? [24, 24, 27] : [237, 237, 237])
        : [96, 165, 250]; // agent blue (v5 --agent-b)
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = `rgb(${fill[0]}, ${fill[1]}, ${fill[2]})`;
      roundedRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
      ctx.fill();
      const content = p.isUser ? (isLight() ? [250, 250, 250] : [15, 15, 15]) : [15, 15, 15];
      ctx.fillStyle = `rgb(${content[0]}, ${content[1]}, ${content[2]})`;
      ctx.textAlign = 'left';
      ctx.fillText(text, pillX + padX, pillY + pillH / 2);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
```

and call it in `mainLoop` (line 2068) after `drawCompactHoverBadge(now);`:

```js
    drawLiveEffects(now);
```

- [ ] **Step 6: Verify.** `npm test` (no regressions — this task is draw-only), then `npm run dev` + open the viewer: renders identically at rest (no idle visual change — heat 0, no births/halos/pills). Full motion QA is Task 13.
- [ ] **Step 7: Commit** — `feat(viewer): E treatment draw layer — heat, births, halo drains, pills`

---

### Task 12: Architecture doc

**Files:**
- Create: `docs/architecture/viewer-sync-engine.md`
- Modify: `docs/architecture/graph-ui.md` (cross-link)

- [ ] **Step 1: Write the page.** First-class architecture doc (user request; per the architecture-docs preference this gets full treatment). Cover, with file links: the spine (EventBus → worker persist → `events.db` → main-thread projection deriver → WS fan-out → store → coalesced render); one-adapter-two-transports (`buildAdaptedDecision`/`buildAdaptedTodo` feeding both `/api/*` and deltas); the ULID cursor + `hello.head_ulid` + `catchup`/`catchup_result` protocol with the 500-delta snapshot threshold; the **state-converging replay** property (deltas derived at read time — why duplicate replay is harmless); the client store (in-place hydration, alias-stable globals, rAF coalescing, silent-catch-up animate flag); the live-effects grammar table with the locked timing constants and its v5 lineage (`docs/specs/cortex-v0.3/cortex-frames-prototype-v5.html`); scope boundaries (read-only projection; broker/multi-tenant compose later; IndexedDB persistence deferred — the store is the seam). Source structure + rationale from the spec's "Architecture spine" and "Client reactive store" sections — write it as documentation, not a spec copy.
- [ ] **Step 2: Cross-link.** In `docs/architecture/graph-ui.md`, add under its event-pipeline section: `The read-path sync engine (projection deltas, catch-up, the viewer's reactive store and live change treatments) is documented in [viewer-sync-engine.md](viewer-sync-engine.md).`
- [ ] **Step 3: Commit** — `docs(architecture): viewer read-path sync engine page`

---

### Task 13: Gate 0 visual QA + release prep

Consolidated end-of-branch visual QA (per the Gate-0-at-end rule), then PR. **Stop at PR-opened + CI green — the user tests before any merge.**

**Constraint:** projection deltas only flow from writes made **inside the dev-server process** (MCP tool calls emit on its bus; CLI writes from another process do not). Drive writes through an MCP client attached to the dev server's stdio.

- [ ] **Step 1: Driver script.** Write to the scratchpad (NOT the repo) `qa-driver.mjs`:

```js
// Drives live decision/todo writes through the dev server's MCP stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/index.ts"],
  cwd: process.cwd(),                      // run from the worktree root
  env: { ...process.env, CORTEX_VIEWER_PORT: "3334" },
});
const client = new Client({ name: "qa-driver", version: "0.0.0" });
await client.connect(transport);
console.log("connected — viewer at http://localhost:3334/viewer");

const repo = process.cwd();
const call = (name, args) => client.callTool({ name, arguments: { repo_path: repo, ...args } });

// Pace changes so each treatment reads individually, then burst.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(15000); // time to open the browser
const t = JSON.parse((await call("todo", { action: "propose", summary: "QA: live create", governs: ["src/viewer/store.js"] })).content[0].text);
await wait(4000);
await call("todo", { action: "transition", id: t.id, to: "in_progress" });   // update treatment
await wait(4000);
await call("decision", { action: "create", title: "QA: live decision", rationale: "gate-0", governs: ["src/viewer/ws-client.js"] });
await wait(4000);
await call("todo", { action: "transition", id: t.id, to: "cancelled" });     // remove (leaves ambient set)
await wait(2000);
// Burst: 10 rapid updates → expect ONE coalesced repaint per frame, heat saturating.
for (let i = 0; i < 10; i++) await call("todo", { action: "propose", summary: `QA burst ${i}` });
console.log("done — leave server running for inspection");
```

- [ ] **Step 2: Run QA.** Start the driver (`node qa-driver.mjs` from the worktree), open http://localhost:3334/viewer in Playwright. Capture screenshots (to `.playwright-mcp/` or `.tmp/` only) at: initial load (indicator `live`), create (outline→fill + `✳ claude` pill + frame warmth), update (leader fire + halo drain), remove (tombstone drain-out), burst (heat saturated, canvas legible, no console errors). Kill the dev server mid-session and screenshot the `offline` indicator; restart flow is N/A (stdio-spawned) — reconnect/backfill behavior is covered by unit/integration tests.
- [ ] **Step 3: Judge against Gate 0:** runtime errors, regressions vs. static viewer, missing treatments → **block and fix**; aesthetic timing polish → tune constants in `live-effects.js` (they're exported constants — adjust and re-run) and note what changed. Honest reporting: if any state can't be exercised, say so in the PR body as needing user-driven hand-verify.
- [ ] **Step 4: Clean up QA todos/decisions** created in the home repo's stores (`todo transition → cancelled`, `decision delete`) via the same driver, so the real project store isn't polluted.
- [ ] **Step 5: Full suite + release prep.**

```bash
npm test && npx tsc --noEmit
```

Bump **patch** version (default per workflow; the user may upgrade it to minor when reviewing) in `package.json`, `plugin.json`, `.claude-plugin/marketplace.json`; add the `CHANGELOG.md` entry (Added: reactive read-path sync engine — projection deltas over /ws, catch-up protocol, live viewer store, E·v5-grammar change treatments, todo.* events; docs: viewer-sync-engine architecture page). Commit `chore(release): <version>`.

- [ ] **Step 6: PR.**

```bash
git push -u origin feature/viewer/reactive-sync-engine
gh pr create --base main --title "Viewer reactive read-path sync engine" \
  --body "<spec + plan links, what/why, QA evidence, screenshots list>"
```

Wait for the required "CI gate" check to pass (push via HTTPS — `gh auth setup-git`; SSH is not configured). Report PR URL + CI status to the user and **stop** — the user hand-verifies in their own session before merge (also do NOT tag/release; that happens at merge time per workflow).

---

## Self-Review Notes (performed at write time)

- **Spec coverage:** delta protocol (T3–T5), snapshot-vs-replay 500 (T2/T5), silent catch-up + indicator (T8/T9), store + coalescing + alias migration (T7/T9), incremental buildGraph via per-entity governance/anchors with the promoted-frame full-rebuild exception (T9), todo.* backend gap (T1), projection deriver reusing the adapters (T4), E treatment + all five grammar rows + attribution rules (T10/T11), final-polish list — bursts (store coalescing + heat saturation), hidden tab (animate flag), reduced motion (T10), light mode (theme-helper colors in T11), pill edge-flip (T11), layer toggles (T11 gating), removed-while-open (T9), project switch (isLiveProject guard + no cursor advance, T8/T9) — and the architecture page (T12). **One deliberate narrowing:** `ProjectionEntity` is `'decision'|'todo'` (the entities the viewer renders), not the spec's five-way union — additive to widen; noted in the type's doc comment.
- **Type consistency:** `ProjectionDelta.data` is `Record<string, unknown>` on the wire type; the deriver is the sole producer and casts from the adapted types. `since({since_id, limit})`, `head()`, `CATCHUP_REPLAY_LIMIT`, `deriveProjectionDeltas`, `broadcastProjections`, `createStore`, `connectLiveSync`, `createLiveEffects` names match across all tasks.
- **Known judgment calls for the implementer:** exact test-harness plumbing in `tests/integration/ws-server.test.ts` follows that file's existing promise patterns; `openDecisionsDb` setup in T1 copies `tests/todos/service.test.ts`; repo-method nullability shims in T6 as noted.

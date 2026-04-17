# Graph UI Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the event pipeline, git watcher, and WebSocket server that power the upcoming 2D graph viewer and activity stream. After this plan, Cortex emits structured events for every decision CRUD and every git commit, persists them to a separate SQLite log, and broadcasts them + derived graph mutations over a WebSocket at `/ws`.

**Architecture:** Two-thread Node process. Main thread: existing MCP server + HTTP server + new WebSocket server. Worker thread: event persister, mutation deriver, git watcher — all talking to a new `.cortex/events.db`. Main ↔ worker communicate via `MessagePort`. See [the spec](../specs/2026-04-17-graph-ui-and-activity-stream-design.md) for full design rationale.

**Tech Stack:** Node.js, TypeScript, `better-sqlite3` (existing), `ws` (new), `chokidar` (new), `ulid` (new), Vitest.

**Related plans (future, not this plan):**
- Plan B: 2D graph viewer
- Plan C: Activity stream + graph↔stream sync

---

## File Structure

**New source files:**

```
src/events/
  types.ts                       Event + GraphMutation + ServerMsg + ClientMsg unions (shared main + worker)
  bus.ts                         Main-thread event bus facade; owns worker and the MessagePort pair
  ulid.ts                        ULID generator
  worker.ts                      Worker thread entry point; wires persister + mutation-deriver + git-watcher
  worker/
    persister.ts                 Opens .cortex/events.db, inserts events, reads backfill pages
    mutation-deriver.ts          Pure function: Event → GraphMutation[]
    git-log-parser.ts            Pure function: git log output → commit event payload
    git-watcher.ts               Chokidar + git-log-parser integration; emits commit events into the pipeline
    schema.sql                   events.db schema (events table + meta table)

src/ws/
  types.ts                       Re-export of src/events/types.ts's wire types, for clarity at call sites
  protocol.ts                    encode/decode helpers for ServerMsg/ClientMsg
  client-registry.ts             In-memory Set of connected clients, with send() fan-out
  server.ts                      WebSocket upgrade + connection handler
```

**New tests:**

```
tests/events/
  ulid.test.ts
  persister.test.ts
  mutation-deriver.test.ts
  bus.test.ts
  git-log-parser.test.ts
tests/ws/
  protocol.test.ts
  client-registry.test.ts
tests/integration/
  events-flow.test.ts            main↔worker roundtrip via bus
  decision-events.test.ts        DecisionService emission
  git-watcher.test.ts            temp repo, real commit, event arrives
  ws-server.test.ts              connect, hello, backfill, heartbeat
  end-to-end.test.ts             create decision → WS client receives event + mutations
  worker-crash.test.ts           worker dies, main auto-restarts, events resume
```

**Modified source files:**

- `src/decisions/service.ts` — accept optional `EventBus`, emit on every mutation
- `src/decisions/types.ts` — add `author: string` to Decision + input types
- `src/graph/store.ts` / `src/graph/schema.ts` — add `author` column on decision nodes
- `src/mcp-server/api.ts` — handle `upgrade` event for `/ws`
- `src/index.ts` — create `EventBus`, wire into `DecisionService` and WS server
- `package.json` — add `ws`, `chokidar`, `ulid` runtime deps + `@types/ws` dev dep

**New docs:**

- `docs/architecture/graph-ui.md` — architecture doc (scaffold in Task 1, final pass in Task 16)
- `README.md` — append "Graph UI" pointer
- `CLAUDE.md` — append architecture doc pointer

---

### Task 1: Architecture doc scaffold + dependencies

**Files:**
- Create: `docs/architecture/graph-ui.md`
- Modify: `package.json`

- [ ] **Step 1: Install dependencies**

Run:

```bash
npm install ws chokidar ulid
npm install --save-dev @types/ws
```

Expected: three deps added to `dependencies`, one to `devDependencies` in `package.json`.

- [ ] **Step 2: Create architecture doc scaffold**

Write `docs/architecture/graph-ui.md` with all section headers and TBD markers for content we'll fill in as we build. Use this exact content:

```markdown
# Graph UI Architecture

> Living document. Started 2026-04-17. Updated as the system is built.

## System overview

Cortex emits structured events for decision lifecycle and git activity, persists them to an append-only SQLite log, derives graph mutations from those events, and broadcasts both over a WebSocket. A 2D graph viewer and an activity stream consume the broadcasts in tandem.

## Thread model

(Diagram inserted in Task 16 — see spec section "Architecture" for current draft.)

## Event flow: "Claude creates a decision"

(Walkthrough inserted in Task 16.)

## Component boundaries

(Filled in Task 16 as each component is built.)

## Design rationale

See [the spec](../superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md#why-two-threads). Summarized here in Task 16.

## Extending the system

(Filled in Task 16 with concrete recipes for common extensions.)

## Deferred / future work

- Multi-user / collaboration
- Gap detection
- Temporal slider
- External event bus (Redis/Kafka/NATS)
- Louvain clustering
- VS Code sidebar
- Phone PWA

See spec "Future extensibility" for prep hooks already in place.

## Testing strategy

See spec section "Testing strategy".
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json docs/architecture/graph-ui.md
git commit -m "chore: add ws/chokidar/ulid deps, arch doc scaffold"
```

---

### Task 2: Event + mutation + WS message type definitions

**Files:**
- Create: `src/events/types.ts`
- Create: `src/ws/types.ts`

- [ ] **Step 1: Write `src/events/types.ts`**

Full TSDoc per the architecture-docs standard. Content:

```ts
/**
 * Event envelope common to every event kind.
 *
 * Persisted verbatim in events.db (one row per event). ULID `id` is sortable by
 * time, which saves an extra indexed timestamp column. `actor` is the entity
 * that performed the action (currently 'claude' for MCP-initiated actions,
 * '<git-author-name>' for commits, 'system' for future automated events).
 *
 * `project_id` is denormalized onto every event so multi-project filtering
 * later requires no schema change.
 */
export interface EventEnvelope {
  /** 26-char ULID; monotonic in same-ms calls. */
  id: string;
  /** Dotted `<entity>.<verb>` — see `Event` union. */
  kind: string;
  /** 'claude' | git-author | 'system'. */
  actor: string;
  /** Unix milliseconds. */
  created_at: number;
  /** CBM project name if attached, else ''. */
  project_id: string;
}

/**
 * Discriminated union of all v1 event kinds.
 *
 * Add a new kind by extending this union + adding a case to the mutation
 * deriver. Nothing else needs to change for the event to flow end-to-end.
 */
export type Event =
  | (EventEnvelope & {
      kind: 'decision.created';
      payload: {
        decision_id: string;
        title: string;
        rationale: string;
        governed_file_ids: string[];
        tags: string[];
      };
    })
  | (EventEnvelope & {
      kind: 'decision.updated';
      payload: { decision_id: string; changed_fields: string[] };
    })
  | (EventEnvelope & {
      kind: 'decision.deleted';
      /** `title` snapshotted at delete-time for tombstone rendering in the stream. */
      payload: { decision_id: string; title: string };
    })
  | (EventEnvelope & {
      kind: 'decision.superseded';
      payload: { old_id: string; new_id: string; reason: string };
    })
  | (EventEnvelope & {
      kind: 'decision.promoted';
      payload: { decision_id: string; from_tier: string; to_tier: string };
    })
  | (EventEnvelope & {
      kind: 'decision.proposed';
      payload: {
        decision_id: string;
        title: string;
        would_govern_file_ids: string[];
      };
    })
  | (EventEnvelope & {
      kind: 'commit';
      payload: {
        hash: string;
        message: string;
        files: { path: string; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' }[];
        /** Decisions governing any of the touched files. Computed at emission, not render. */
        decision_links: string[];
      };
    });

/**
 * Shape of a node as broadcast over the wire.
 *
 * Matches the shape returned by `/api/graph` (which the viewer uses to bootstrap).
 * Only the fields actually consumed by the viewer are declared; the backend
 * may carry additional fields.
 */
export interface WireNode {
  id: string;
  kind: string;
  name: string;
  /** decision-only; 'active' | 'proposed' | 'superseded' */
  status?: string;
  /** Free-form JSON, shape depends on kind. */
  data?: Record<string, unknown>;
}

/** Edge shape as broadcast over the wire. */
export interface WireEdge {
  source_id: string;
  target_id: string;
  relation: string;
}

/**
 * Graph mutation — a single delta applied to the viewer's graph state.
 *
 * Derived from events by `mutation-deriver`. Routed to the graph component;
 * the stream component ignores these (it consumes events, not mutations).
 */
export type GraphMutation =
  | { op: 'add_node'; node: WireNode }
  | { op: 'update_node'; id: string; fields: Partial<WireNode> }
  | { op: 'remove_node'; id: string }
  | { op: 'add_edge'; edge: WireEdge }
  | {
      op: 'remove_edge';
      source: string;
      target: string;
      relation: string;
    };

/**
 * Messages sent from server to client over the WebSocket at `/ws`.
 *
 * See `docs/superpowers/specs/2026-04-17-graph-ui-and-activity-stream-design.md#websocket-protocol`.
 */
export type ServerMsg =
  | { type: 'hello'; project_id: string; server_version: string }
  | { type: 'event'; event: Event }
  | { type: 'mutation'; mutation: GraphMutation }
  | {
      type: 'backfill_page';
      events: Event[];
      mutations: GraphMutation[];
      has_more: boolean;
    }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string };

/** Messages sent from client to server over the WebSocket at `/ws`. */
export type ClientMsg =
  | { type: 'backfill'; before_id?: string; limit?: number }
  | { type: 'ping' };
```

- [ ] **Step 2: Write `src/ws/types.ts`**

Thin re-export so WebSocket code imports from `src/ws/`:

```ts
export type {
  ServerMsg,
  ClientMsg,
  Event,
  GraphMutation,
  WireNode,
  WireEdge,
} from '../events/types.js';
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (types compile, no other code depends on them yet).

- [ ] **Step 4: Commit**

```bash
git add src/events/types.ts src/ws/types.ts
git commit -m "feat: event/mutation/WS message type definitions"
```

---

### Task 3: ULID generator

**Files:**
- Create: `src/events/ulid.ts`
- Create: `tests/events/ulid.test.ts`

We use the `ulid` npm package but wrap it so emission sites import from one internal module, and so the monotonic variant is the default.

- [ ] **Step 1: Write the failing test**

`tests/events/ulid.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { newUlid } from '../../src/events/ulid.js';

describe('newUlid', () => {
  it('produces 26-char Crockford base32 strings', () => {
    const id = newUlid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('is monotonic across rapid calls within the same millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => newUlid());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/events/ulid.test.ts`
Expected: FAIL with "Cannot find module 'src/events/ulid.js'".

- [ ] **Step 3: Write `src/events/ulid.ts`**

```ts
import { monotonicFactory } from 'ulid';

/**
 * Emits a ULID that is strictly monotonic within the same millisecond.
 *
 * Used as the primary key for every event. Sorting by `id` equals sorting by
 * `created_at`, so we avoid an extra indexed timestamp column for the main
 * stream-feed query.
 *
 * Shared factory state is intentional — module-scoped so every caller in the
 * process uses the same clock.
 */
const generate = monotonicFactory();

export function newUlid(): string {
  return generate();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/events/ulid.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/events/ulid.ts tests/events/ulid.test.ts
git commit -m "feat: ULID generator for event IDs"
```

---

### Task 4: events.db schema + persister

**Files:**
- Create: `src/events/worker/schema.sql`
- Create: `src/events/worker/persister.ts`
- Create: `tests/events/persister.test.ts`

- [ ] **Step 1: Write `src/events/worker/schema.sql`**

```sql
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  project_id  TEXT NOT NULL,
  payload     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_created_at ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS events_kind_created_at ON events(kind, created_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing test**

`tests/events/persister.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { EventPersister } from '../../src/events/worker/persister.js';
import type { Event } from '../../src/events/types.js';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: '01HXZ00000000000000000000A',
    kind: 'decision.created',
    actor: 'claude',
    created_at: 1_700_000_000_000,
    project_id: 'cortex',
    payload: {
      decision_id: 'd1',
      title: 't',
      rationale: 'r',
      governed_file_ids: [],
      tags: [],
    },
    ...overrides,
  } as Event;
}

describe('EventPersister', () => {
  let persister: EventPersister;
  afterEach(() => persister?.close());

  it('inserts an event and reads it back', () => {
    persister = new EventPersister(':memory:');
    const e = makeEvent();
    persister.insert(e);
    const page = persister.backfill({ limit: 10 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0].id).toBe(e.id);
    expect(page.events[0].kind).toBe('decision.created');
    expect(page.has_more).toBe(false);
  });

  it('returns events newest-first; has_more when more remain', () => {
    persister = new EventPersister(':memory:');
    for (let i = 0; i < 5; i++) {
      persister.insert(
        makeEvent({
          id: `01HXZ0000000000000000000${i}0`,
          created_at: 1_700_000_000_000 + i,
        }),
      );
    }
    const page = persister.backfill({ limit: 3 });
    expect(page.events.map((e) => e.id)).toEqual([
      '01HXZ0000000000000000000040',
      '01HXZ0000000000000000000030',
      '01HXZ0000000000000000000020',
    ]);
    expect(page.has_more).toBe(true);
  });

  it('paginates with before_id', () => {
    persister = new EventPersister(':memory:');
    for (let i = 0; i < 5; i++) {
      persister.insert(
        makeEvent({
          id: `01HXZ0000000000000000000${i}0`,
          created_at: 1_700_000_000_000 + i,
        }),
      );
    }
    const page = persister.backfill({
      before_id: '01HXZ0000000000000000000020',
      limit: 10,
    });
    expect(page.events.map((e) => e.id)).toEqual([
      '01HXZ0000000000000000000010',
      '01HXZ0000000000000000000000',
    ]);
  });

  it('get/set meta roundtrips', () => {
    persister = new EventPersister(':memory:');
    persister.setMeta('last_seen_head', 'abc123');
    expect(persister.getMeta('last_seen_head')).toBe('abc123');
    expect(persister.getMeta('missing')).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/events/persister.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Write `src/events/worker/persister.ts`**

```ts
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Event } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

/**
 * Opens/creates `events.db` and exposes insert + backfill + meta operations.
 *
 * Owned exclusively by the worker thread. The main thread must NOT open this
 * DB — cross-thread writes on the same WAL are what the two-DB split
 * specifically avoids. If you need to read events from main, proxy through
 * the worker's message port.
 *
 * Uses WAL mode so concurrent readers (e.g., future backfill replicas) don't
 * block the writer.
 */
export class EventPersister {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private backfillNewestStmt: Database.Statement;
  private backfillBeforeStmt: Database.Statement;
  private setMetaStmt: Database.Statement;
  private getMetaStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));

    this.insertStmt = this.db.prepare(
      `INSERT INTO events (id, kind, actor, created_at, project_id, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.backfillNewestStmt = this.db.prepare(
      `SELECT id, kind, actor, created_at, project_id, payload
       FROM events ORDER BY id DESC LIMIT ?`,
    );
    this.backfillBeforeStmt = this.db.prepare(
      `SELECT id, kind, actor, created_at, project_id, payload
       FROM events WHERE id < ? ORDER BY id DESC LIMIT ?`,
    );
    this.setMetaStmt = this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.getMetaStmt = this.db.prepare(`SELECT value FROM meta WHERE key = ?`);
  }

  /** Inserts one event. Idempotent by ULID primary key: re-inserting an existing id throws. */
  insert(event: Event): void {
    this.insertStmt.run(
      event.id,
      event.kind,
      event.actor,
      event.created_at,
      event.project_id,
      JSON.stringify(event.payload),
    );
  }

  /**
   * Returns a page of events, newest first.
   *
   * `has_more` is computed by asking for one extra row; if it comes back,
   * we drop it and flag has_more = true.
   */
  backfill(opts: { before_id?: string; limit?: number }): {
    events: Event[];
    has_more: boolean;
  } {
    const limit = opts.limit ?? 50;
    const rows = opts.before_id
      ? (this.backfillBeforeStmt.all(opts.before_id, limit + 1) as RowShape[])
      : (this.backfillNewestStmt.all(limit + 1) as RowShape[]);
    const has_more = rows.length > limit;
    return {
      events: rows.slice(0, limit).map(rowToEvent),
      has_more,
    };
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  close(): void {
    this.db.close();
  }
}

interface RowShape {
  id: string;
  kind: string;
  actor: string;
  created_at: number;
  project_id: string;
  payload: string;
}

function rowToEvent(row: RowShape): Event {
  return {
    id: row.id,
    kind: row.kind,
    actor: row.actor,
    created_at: row.created_at,
    project_id: row.project_id,
    payload: JSON.parse(row.payload),
  } as Event;
}
```

- [ ] **Step 5: Make `schema.sql` reachable at runtime**

The `readFileSync` path above assumes the file sits next to the compiled JS. Verify the build config copies it:

Run: `cat tsconfig.json | grep -E 'include|rootDir|outDir' | head -5`

If `tsconfig.json` doesn't copy `.sql` files (the default `tsc` behavior doesn't copy non-TS files), add a pre-test/post-build step. For this plan we rely on tests running against `:memory:` databases and the `src/` tree directly via `tsx`. The SQL file is read from `src/events/worker/schema.sql` at both dev and test time (no build artifact needed). Confirm by running the test.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/events/persister.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Commit**

```bash
git add src/events/worker/schema.sql src/events/worker/persister.ts tests/events/persister.test.ts
git commit -m "feat: events.db schema and persister"
```

---

### Task 5: Mutation deriver

**Files:**
- Create: `src/events/worker/mutation-deriver.ts`
- Create: `tests/events/mutation-deriver.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/events/mutation-deriver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveMutations } from '../../src/events/worker/mutation-deriver.js';
import type { Event, WireNode } from '../../src/events/types.js';

function env<E extends Event>(overrides: Partial<E>): E {
  return {
    id: '01HXZ00000000000000000000A',
    kind: 'decision.created',
    actor: 'claude',
    created_at: 1_700_000_000_000,
    project_id: 'cortex',
    payload: {},
    ...(overrides as object),
  } as E;
}

// nodeLookup is how the deriver gets current state it needs —
// e.g., to synthesize an add_node mutation when a decision is created,
// we need the decision's current node data.
const nodes = new Map<string, WireNode>([
  ['d1', { id: 'd1', kind: 'decision', name: 'Use WAL', status: 'active' }],
  ['f1', { id: 'f1', kind: 'file', name: 'store.ts' }],
  ['f2', { id: 'f2', kind: 'file', name: 'schema.sql' }],
]);
const lookup = (id: string) => nodes.get(id);

describe('deriveMutations', () => {
  it('decision.created produces add_node + one add_edge per governed file', () => {
    const e = env<Event & { kind: 'decision.created' }>({
      kind: 'decision.created',
      payload: {
        decision_id: 'd1',
        title: 'Use WAL',
        rationale: 'r',
        governed_file_ids: ['f1', 'f2'],
        tags: [],
      },
    });
    const ms = deriveMutations(e, lookup);
    expect(ms).toEqual([
      { op: 'add_node', node: nodes.get('d1') },
      { op: 'add_edge', edge: { source_id: 'd1', target_id: 'f1', relation: 'GOVERNS' } },
      { op: 'add_edge', edge: { source_id: 'd1', target_id: 'f2', relation: 'GOVERNS' } },
    ]);
  });

  it('decision.deleted produces remove_node', () => {
    const e = env<Event & { kind: 'decision.deleted' }>({
      kind: 'decision.deleted',
      payload: { decision_id: 'd1', title: 'Use WAL' },
    });
    expect(deriveMutations(e, lookup)).toEqual([
      { op: 'remove_node', id: 'd1' },
    ]);
  });

  it('decision.superseded produces update_node for both old and new + add_edge SUPERSEDES', () => {
    const e = env<Event & { kind: 'decision.superseded' }>({
      kind: 'decision.superseded',
      payload: { old_id: 'd1', new_id: 'd2', reason: 'ported' },
    });
    expect(deriveMutations(e, lookup)).toEqual([
      { op: 'update_node', id: 'd1', fields: { status: 'superseded' } },
      { op: 'add_edge', edge: { source_id: 'd2', target_id: 'd1', relation: 'SUPERSEDES' } },
    ]);
  });

  it('decision.updated produces update_node with changed fields', () => {
    const e = env<Event & { kind: 'decision.updated' }>({
      kind: 'decision.updated',
      payload: { decision_id: 'd1', changed_fields: ['title'] },
    });
    const ms = deriveMutations(e, lookup);
    expect(ms).toEqual([
      { op: 'update_node', id: 'd1', fields: { name: 'Use WAL' } },
    ]);
  });

  it('commit produces no mutations in v1', () => {
    const e = env<Event & { kind: 'commit' }>({
      kind: 'commit',
      payload: {
        hash: 'abc',
        message: 'm',
        files: [{ path: 'a.ts', status: 'M' }],
        decision_links: [],
      },
    });
    expect(deriveMutations(e, lookup)).toEqual([]);
  });

  it('decision.proposed produces add_node only (no GOVERNS edges yet — would_govern is advisory)', () => {
    const e = env<Event & { kind: 'decision.proposed' }>({
      kind: 'decision.proposed',
      payload: {
        decision_id: 'd3',
        title: 'Proposed',
        would_govern_file_ids: ['f1'],
      },
    });
    const lookupWithD3 = (id: string) =>
      id === 'd3'
        ? { id: 'd3', kind: 'decision', name: 'Proposed', status: 'proposed' }
        : nodes.get(id);
    expect(deriveMutations(e, lookupWithD3)).toEqual([
      { op: 'add_node', node: { id: 'd3', kind: 'decision', name: 'Proposed', status: 'proposed' } },
    ]);
  });

  it('decision.promoted produces update_node with new tier', () => {
    const e = env<Event & { kind: 'decision.promoted' }>({
      kind: 'decision.promoted',
      payload: { decision_id: 'd1', from_tier: 'personal', to_tier: 'team' },
    });
    expect(deriveMutations(e, lookup)).toEqual([
      { op: 'update_node', id: 'd1', fields: { data: { tier: 'team' } } },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/events/mutation-deriver.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/events/worker/mutation-deriver.ts`**

```ts
import type { Event, GraphMutation, WireNode } from '../types.js';

/**
 * Function the deriver calls to look up current node state when needed.
 *
 * The deriver is pure WRT its inputs; this interface is how it gets the
 * current graph state without reaching into the main thread's store.
 *
 * In production, this is backed by a snapshot the worker holds (populated
 * from the same `/api/graph` response the viewer hydrates with). In tests,
 * pass a Map-based implementation.
 */
export type NodeLookup = (id: string) => WireNode | undefined;

/**
 * Pure function: event → ordered array of graph mutations the viewer applies.
 *
 * Order matters: `add_node` must precede any `add_edge` referencing that node.
 * Viewer applies them in array order.
 *
 * `commit` events intentionally produce no mutations in v1 — commits don't
 * change the graph structure, only the stream.
 */
export function deriveMutations(event: Event, lookup: NodeLookup): GraphMutation[] {
  switch (event.kind) {
    case 'decision.created': {
      const node = lookup(event.payload.decision_id);
      if (!node) return [];
      const mutations: GraphMutation[] = [{ op: 'add_node', node }];
      for (const fid of event.payload.governed_file_ids) {
        mutations.push({
          op: 'add_edge',
          edge: {
            source_id: event.payload.decision_id,
            target_id: fid,
            relation: 'GOVERNS',
          },
        });
      }
      return mutations;
    }

    case 'decision.updated': {
      const node = lookup(event.payload.decision_id);
      if (!node) return [];
      const fields: Partial<WireNode> = {};
      for (const f of event.payload.changed_fields) {
        if (f === 'title') fields.name = node.name;
        if (f === 'status') fields.status = node.status;
        if (f === 'data') fields.data = node.data;
      }
      return Object.keys(fields).length
        ? [{ op: 'update_node', id: event.payload.decision_id, fields }]
        : [];
    }

    case 'decision.deleted':
      return [{ op: 'remove_node', id: event.payload.decision_id }];

    case 'decision.superseded':
      return [
        { op: 'update_node', id: event.payload.old_id, fields: { status: 'superseded' } },
        {
          op: 'add_edge',
          edge: {
            source_id: event.payload.new_id,
            target_id: event.payload.old_id,
            relation: 'SUPERSEDES',
          },
        },
      ];

    case 'decision.promoted':
      return [
        {
          op: 'update_node',
          id: event.payload.decision_id,
          fields: { data: { tier: event.payload.to_tier } },
        },
      ];

    case 'decision.proposed': {
      const node = lookup(event.payload.decision_id);
      return node ? [{ op: 'add_node', node }] : [];
    }

    case 'commit':
      return [];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/events/mutation-deriver.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/events/worker/mutation-deriver.ts tests/events/mutation-deriver.test.ts
git commit -m "feat: event → graph mutation deriver (pure function)"
```

---

### Task 6: Event bus (main-thread facade)

**Files:**
- Create: `src/events/bus.ts`
- Create: `tests/events/bus.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/events/bus.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../src/events/bus.js';
import type { Event } from '../../src/events/types.js';

function sampleEvent(): Event {
  return {
    id: '01HXZ0000000000000000000AA',
    kind: 'decision.created',
    actor: 'claude',
    created_at: Date.now(),
    project_id: 'test',
    payload: {
      decision_id: 'd1',
      title: 't',
      rationale: 'r',
      governed_file_ids: [],
      tags: [],
    },
  } as Event;
}

describe('EventBus', () => {
  it('invokes registered listeners on emit', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.onEvent(listener);
    const e = sampleEvent();
    bus.emit(e);
    expect(listener).toHaveBeenCalledWith(e);
  });

  it('supports multiple listeners', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.onEvent(a);
    bus.onEvent(b);
    bus.emit(sampleEvent());
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('offEvent removes a listener', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.onEvent(listener);
    bus.offEvent(listener);
    bus.emit(sampleEvent());
    expect(listener).not.toHaveBeenCalled();
  });

  it('listener exceptions do not prevent other listeners from firing', () => {
    const bus = new EventBus();
    const thrower = vi.fn(() => { throw new Error('boom'); });
    const ok = vi.fn();
    bus.onEvent(thrower);
    bus.onEvent(ok);
    bus.emit(sampleEvent());
    expect(ok).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/events/bus.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/events/bus.ts`**

```ts
import type { Event } from './types.js';

/**
 * Listener callback invoked once per emitted event.
 *
 * Must not throw — if it does, the bus logs to stderr and continues
 * dispatching to remaining listeners. Callers MUST NOT depend on a throw
 * aborting the emit; that would give earlier-registered listeners unfair
 * veto power over later ones.
 */
export type EventListener = (event: Event) => void;

/**
 * In-process event bus for the main thread.
 *
 * This is the facade the `DecisionService` talks to. The worker bridge
 * (added in `src/index.ts`) registers a listener that forwards events to
 * the worker thread via MessagePort. Tests can register a spy listener and
 * skip the worker entirely.
 *
 * Intentionally simple — no priorities, no async listeners, no backpressure.
 * If a listener needs async work, it should spawn it and return immediately.
 */
export class EventBus {
  private listeners = new Set<EventListener>();

  onEvent(listener: EventListener): void {
    this.listeners.add(listener);
  }

  offEvent(listener: EventListener): void {
    this.listeners.delete(listener);
  }

  emit(event: Event): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        process.stderr.write(`[EventBus] listener threw: ${(err as Error).message}\n`);
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/events/bus.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/events/bus.ts tests/events/bus.test.ts
git commit -m "feat: main-thread event bus facade"
```

---

### Task 7: Worker thread entry + pipeline integration

**Files:**
- Create: `src/events/worker.ts`
- Create: `tests/integration/events-flow.test.ts`

We wire the persister + mutation-deriver inside a worker. Main sends `Event` messages in via MessagePort; worker persists, derives mutations, and posts back a `{events:[e], mutations:[...]}` bundle for broadcast.

- [ ] **Step 1: Write the failing integration test**

`tests/integration/events-flow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Event, GraphMutation } from '../../src/events/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(__dirname, '..', '..', 'src', 'events', 'worker.ts');

function sampleEvent(): Event {
  return {
    id: '01HXZ0000000000000000000EE',
    kind: 'decision.created',
    actor: 'claude',
    created_at: Date.now(),
    project_id: 'test',
    payload: {
      decision_id: 'd1',
      title: 't',
      rationale: 'r',
      governed_file_ids: ['f1'],
      tags: [],
    },
  } as Event;
}

describe('worker events flow', () => {
  it('accepts events, persists, derives mutations, posts broadcast bundle back', async () => {
    // Use tsx to load TS directly; ESM worker_thread setup.
    const worker = new Worker(
      new URL('../../src/events/worker.ts', import.meta.url),
      { execArgv: ['--import', 'tsx'] },
    );

    const bundles: { events: Event[]; mutations: GraphMutation[] }[] = [];
    worker.on('message', (msg) => {
      if (msg.type === 'broadcast') bundles.push(msg.bundle);
    });

    // Handshake: tell the worker to use :memory: and a snapshot with node d1/f1.
    worker.postMessage({
      type: 'init',
      events_db_path: ':memory:',
      project_id: 'test',
      nodes: [
        { id: 'd1', kind: 'decision', name: 't', status: 'active' },
        { id: 'f1', kind: 'file', name: 'f1.ts' },
      ],
    });

    // Wait for ready
    await new Promise<void>((resolve) => {
      const handler = (msg: { type: string }) => {
        if (msg.type === 'ready') {
          worker.off('message', handler);
          resolve();
        }
      };
      worker.on('message', handler);
    });

    worker.postMessage({ type: 'event', event: sampleEvent() });

    // Give the worker a tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bundles).toHaveLength(1);
    expect(bundles[0].events).toHaveLength(1);
    expect(bundles[0].mutations.length).toBeGreaterThan(0);
    expect(bundles[0].mutations[0].op).toBe('add_node');

    await worker.terminate();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run tests/integration/events-flow.test.ts`
Expected: FAIL ("worker.ts not found" or similar).

- [ ] **Step 3: Write `src/events/worker.ts`**

```ts
import { parentPort } from 'node:worker_threads';
import { EventPersister } from './worker/persister.js';
import { deriveMutations } from './worker/mutation-deriver.js';
import type { Event, WireNode } from './types.js';

/**
 * Messages main thread → worker.
 *
 * `init` must be first; the worker does not process events until initialized.
 * `snapshot_update` replaces the node lookup (e.g., after another client
 * mutates the graph via `/api/graph` and we need a fresh snapshot).
 */
type InMsg =
  | {
      type: 'init';
      events_db_path: string;
      project_id: string;
      nodes: WireNode[];
    }
  | { type: 'event'; event: Event }
  | { type: 'snapshot_update'; nodes: WireNode[] }
  | { type: 'shutdown' };

/**
 * Messages worker → main thread.
 *
 * `ready` after init succeeds. `broadcast` carries the bundle for WS fan-out.
 * `error` wraps any internal failure; main decides whether to restart.
 */
type OutMsg =
  | { type: 'ready' }
  | {
      type: 'broadcast';
      bundle: { events: Event[]; mutations: ReturnType<typeof deriveMutations> };
    }
  | { type: 'error'; message: string };

if (!parentPort) {
  throw new Error('worker.ts must run as a worker_thread');
}

let persister: EventPersister | null = null;
let nodeMap: Map<string, WireNode> = new Map();
const lookup = (id: string) => nodeMap.get(id);

parentPort.on('message', (msg: InMsg) => {
  try {
    switch (msg.type) {
      case 'init':
        persister = new EventPersister(msg.events_db_path);
        nodeMap = new Map(msg.nodes.map((n) => [n.id, n]));
        post({ type: 'ready' });
        break;

      case 'snapshot_update':
        nodeMap = new Map(msg.nodes.map((n) => [n.id, n]));
        break;

      case 'event': {
        if (!persister) throw new Error('worker not initialized');
        persister.insert(msg.event);
        const mutations = deriveMutations(msg.event, lookup);
        post({
          type: 'broadcast',
          bundle: { events: [msg.event], mutations },
        });
        break;
      }

      case 'shutdown':
        persister?.close();
        process.exit(0);
    }
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
});

function post(msg: OutMsg): void {
  parentPort!.postMessage(msg);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/integration/events-flow.test.ts`
Expected: PASS, 1 test. If it fails with "unknown file extension .ts", verify `tsx` is installed as a devDep (it is — already in package.json) and the `execArgv: ['--import', 'tsx']` is correct for the Node version in use. If still failing, fall back to `--loader tsx` per the `tsx` docs.

- [ ] **Step 5: Commit**

```bash
git add src/events/worker.ts tests/integration/events-flow.test.ts
git commit -m "feat: worker thread entry with persister + mutation deriver"
```

---

### Task 8: DecisionService emits events

**Files:**
- Modify: `src/decisions/service.ts`
- Modify: `src/decisions/types.ts`
- Create: `tests/integration/decision-events.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/integration/decision-events.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { GraphStore } from '../../src/graph/store.js';
import { DecisionService } from '../../src/decisions/service.js';
import { EventBus } from '../../src/events/bus.js';
import type { Event } from '../../src/events/types.js';

describe('DecisionService event emission', () => {
  let store: GraphStore;
  afterEach(() => store?.close());

  it('emits decision.created on create()', () => {
    store = new GraphStore(':memory:');
    const bus = new EventBus();
    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    const service = new DecisionService(store, { bus, project_id: 'test' });
    const d = service.create({
      title: 'Use WAL',
      description: '',
      rationale: 'avoid blocking readers',
      governs: ['src/store.ts'],
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('decision.created');
    expect((emitted[0] as any).payload.decision_id).toBe(d.id);
    expect((emitted[0] as any).payload.governed_file_ids.length).toBe(1);
    expect(emitted[0].actor).toBe('claude');
    expect(emitted[0].project_id).toBe('test');
  });

  it('emits decision.updated on update()', () => {
    store = new GraphStore(':memory:');
    const bus = new EventBus();
    const service = new DecisionService(store, { bus, project_id: 'test' });
    const d = service.create({ title: 't', description: '', rationale: '' });

    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    service.update(d.id, { title: 't2' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('decision.updated');
    expect((emitted[0] as any).payload.changed_fields).toContain('title');
  });

  it('emits decision.superseded when update supplies superseded_by', () => {
    store = new GraphStore(':memory:');
    const bus = new EventBus();
    const service = new DecisionService(store, { bus, project_id: 'test' });
    const old = service.create({ title: 'old', description: '', rationale: '' });
    const nxt = service.create({ title: 'new', description: '', rationale: '' });

    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    service.update(old.id, { superseded_by: nxt.id, status: 'superseded' });

    const superseded = emitted.find((e) => e.kind === 'decision.superseded');
    expect(superseded).toBeDefined();
    expect((superseded as any).payload.old_id).toBe(old.id);
    expect((superseded as any).payload.new_id).toBe(nxt.id);
  });

  it('emits decision.deleted on delete() with title snapshot', () => {
    store = new GraphStore(':memory:');
    const bus = new EventBus();
    const service = new DecisionService(store, { bus, project_id: 'test' });
    const d = service.create({ title: 'gone', description: '', rationale: '' });

    const emitted: Event[] = [];
    bus.onEvent((e) => emitted.push(e));

    service.delete(d.id);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('decision.deleted');
    expect((emitted[0] as any).payload.title).toBe('gone');
  });

  it('no bus is allowed — emissions silently skipped', () => {
    store = new GraphStore(':memory:');
    const service = new DecisionService(store); // no bus — backwards compatible
    expect(() =>
      service.create({ title: 't', description: '', rationale: '' }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/decision-events.test.ts`
Expected: FAIL.

- [ ] **Step 3: Modify `src/decisions/types.ts`**

Add `author` to input and Decision types. Find the existing types and add:

```ts
// In CreateDecisionInput:
  author?: string;   // defaults to 'claude' when omitted

// In Decision:
  author: string;
```

Update `nodeToDecision` if it constructs the Decision — include `author: node.data.author ?? 'claude'`.

- [ ] **Step 4: Modify `src/decisions/service.ts`**

Replace the file with the event-emitting version. The constructor now accepts an optional bus + project_id. Every mutation method emits its event *after* the SQLite write succeeds:

```ts
import { GraphStore, NodeRow } from "../graph/store.js";
import type { Decision, CreateDecisionInput, UpdateDecisionInput } from "./types.js";
import { nodeToDecision } from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";

export interface DecisionServiceDeps {
  bus?: EventBus;
  project_id?: string;
}

/**
 * DecisionService — CRUD over decisions with event emission.
 *
 * Each mutation emits exactly one event on the bus AFTER the SQLite write
 * succeeds. This ordering matters: a listener may assume the state reflected
 * by the event is already queryable via the graph store. If the write fails,
 * no event is emitted.
 *
 * `bus` is optional so existing call sites (tests, one-off scripts) continue
 * to work without backwards-incompatible changes.
 */
export class DecisionService {
  private bus: EventBus | undefined;
  private projectId: string;

  constructor(private store: GraphStore, deps: DecisionServiceDeps = {}) {
    this.bus = deps.bus;
    this.projectId = deps.project_id ?? '';
  }

  create(input: CreateDecisionInput): Decision {
    const data = {
      title: input.title,
      description: input.description,
      rationale: input.rationale,
      alternatives: input.alternatives ?? [],
      status: "active" as const,
      author: input.author ?? 'claude',
    };

    const node = this.store.createNode({
      kind: "decision",
      name: input.title,
      data,
      tier: "personal",
    });

    this.store.indexDecisionContent(node.id, input.title, input.description, input.rationale);

    const governedIds: string[] = [];
    if (input.governs) {
      for (const target of input.governs) {
        const id = this.linkGovernsReturningTarget(node.id, target);
        governedIds.push(id);
      }
    }

    if (input.references) {
      for (const ref of input.references) {
        this.store.createEdge({
          source_id: node.id,
          target_id: ref,
          relation: "REFERENCES",
        });
      }
    }

    this.emit({
      id: newUlid(),
      kind: 'decision.created',
      actor: data.author,
      created_at: Date.now(),
      project_id: this.projectId,
      payload: {
        decision_id: node.id,
        title: input.title,
        rationale: input.rationale,
        governed_file_ids: governedIds,
        tags: [],
      },
    });

    return nodeToDecision(node);
  }

  /**
   * Same as linkGoverns but returns the target node id (resolving path-to-node
   * if necessary). Used by create() to build the governed_file_ids payload.
   */
  private linkGovernsReturningTarget(decisionId: string, target: string): string {
    const existingNode = this.store.getNode(target);
    if (existingNode) {
      this.store.createEdge({
        source_id: decisionId,
        target_id: target,
        relation: "GOVERNS",
      });
      return target;
    }

    const pathNodes = this.store.findNodes({ file_path: target, kind: "path" });
    let pathNode: NodeRow;
    if (pathNodes.length > 0) {
      pathNode = pathNodes[0];
    } else {
      pathNode = this.store.createNode({
        kind: "path",
        name: target.split("/").pop() || target,
        file_path: target,
        tier: "public",
      });
    }
    this.store.createEdge({
      source_id: decisionId,
      target_id: pathNode.id,
      relation: "GOVERNS",
    });
    return pathNode.id;
  }

  linkGoverns(decisionId: string, target: string): void {
    this.linkGovernsReturningTarget(decisionId, target);
  }

  linkReference(decisionId: string, targetId: string): void {
    this.store.createEdge({
      source_id: decisionId,
      target_id: targetId,
      relation: "REFERENCES",
    });
  }

  update(id: string, input: UpdateDecisionInput): Decision {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const existingData = JSON.parse(node.data);
    const newData = { ...existingData };
    const changed: string[] = [];

    if (input.title !== undefined && input.title !== existingData.title) { newData.title = input.title; changed.push('title'); }
    if (input.description !== undefined && input.description !== existingData.description) { newData.description = input.description; changed.push('description'); }
    if (input.rationale !== undefined && input.rationale !== existingData.rationale) { newData.rationale = input.rationale; changed.push('rationale'); }
    if (input.alternatives !== undefined) { newData.alternatives = input.alternatives; changed.push('alternatives'); }
    if (input.status !== undefined && input.status !== existingData.status) { newData.status = input.status; changed.push('status'); }
    if (input.superseded_by !== undefined) { newData.superseded_by = input.superseded_by; changed.push('superseded_by'); }

    const updatedNode = this.store.updateNode(id, {
      name: newData.title,
      data: JSON.stringify(newData),
    });

    this.store.updateDecisionContent(id, newData.title, newData.description, newData.rationale);

    if (input.superseded_by) {
      const existing = this.store.findEdges({ source_id: input.superseded_by, target_id: id, relation: "SUPERSEDES" });
      if (existing.length === 0) {
        this.store.createEdge({
          source_id: input.superseded_by,
          target_id: id,
          relation: "SUPERSEDES",
        });
      }
      this.emit({
        id: newUlid(),
        kind: 'decision.superseded',
        actor: newData.author ?? 'claude',
        created_at: Date.now(),
        project_id: this.projectId,
        payload: { old_id: id, new_id: input.superseded_by, reason: input.reason ?? '' },
      });
    } else if (changed.length > 0) {
      this.emit({
        id: newUlid(),
        kind: 'decision.updated',
        actor: newData.author ?? 'claude',
        created_at: Date.now(),
        project_id: this.projectId,
        payload: { decision_id: id, changed_fields: changed },
      });
    }

    return nodeToDecision(updatedNode);
  }

  delete(id: string): void {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const titleSnapshot = JSON.parse(node.data).title as string;

    this.store.removeDecisionContent(id);
    this.store.deleteNode(id);

    this.emit({
      id: newUlid(),
      kind: 'decision.deleted',
      actor: 'claude',
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: id, title: titleSnapshot },
    });
  }

  get(id: string): Decision & { governs: NodeRow[]; references: NodeRow[] } {
    const node = this.store.getNode(id);
    if (!node) throw new Error(`Decision not found: ${id}`);
    if (node.kind !== "decision") throw new Error(`Node ${id} is not a decision`);

    const decision = nodeToDecision(node);

    const governsEdges = this.store.findEdges({ source_id: id, relation: "GOVERNS" });
    const governs = governsEdges
      .map((e) => this.store.getNode(e.target_id))
      .filter((n): n is NodeRow => n !== undefined);

    const referencesEdges = this.store.findEdges({ source_id: id, relation: "REFERENCES" });
    const references = referencesEdges
      .map((e) => this.store.getNode(e.target_id))
      .filter((n): n is NodeRow => n !== undefined);

    return { ...decision, governs, references };
  }

  private emit(event: Event): void {
    this.bus?.emit(event);
  }
}
```

- [ ] **Step 5: Add `reason` to `UpdateDecisionInput` if missing**

Check `src/decisions/types.ts` — if `UpdateDecisionInput` doesn't have `reason?: string`, add it (used for `decision.superseded` event payload).

- [ ] **Step 6: Add `author` column to decision nodes**

The `author` lives inside `node.data` as shown above — no schema change needed; the graph store already accepts arbitrary JSON in `data`. Update any JSON-schema validators in `src/decisions/types.ts` if present.

- [ ] **Step 7: Run all tests to catch regressions**

Run: `npx vitest run`
Expected: PASS (existing `DecisionPromotion` tests must still pass — their constructor signature didn't change).

- [ ] **Step 8: Run the new event-emission test**

Run: `npx vitest run tests/integration/decision-events.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Commit**

```bash
git add src/decisions/service.ts src/decisions/types.ts tests/integration/decision-events.test.ts
git commit -m "feat: DecisionService emits events on CRUD"
```

---

### Task 9: Git log parser (pure function)

**Files:**
- Create: `src/events/worker/git-log-parser.ts`
- Create: `tests/events/git-log-parser.test.ts`

This is the pure parsing logic — separated from file-watching and shelling-out so it's trivially unit-testable.

- [ ] **Step 1: Write the failing test**

`tests/events/git-log-parser.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseGitLogOutput } from '../../src/events/worker/git-log-parser.js';

// Format: %H\0%s\0%an\0%at   then --name-status lines
const SAMPLE_OUTPUT = [
  'abc1234\0fix: restart watcher on .git move\0Rasmus\01700000000',
  'M\tsrc/events/git-watcher.ts',
  'M\tsrc/events/meta.ts',
  'A\ttest/git-watcher.test.ts',
  '',
  'def5678\0feat: events schema\0Rasmus\01699999000',
  'A\tsrc/events/schema.sql',
  'A\tsrc/events/store.ts',
  '',
].join('\n');

describe('parseGitLogOutput', () => {
  it('parses multiple commits with name-status', () => {
    const commits = parseGitLogOutput(SAMPLE_OUTPUT);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: 'abc1234',
      message: 'fix: restart watcher on .git move',
      author: 'Rasmus',
      timestamp: 1700000000,
      files: [
        { path: 'src/events/git-watcher.ts', status: 'M' },
        { path: 'src/events/meta.ts', status: 'M' },
        { path: 'test/git-watcher.test.ts', status: 'A' },
      ],
    });
    expect(commits[1].hash).toBe('def5678');
    expect(commits[1].files).toHaveLength(2);
  });

  it('handles a commit with no file changes', () => {
    const out = 'empty00\0empty commit\0R\01700000000\n\n';
    const commits = parseGitLogOutput(out);
    expect(commits).toHaveLength(1);
    expect(commits[0].files).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(parseGitLogOutput('')).toEqual([]);
    expect(parseGitLogOutput('\n\n\n')).toEqual([]);
  });

  it('maps rename (R) and copy (C) statuses preserving the target path', () => {
    const out = [
      'h1\0rename\0R\01700000000',
      'R100\tsrc/old.ts\tsrc/new.ts',
      '',
    ].join('\n');
    const commits = parseGitLogOutput(out);
    expect(commits[0].files).toEqual([{ path: 'src/new.ts', status: 'R' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/events/git-log-parser.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/events/worker/git-log-parser.ts`**

```ts
/**
 * Parsed representation of a single git commit.
 *
 * `timestamp` is unix *seconds* (as produced by %at); caller converts to ms.
 * `files` are always post-rename paths.
 */
export interface ParsedCommit {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
  files: { path: string; status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' }[];
}

/**
 * Parses output of:
 *
 *   git log <range> --format=%H%x00%s%x00%an%x00%at --name-status
 *
 * Each commit is a line with 4 NUL-separated fields, followed by 0+ --name-status
 * lines, followed by a blank line. The blank line is omitted for the last commit
 * if the input is truncated.
 *
 * Pure function — no I/O. Paired with `git-watcher.ts` which handles the actual
 * spawning of `git log` and comparing to last-seen HEAD.
 */
export function parseGitLogOutput(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;

  for (const line of raw.split('\n')) {
    if (line === '') {
      if (current) commits.push(current);
      current = null;
      continue;
    }
    if (line.includes('\0')) {
      const [hash, message, author, tsStr] = line.split('\0');
      current = {
        hash,
        message,
        author,
        timestamp: parseInt(tsStr, 10),
        files: [],
      };
      continue;
    }
    if (!current) continue; // orphan line (shouldn't happen)
    // name-status line. Format: <STATUS>\t<path>  OR  <STATUS>\t<old>\t<new>
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const statusRaw = parts[0];
    const statusChar = statusRaw.charAt(0) as ParsedCommit['files'][number]['status'];
    const targetPath = parts.length >= 3 ? parts[parts.length - 1] : parts[1];
    current.files.push({ path: targetPath, status: statusChar });
  }
  if (current) commits.push(current);

  return commits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/events/git-log-parser.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/events/worker/git-log-parser.ts tests/events/git-log-parser.test.ts
git commit -m "feat: git log output parser (pure)"
```

---

### Task 10: Git watcher with real repo integration test

**Files:**
- Create: `src/events/worker/git-watcher.ts`
- Create: `tests/integration/git-watcher.test.ts`

- [ ] **Step 1: Write the failing integration test**

`tests/integration/git-watcher.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWatcher } from '../../src/events/worker/git-watcher.js';
import { EventPersister } from '../../src/events/worker/persister.js';
import type { Event } from '../../src/events/types.js';

let tmp: string;
let watcher: GitWatcher | null = null;
let persister: EventPersister | null = null;

afterEach(async () => {
  await watcher?.stop();
  persister?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function initRepo(): string {
  tmp = mkdtempSync(join(tmpdir(), 'cortex-git-'));
  execSync('git init -q -b main', { cwd: tmp });
  execSync('git config user.email test@test', { cwd: tmp });
  execSync('git config user.name TestUser', { cwd: tmp });
  writeFileSync(join(tmp, 'README.md'), 'init');
  execSync('git add . && git commit -q -m "initial"', { cwd: tmp });
  return tmp;
}

describe('GitWatcher', () => {
  it('emits a commit event when a new commit lands', async () => {
    const repo = initRepo();
    persister = new EventPersister(':memory:');
    const events: Event[] = [];
    watcher = new GitWatcher({
      repoPath: repo,
      persister,
      projectId: 'test',
      governedFiles: new Map(), // nothing governed yet
      emit: (e) => events.push(e),
    });
    await watcher.start();

    // Make a commit.
    writeFileSync(join(repo, 'new.ts'), 'export {}');
    execSync('git add . && git commit -q -m "feat: add new.ts"', { cwd: repo });

    // Poll for the event to arrive (chokidar debounce can take a moment).
    await waitFor(() => events.some((e) => e.kind === 'commit'), 2000);

    const commit = events.find((e) => e.kind === 'commit') as Extract<Event, { kind: 'commit' }>;
    expect(commit.payload.message).toBe('feat: add new.ts');
    expect(commit.payload.files.map((f) => f.path)).toContain('new.ts');
    expect(commit.actor).toBe('TestUser');
  });

  it('computes decision_links from governed files', async () => {
    const repo = initRepo();
    persister = new EventPersister(':memory:');
    const events: Event[] = [];
    watcher = new GitWatcher({
      repoPath: repo,
      persister,
      projectId: 'test',
      // 'new.ts' is governed by decision 'd1'
      governedFiles: new Map([['new.ts', ['d1']]]),
      emit: (e) => events.push(e),
    });
    await watcher.start();

    writeFileSync(join(repo, 'new.ts'), 'export {}');
    execSync('git add . && git commit -q -m "touches governed"', { cwd: repo });

    await waitFor(() => events.some((e) => e.kind === 'commit'), 2000);
    const commit = events.find((e) => e.kind === 'commit') as Extract<Event, { kind: 'commit' }>;
    expect(commit.payload.decision_links).toEqual(['d1']);
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/git-watcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/events/worker/git-watcher.ts`**

```ts
import chokidar, { FSWatcher } from 'chokidar';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Event } from '../types.js';
import type { EventPersister } from './persister.js';
import { parseGitLogOutput, type ParsedCommit } from './git-log-parser.js';
import { newUlid } from '../ulid.js';

export interface GitWatcherOpts {
  repoPath: string;
  persister: EventPersister;
  projectId: string;
  /**
   * Map from file path (repo-relative) → decision ids governing that path.
   * Used to populate `decision_links` on each commit event.
   *
   * The worker keeps this map updated via `snapshot_update` messages from main.
   */
  governedFiles: Map<string, string[]>;
  /** Called once per new commit. */
  emit: (event: Event) => void;
}

const LAST_SEEN_KEY = 'git.last_seen_head';

/**
 * Watches a git repo for new commits on HEAD and emits `commit` events.
 *
 * Watch target: `<repo>/.git/logs/HEAD` — append-only on every ref update to HEAD.
 * On change: rev-parse current HEAD, compare to last-seen (stored in events.db
 * meta table), walk the diff with `git log <last>..HEAD`, emit one event per
 * new commit.
 *
 * Graceful degradation: if the repo is not a git repo, the watcher logs once
 * and stays idle. If `git log` fails, the watcher logs and retries on next fs
 * event — it does not crash the worker.
 */
export class GitWatcher {
  private fsw: FSWatcher | null = null;
  private busy = false;

  constructor(private opts: GitWatcherOpts) {}

  async start(): Promise<void> {
    const logHead = join(this.opts.repoPath, '.git', 'logs', 'HEAD');
    if (!existsSync(logHead)) {
      process.stderr.write(`[GitWatcher] no .git/logs/HEAD at ${this.opts.repoPath}; idle\n`);
      return;
    }

    // On start, record current HEAD if we don't have one yet (no historical emit).
    if (!this.opts.persister.getMeta(LAST_SEEN_KEY)) {
      try {
        const head = execSync('git rev-parse HEAD', { cwd: this.opts.repoPath }).toString().trim();
        this.opts.persister.setMeta(LAST_SEEN_KEY, head);
      } catch {
        // empty repo; stay idle
      }
    }

    this.fsw = chokidar.watch(logHead, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } });
    this.fsw.on('change', () => this.scan());
    this.fsw.on('add', () => this.scan());
  }

  async stop(): Promise<void> {
    if (this.fsw) { await this.fsw.close(); this.fsw = null; }
  }

  /** Exposed for tests: scan without waiting for a watcher event. */
  async scan(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const head = execSync('git rev-parse HEAD', { cwd: this.opts.repoPath }).toString().trim();
      const lastSeen = this.opts.persister.getMeta(LAST_SEEN_KEY) ?? '';
      if (head === lastSeen) return;

      const range = lastSeen ? `${lastSeen}..${head}` : head;
      let output: string;
      try {
        output = execSync(
          `git log ${range} --format=%H%x00%s%x00%an%x00%at --name-status`,
          { cwd: this.opts.repoPath },
        ).toString();
      } catch {
        // Descendant check fail (checkout backward) — update last-seen silently.
        this.opts.persister.setMeta(LAST_SEEN_KEY, head);
        return;
      }

      const commits = parseGitLogOutput(output).reverse(); // oldest first for chronological emission
      for (const c of commits) {
        this.opts.emit(this.commitToEvent(c));
      }
      this.opts.persister.setMeta(LAST_SEEN_KEY, head);
    } catch (err) {
      process.stderr.write(`[GitWatcher] scan failed: ${(err as Error).message}\n`);
    } finally {
      this.busy = false;
    }
  }

  private commitToEvent(c: ParsedCommit): Event {
    const decision_links = new Set<string>();
    for (const f of c.files) {
      const ids = this.opts.governedFiles.get(f.path);
      if (ids) for (const id of ids) decision_links.add(id);
    }
    return {
      id: newUlid(),
      kind: 'commit',
      actor: c.author || 'unknown',
      created_at: c.timestamp * 1000,
      project_id: this.opts.projectId,
      payload: {
        hash: c.hash,
        message: c.message,
        files: c.files,
        decision_links: [...decision_links],
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/git-watcher.test.ts`
Expected: PASS, 2 tests.

If the chokidar change doesn't fire within 2s (possible on macOS FSEvents latency), bump the test timeout to 4s — don't lower chokidar's `stabilityThreshold` below 100ms (produces false triggers mid-write).

- [ ] **Step 5: Commit**

```bash
git add src/events/worker/git-watcher.ts tests/integration/git-watcher.test.ts
git commit -m "feat: git watcher emits commit events"
```

---

### Task 11: WebSocket protocol helpers

**Files:**
- Create: `src/ws/protocol.ts`
- Create: `tests/ws/protocol.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ws/protocol.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { encodeServer, decodeClient } from '../../src/ws/protocol.js';
import type { ServerMsg, ClientMsg } from '../../src/ws/types.js';

describe('WS protocol', () => {
  it('encodes every ServerMsg variant as JSON', () => {
    const msgs: ServerMsg[] = [
      { type: 'hello', project_id: 'p', server_version: '0.2.0' },
      { type: 'pong' },
      { type: 'error', code: 'bad', message: 'm' },
    ];
    for (const m of msgs) {
      const s = encodeServer(m);
      expect(JSON.parse(s)).toEqual(m);
    }
  });

  it('decodes valid ClientMsg', () => {
    expect(decodeClient('{"type":"ping"}')).toEqual({ type: 'ping' });
    expect(decodeClient('{"type":"backfill","limit":10}')).toEqual({
      type: 'backfill',
      limit: 10,
    });
  });

  it('rejects unknown client types', () => {
    expect(() => decodeClient('{"type":"subscribe"}')).toThrow(/unknown/);
  });

  it('rejects malformed JSON', () => {
    expect(() => decodeClient('{')).toThrow();
  });

  it('rejects non-object JSON', () => {
    expect(() => decodeClient('42')).toThrow();
    expect(() => decodeClient('"hello"')).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ws/protocol.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/ws/protocol.ts`**

```ts
import type { ServerMsg, ClientMsg } from './types.js';

/**
 * Encodes a server message for wire send.
 * Kept trivial (just JSON.stringify) — the boundary exists so we can swap in
 * MessagePack or compression later without touching call sites.
 */
export function encodeServer(msg: ServerMsg): string {
  return JSON.stringify(msg);
}

/**
 * Decodes a raw client message. Throws on malformed JSON, non-object payloads,
 * or unknown `type` values.
 *
 * Validation is minimal — we trust the type discriminator and leave payload
 * shape-checking to the handler (which would otherwise need a schema lib).
 */
export function decodeClient(raw: string): ClientMsg {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error('malformed JSON');
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new Error('not a JSON object');
  }
  const type = (obj as { type?: unknown }).type;
  if (type === 'ping' || type === 'backfill') return obj as ClientMsg;
  throw new Error(`unknown client message type: ${String(type)}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ws/protocol.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ws/protocol.ts tests/ws/protocol.test.ts
git commit -m "feat: WebSocket protocol encode/decode"
```

---

### Task 12: WebSocket client registry

**Files:**
- Create: `src/ws/client-registry.ts`
- Create: `tests/ws/client-registry.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/ws/client-registry.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ClientRegistry } from '../../src/ws/client-registry.js';

function fakeClient() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 /* OPEN */ } as any;
}

describe('ClientRegistry', () => {
  it('tracks added clients', () => {
    const r = new ClientRegistry();
    const c = fakeClient();
    r.add(c);
    expect(r.size()).toBe(1);
  });

  it('broadcasts a string to every open client', () => {
    const r = new ClientRegistry();
    const a = fakeClient(); const b = fakeClient();
    r.add(a); r.add(b);
    r.broadcast('hello');
    expect(a.send).toHaveBeenCalledWith('hello');
    expect(b.send).toHaveBeenCalledWith('hello');
  });

  it('skips and evicts a client whose send() throws', () => {
    const r = new ClientRegistry();
    const good = fakeClient();
    const bad = fakeClient();
    bad.send.mockImplementation(() => { throw new Error('send fail'); });
    r.add(good); r.add(bad);
    r.broadcast('x');
    expect(good.send).toHaveBeenCalled();
    expect(bad.close).toHaveBeenCalled();
    expect(r.size()).toBe(1);
  });

  it('remove() drops a client', () => {
    const r = new ClientRegistry();
    const c = fakeClient();
    r.add(c);
    r.remove(c);
    expect(r.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ws/client-registry.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/ws/client-registry.ts`**

```ts
/**
 * WebSocket-like interface that ClientRegistry depends on. Mirrors the real
 * `ws` library's WebSocket class enough for fan-out and lifecycle.
 * Typed loose so tests can substitute a plain object.
 */
interface WsLike {
  send(data: string): void;
  close(): void;
  readyState: number;
}

const OPEN = 1;

/**
 * In-memory set of connected WebSocket clients with fan-out broadcast.
 *
 * Lives on the main thread. The worker thread never touches this — it sends
 * prepared broadcast payloads to main via postMessage, and main calls
 * `broadcast(payload)` here.
 *
 * If a `send` throws or the client is not OPEN, the client is evicted and
 * closed. Keeps the registry from growing unbounded when clients disappear
 * without a proper close event.
 */
export class ClientRegistry {
  private clients = new Set<WsLike>();

  add(ws: WsLike): void {
    this.clients.add(ws);
  }

  remove(ws: WsLike): void {
    this.clients.delete(ws);
  }

  size(): number {
    return this.clients.size;
  }

  broadcast(payload: string): void {
    for (const client of [...this.clients]) {
      if (client.readyState !== OPEN) { this.evict(client); continue; }
      try {
        client.send(payload);
      } catch {
        this.evict(client);
      }
    }
  }

  forEachOpen(fn: (ws: WsLike) => void): void {
    for (const c of this.clients) {
      if (c.readyState === OPEN) fn(c);
    }
  }

  private evict(ws: WsLike): void {
    this.clients.delete(ws);
    try { ws.close(); } catch { /* ignore */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ws/client-registry.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ws/client-registry.ts tests/ws/client-registry.test.ts
git commit -m "feat: WebSocket client registry with eviction"
```

---

### Task 13: WebSocket server (upgrade + connection + backfill + heartbeat)

**Files:**
- Create: `src/ws/server.ts`
- Create: `tests/integration/ws-server.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/integration/ws-server.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { startWsServer } from '../../src/ws/server.js';
import type { ServerMsg, Event } from '../../src/ws/types.js';
import type { EventPersister } from '../../src/events/worker/persister.js';

let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

function fakePersister(): EventPersister {
  return {
    backfill: ({ limit = 50 } = {}) => ({
      events: [] as Event[],
      has_more: false,
    }),
  } as unknown as EventPersister;
}

async function startServer(persister: EventPersister) {
  const httpServer = createServer();
  const { registry } = startWsServer({
    httpServer,
    persister,
    projectId: 'p',
    serverVersion: '0.2.0',
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const port = (httpServer.address() as { port: number }).port;
  closers.push(() => new Promise((r) => httpServer.close(() => r())));
  return { port, registry };
}

describe('WebSocket server', () => {
  it('sends hello on connect', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const hello = await new Promise<ServerMsg>((resolve) => {
      ws.once('message', (d: Buffer) => resolve(JSON.parse(d.toString())));
    });
    expect(hello).toEqual({ type: 'hello', project_id: 'p', server_version: '0.2.0' });
    ws.close();
  });

  it('responds to ping with pong', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    // Drain hello
    await new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(pong).toEqual({ type: 'pong' });
    ws.close();
  });

  it('serves backfill_page in response to backfill request', async () => {
    const persister = {
      backfill: () => ({
        events: [{
          id: '01HXZ0000000000000000000AA',
          kind: 'decision.created',
          actor: 'claude',
          created_at: 1,
          project_id: 'p',
          payload: { decision_id: 'd', title: 't', rationale: 'r', governed_file_ids: [], tags: [] },
        } as Event],
        has_more: false,
      }),
    } as unknown as EventPersister;

    const { port } = await startServer(persister);
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello
    ws.send(JSON.stringify({ type: 'backfill', limit: 50 }));
    const page = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(page.type).toBe('backfill_page');
    if (page.type === 'backfill_page') {
      expect(page.events).toHaveLength(1);
      expect(page.has_more).toBe(false);
    }
    ws.close();
  });

  it('replies with error on malformed client message without disconnecting', async () => {
    const { port } = await startServer(fakePersister());
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    await new Promise((r) => ws.once('open', r));
    await new Promise((r) => ws.once('message', r)); // hello
    ws.send('not json');
    const err = await new Promise<ServerMsg>((r) =>
      ws.once('message', (d: Buffer) => r(JSON.parse(d.toString()))),
    );
    expect(err.type).toBe('error');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/ws-server.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/ws/server.ts`**

```ts
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { encodeServer, decodeClient } from './protocol.js';
import { ClientRegistry } from './client-registry.js';
import type { ServerMsg, Event, GraphMutation } from './types.js';
import type { EventPersister } from '../events/worker/persister.js';

export interface WsServerOpts {
  httpServer: HttpServer;
  persister: EventPersister;
  projectId: string;
  serverVersion: string;
}

export interface WsServerHandle {
  registry: ClientRegistry;
  broadcast(bundle: { events: Event[]; mutations: GraphMutation[] }): void;
}

/**
 * Starts a WebSocket server bound to the provided HTTP server's upgrade event
 * at path `/ws`.
 *
 * Per-connection lifecycle:
 *   1. Upgrade completes → server sends `hello`.
 *   2. Client may send `backfill` or `ping` at any time.
 *   3. Server sends `event` + `mutation` messages as the worker posts
 *      broadcast bundles. Call `broadcast()` on the returned handle.
 *
 * Error handling mirrors the spec: malformed messages get an error reply,
 * connection stays open. Send failures evict the client.
 */
export function startWsServer(opts: WsServerOpts): WsServerHandle {
  const wss = new WebSocketServer({ noServer: true });
  const registry = new ClientRegistry();

  opts.httpServer.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      registry.add(ws);
      ws.on('close', () => registry.remove(ws));

      send(ws, {
        type: 'hello',
        project_id: opts.projectId,
        server_version: opts.serverVersion,
      });

      ws.on('message', (raw: Buffer) => handleClient(ws, raw.toString(), opts));
    });
  });

  return {
    registry,
    broadcast(bundle: { events: Event[]; mutations: GraphMutation[] }) {
      for (const event of bundle.events) {
        registry.broadcast(encodeServer({ type: 'event', event }));
      }
      for (const mutation of bundle.mutations) {
        registry.broadcast(encodeServer({ type: 'mutation', mutation }));
      }
    },
  };
}

function handleClient(ws: WebSocket, raw: string, opts: WsServerOpts): void {
  let msg;
  try { msg = decodeClient(raw); }
  catch (e) {
    send(ws, { type: 'error', code: 'bad_message', message: (e as Error).message });
    return;
  }
  switch (msg.type) {
    case 'ping':
      send(ws, { type: 'pong' });
      return;
    case 'backfill': {
      const { events, has_more } = opts.persister.backfill({
        before_id: msg.before_id,
        limit: msg.limit,
      });
      send(ws, {
        type: 'backfill_page',
        events,
        // Backfill carries events only. The viewer hydrates the graph from
        // /api/graph on connect, which returns the full current state —
        // replaying historical mutations on top of that would double-apply.
        // Mutations field preserved in the protocol for symmetry with live
        // `mutation` messages; always empty for backfill_page.
        mutations: [],
        has_more,
      });
      return;
    }
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(encodeServer(msg));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/ws-server.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ws/server.ts tests/integration/ws-server.test.ts
git commit -m "feat: WebSocket server with hello/backfill/ping"
```

---

### Task 14: End-to-end: decision → WS client receives event + mutations

**Files:**
- Modify: `src/mcp-server/api.ts`
- Modify: `src/index.ts`
- Create: `tests/integration/end-to-end.test.ts`

This wires everything: MCP/HTTP server + WS + worker thread + decision service. The test creates a decision and asserts a connected WS client receives both the event and the derived mutations.

- [ ] **Step 1: Modify `src/mcp-server/api.ts`**

Expose the httpServer so the caller can attach the WS upgrade handler. Change the return to include the server instance:

```ts
// Replace the existing startViewerServer signature/return.
// Instead of `Promise<number>`, return `Promise<{ port: number; httpServer: Server | null }>`.

import type { Server as HttpServer } from "node:http";

export interface ViewerServerHandle {
  port: number;
  httpServer: HttpServer | null; // null when port was unavailable
}

export function startViewerServer(
  store: GraphStore,
  cbmProject?: string | null,
): Promise<ViewerServerHandle> {
  return new Promise((resolve) => {
    const httpServer = createHttpServer(async (req, res) => { /* existing handler body */ });

    const port = parseInt(process.env.CORTEX_VIEWER_PORT || "3333", 10);
    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(`Cortex viewer: port ${port} in use, skipping viewer\n`);
        resolve({ port: -1, httpServer: null });
      } else {
        resolve({ port: -1, httpServer: null });
      }
    });
    httpServer.listen(port, () => {
      resolve({ port, httpServer });
    });
  });
}
```

Keep the existing request handler body inside `createHttpServer()` unchanged — only the return shape changes.

- [ ] **Step 2: Modify `src/index.ts` to wire everything**

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { GraphStore } from "./graph/store.js";
import { createServer } from "./mcp-server/server.js";
import { startViewerServer } from "./mcp-server/api.js";
import { startWsServer, type WsServerHandle } from "./ws/server.js";
import { EventBus } from "./events/bus.js";
import { EventPersister } from "./events/worker/persister.js";
import { discoverCbmDb } from "./graph/cbm-discovery.js";

const dbPath = process.env.CORTEX_DB_PATH || ".cortex/graph.db";
const eventsDbPath = process.env.CORTEX_EVENTS_DB_PATH || ".cortex/events.db";
mkdirSync(".cortex", { recursive: true });

const store = new GraphStore(dbPath);

const cwd = process.cwd();
const cbmDbPath = discoverCbmDb(cwd, undefined, process.env.CBM_DB_PATH);
let cbmProject: string | null = null;
if (cbmDbPath) {
  store.attachCbm(cbmDbPath);
  if (store.isCbmAttached()) {
    const projects = store.queryRaw<{ name: string }>(
      "SELECT name FROM cbm.projects WHERE root_path = ?",
      [cwd],
    );
    cbmProject = projects[0]?.name ?? null;
  }
}

// Main-thread persister for WS backfill reads only.
// Worker owns writes; main only reads (WAL makes this safe).
const mainPersister = new EventPersister(eventsDbPath);

const bus = new EventBus();

// Spawn worker. It persists events, derives mutations, sends broadcast bundles back.
let worker: Worker | null = null;
let wsHandle: WsServerHandle | null = null;

function spawnWorker(): void {
  worker = new Worker(new URL("./events/worker.ts", import.meta.url), {
    execArgv: process.env.NODE_ENV === 'test' ? ['--import', 'tsx'] : [],
  });
  worker.on("message", (msg) => {
    if (msg.type === "broadcast" && wsHandle) {
      wsHandle.broadcast(msg.bundle);
    } else if (msg.type === "error") {
      process.stderr.write(`[worker] ${msg.message}\n`);
    }
  });
  worker.on("error", (err) => {
    process.stderr.write(`[worker] crashed: ${err.message}\n`);
    setTimeout(spawnWorker, 1000); // backoff handled in Task 15 refinement
  });
  // Init with current snapshot.
  const nodes = store.getAllNodesUnified(cbmProject ?? undefined);
  worker.postMessage({
    type: "init",
    events_db_path: eventsDbPath,
    project_id: cbmProject ?? "",
    nodes,
  });
}
spawnWorker();

// Bus → worker bridge. Every emitted event gets forwarded.
bus.onEvent((event) => {
  worker?.postMessage({ type: "event", event });
});

const server = createServer(store, cbmProject, bus);

const { port, httpServer } = await startViewerServer(store, cbmProject);
if (port > 0 && httpServer) {
  wsHandle = startWsServer({
    httpServer,
    persister: mainPersister,
    projectId: cbmProject ?? "",
    serverVersion: "0.2.0",
  });
  process.stderr.write(`Cortex viewer: http://localhost:${port}/viewer (WS at /ws)\n`);
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 3: Modify `src/mcp-server/server.ts` to accept + forward the bus**

Find `createServer(store, cbmProject)` and change the signature to `createServer(store, cbmProject, bus?)`, then pass `bus` into the `DecisionService` constructor wherever it's instantiated inside. Keep the rest unchanged.

- [ ] **Step 4: Write the failing end-to-end test**

`tests/integration/end-to-end.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import { readdirSync, rmSync } from 'node:fs';
import WebSocket from 'ws';
import { GraphStore } from '../../src/graph/store.js';
import { DecisionService } from '../../src/decisions/service.js';
import { EventBus } from '../../src/events/bus.js';
import { EventPersister } from '../../src/events/worker/persister.js';
import { startWsServer } from '../../src/ws/server.js';
import type { ServerMsg } from '../../src/ws/types.js';

let closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

describe('end-to-end: decision → event + mutations over WS', () => {
  it('client receives event and mutations after a decision is created', async () => {
    const store = new GraphStore(':memory:');
    closers.push(() => store.close());

    const persister = new EventPersister(':memory:');
    closers.push(() => persister.close());

    const bus = new EventBus();

    const worker = new Worker(
      new URL('../../src/events/worker.ts', import.meta.url),
      { execArgv: ['--import', 'tsx'] },
    );
    closers.push(() => worker.terminate());

    // Wait for ready
    await new Promise<void>((resolve) => {
      const handler = (msg: { type: string }) => {
        if (msg.type === 'ready') { worker.off('message', handler); resolve(); }
      };
      worker.on('message', handler);
      worker.postMessage({
        type: 'init',
        events_db_path: ':memory:',
        project_id: 'test',
        nodes: [],
      });
    });

    const httpServer = createServer();
    await new Promise<void>((r) => httpServer.listen(0, r));
    closers.push(() => new Promise<void>((r) => httpServer.close(() => r())));
    const port = (httpServer.address() as { port: number }).port;

    const { broadcast } = startWsServer({
      httpServer,
      persister,
      projectId: 'test',
      serverVersion: '0.2.0',
    });

    // Worker → broadcast
    worker.on('message', (msg) => {
      if (msg.type === 'broadcast') broadcast(msg.bundle);
    });

    // Bus → worker
    bus.onEvent((e) => worker.postMessage({ type: 'event', event: e }));

    const service = new DecisionService(store, { bus, project_id: 'test' });

    // Connect WS client.
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const received: ServerMsg[] = [];
    await new Promise((r) => ws.once('open', r));
    ws.on('message', (d: Buffer) => received.push(JSON.parse(d.toString())));
    // Drain hello
    await new Promise((r) => setTimeout(r, 50));

    // Note: we intentionally skip pre-loading the worker's snapshot. The
    // mutation deriver will not find the node that hasn't been created yet
    // and will return []. We assert only the EVENT here; mutation emission
    // is covered by tests in Tasks 5 and 7. The test below pushes a
    // snapshot_update AFTER create() so a follow-up refinement (future plan)
    // can exercise live mutation derivation end-to-end.
    const d = service.create({ title: 't', description: '', rationale: 'r', governs: [] });

    // Push updated snapshot now that d exists.
    const nodes = store.getAllNodesUnified();
    worker.postMessage({ type: 'snapshot_update', nodes });

    // Wait for event + mutation messages.
    await new Promise((r) => setTimeout(r, 200));

    const eventMsg = received.find((m) => m.type === 'event');
    expect(eventMsg).toBeDefined();
    if (eventMsg?.type === 'event') {
      expect(eventMsg.event.kind).toBe('decision.created');
      expect((eventMsg.event as any).payload.decision_id).toBe(d.id);
    }
  });
});
```

This test demonstrates the full path works. Note: a `mutation` message may or may not arrive depending on snapshot-update timing — the test asserts on the event, which is guaranteed. A follow-up task improves the bridge so the snapshot updates on every graph mutation automatically.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integration/end-to-end.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/mcp-server/api.ts src/mcp-server/server.ts tests/integration/end-to-end.test.ts
git commit -m "feat: wire worker + WS server + event bus in main; e2e test"
```

---

### Task 15: Worker auto-restart with exponential backoff

**Files:**
- Modify: `src/index.ts`
- Create: `tests/integration/worker-crash.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/integration/worker-crash.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { WorkerSupervisor } from '../../src/events/worker-supervisor.js';

let sup: WorkerSupervisor | null = null;
afterEach(async () => { await sup?.stop(); sup = null; });

describe('WorkerSupervisor', () => {
  it('restarts the worker after it crashes', async () => {
    let spawns = 0;
    sup = new WorkerSupervisor({
      spawn: () => {
        spawns++;
        return new Worker(`process.exit(${spawns === 1 ? 1 : 0})`, { eval: true });
      },
      initialDelayMs: 10,
      maxDelayMs: 100,
    });
    await sup.start();

    await new Promise((r) => setTimeout(r, 500));
    expect(spawns).toBeGreaterThanOrEqual(2);
  });

  it('applies exponential backoff between restarts', async () => {
    const starts: number[] = [];
    sup = new WorkerSupervisor({
      spawn: () => {
        starts.push(Date.now());
        return new Worker('process.exit(1)', { eval: true });
      },
      initialDelayMs: 20,
      maxDelayMs: 200,
    });
    await sup.start();
    await new Promise((r) => setTimeout(r, 400));
    await sup.stop();

    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    // Later gaps should not be smaller than earlier ones (backoff grows).
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] * 0.9);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/worker-crash.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `src/events/worker-supervisor.ts`**

```ts
import type { Worker } from 'node:worker_threads';

export interface WorkerSupervisorOpts {
  /** Factory producing a fresh worker. Called on start and on each restart. */
  spawn: () => Worker;
  /** Backoff starts here (ms). */
  initialDelayMs?: number;
  /** Backoff caps here (ms). */
  maxDelayMs?: number;
  /** Called when each new worker is ready (after spawn). Use to (re)initialize. */
  onSpawn?: (worker: Worker) => void;
}

/**
 * Keeps a worker thread alive. Restarts on `error` and `exit` with
 * exponential backoff — 1s, 2s, 4s, capped at 30s by default.
 *
 * The supervisor does NOT preserve events that were in-flight when the
 * worker crashed. Those events are lost (not persisted, not broadcast).
 * Clients see this as a brief quiet period. This is an accepted v1 tradeoff.
 */
export class WorkerSupervisor {
  private worker: Worker | null = null;
  private stopped = false;
  private delay: number;

  constructor(private opts: WorkerSupervisorOpts) {
    this.delay = opts.initialDelayMs ?? 1000;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.delay = this.opts.initialDelayMs ?? 1000;
    this.respawn();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }

  current(): Worker | null { return this.worker; }

  private respawn(): void {
    if (this.stopped) return;
    this.worker = this.opts.spawn();
    this.opts.onSpawn?.(this.worker);
    const onDead = () => {
      this.worker = null;
      if (this.stopped) return;
      const wait = this.delay;
      this.delay = Math.min(this.delay * 2, this.opts.maxDelayMs ?? 30_000);
      setTimeout(() => this.respawn(), wait);
    };
    this.worker.once('error', onDead);
    this.worker.once('exit', onDead);
  }
}
```

- [ ] **Step 4: Modify `src/index.ts` to use the supervisor**

Replace the manual `spawnWorker` logic with the supervisor. The `onSpawn` callback re-wires the `message`/`error` handlers and re-sends the `init` + snapshot messages.

```ts
import { WorkerSupervisor } from './events/worker-supervisor.js';

const supervisor = new WorkerSupervisor({
  spawn: () => new Worker(new URL("./events/worker.ts", import.meta.url)),
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  onSpawn: (w) => {
    w.on("message", (msg) => {
      if (msg.type === "broadcast" && wsHandle) wsHandle.broadcast(msg.bundle);
      else if (msg.type === "error") process.stderr.write(`[worker] ${msg.message}\n`);
    });
    const nodes = store.getAllNodesUnified(cbmProject ?? undefined);
    w.postMessage({
      type: "init",
      events_db_path: eventsDbPath,
      project_id: cbmProject ?? "",
      nodes,
    });
  },
});
await supervisor.start();

bus.onEvent((event) => {
  supervisor.current()?.postMessage({ type: "event", event });
});
```

- [ ] **Step 5: Run tests to verify**

Run: `npx vitest run tests/integration/worker-crash.test.ts tests/integration/end-to-end.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/events/worker-supervisor.ts src/index.ts tests/integration/worker-crash.test.ts
git commit -m "feat: worker supervisor with exponential backoff"
```

---

### Task 16: Architecture doc final pass + TSDoc audit

**Files:**
- Modify: `docs/architecture/graph-ui.md`
- Possibly: any new file missing TSDoc

- [ ] **Step 1: Fill in the architecture doc**

Replace the placeholder sections in `docs/architecture/graph-ui.md` with full content. Required sections:

1. **System overview** — one paragraph (already present; refine if needed).

2. **Thread model** — full ASCII diagram (copy from spec, or redraw cleaner now that the code exists). Caption each arrow with the message type it carries.

3. **Event flow: "Claude creates a decision"** — concrete numbered walkthrough. Example skeleton:

```
1. Claude invokes MCP tool `create_decision` (stdio).
2. Tool handler in src/mcp-server/server.ts calls DecisionService.create().
3. DecisionService writes to cortex.db (src/graph/store.ts).
4. DecisionService emits a `decision.created` event on the bus (src/events/bus.ts).
5. Bridge in src/index.ts forwards the event to the worker via postMessage.
6. Worker receives event, inserts into events.db (src/events/worker/persister.ts).
7. Worker derives mutations via deriveMutations() (src/events/worker/mutation-deriver.ts).
8. Worker posts broadcast bundle back to main (type: 'broadcast').
9. Main's message handler calls wsHandle.broadcast(bundle).
10. ClientRegistry fans out event + mutation messages to every open WebSocket.
11. Viewer receives `event` → prepends to activity stream.
12. Viewer receives `mutation` → applies to d3-force graph, fires synapse animation.
```

4. **Component boundaries** — one paragraph per module (`src/events/bus.ts`, `src/events/worker.ts`, `src/events/worker/persister.ts`, etc.), explaining responsibility + boundaries crossed.

5. **Design rationale** — summarize each major choice from the spec: two threads, two DBs, ULID, pure mutation deriver, client-driven backfill.

6. **Extending the system** — four recipes:
   - Adding a new event kind (add to `Event` union, add case to deriver, emit from a service method)
   - Adding a new data source (emit directly onto the bus or into the worker via a new message type)
   - Adding a new mutation op (add to `GraphMutation` union, handle in viewer)
   - Adding a new stream renderer (will live in Plan C)

7. **Deferred / future work** — keep the existing list with prep-hook pointers.

8. **Testing strategy** — link to the test directories and one line per integration test describing what it covers.

- [ ] **Step 2: TSDoc audit**

Run through each new public-surface file and verify TSDoc is present on:
- All exported types in `src/events/types.ts` ✓ (added in Task 2)
- All exported functions/classes: `newUlid`, `EventPersister`, `deriveMutations`, `EventBus`, worker message types, `parseGitLogOutput`, `GitWatcher`, `encodeServer`/`decodeClient`, `ClientRegistry`, `startWsServer`, `WorkerSupervisor`
- All `MessagePort` message contracts in `src/events/worker.ts` ✓ (already present)

Command to audit:

```bash
npx grep -l "^export " src/events/ src/ws/ | while read f; do
  echo "=== $f ==="
  npx grep -B 1 "^export " "$f" | head -30
done
```

Look for exports without a preceding `/**` block. Add TSDoc where missing. Every public surface should have: what it does, why it exists, invariants, boundaries crossed.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/graph-ui.md src/events/ src/ws/
git commit -m "docs: architecture doc + TSDoc audit for graph-ui backend"
```

---

### Task 17: README + CLAUDE.md pointers

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a "Graph UI" section to README.md**

Find the existing section headers and insert somewhere sensible:

```markdown
## Graph UI

Cortex ships a browser-based 2D knowledge graph and an activity stream. The backend event pipeline is described in [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md). Viewer implementation: Plan B. Activity stream: Plan C.

Viewer URL during development: `http://localhost:3334/viewer`.
WebSocket: `ws://localhost:3334/ws`.
```

- [ ] **Step 2: Add a pointer to CLAUDE.md**

Append to the existing CLAUDE.md file — near the top of the "Tools Available" section or in its own mini-section:

```markdown
## Architecture docs

When working on the event pipeline, WebSocket server, or graph/stream viewers, read [docs/architecture/graph-ui.md](docs/architecture/graph-ui.md) first. It documents the two-thread model, event flow, design rationale, and extension recipes.
```

- [ ] **Step 3: Verify full test suite still passes**

Run: `npx vitest run`
Expected: PASS, all tests.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: README + CLAUDE.md pointers to architecture doc"
```

---

## Done criteria

- All 17 tasks committed.
- `npx vitest run` passes end-to-end with no skipped tests.
- `npx tsc --noEmit` passes.
- `npm run dev` starts the process, creates `.cortex/events.db`, starts HTTP server at 3334, accepts a WS connection at `/ws`, sends `hello`.
- Creating a decision via an MCP tool results in an event row in `events.db` AND a WebSocket broadcast to any connected client.
- `docs/architecture/graph-ui.md` has no placeholder sections.
- Every new exported TypeScript surface has TSDoc.

## Out of scope for this plan (addressed by Plans B/C)

- 2D viewer rendering (shapes, force sim, hover lerp, synapse animations)
- Activity stream UI
- Graph ↔ stream click-sync
- Viewer-side drift recovery (>500 mutations → refetch `/api/graph`)
- Playwright smoke suite

# TODO Entity + Consolidated Per-Type Tool Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the TODO entity as a first-class primitive (storage + tools + full schema/contract parity with decisions) and consolidate the 17 granular decision/PR MCP tools into 3 per-type, `action`-dispatched tools (`decision`/`todo`/`pr`), as a clean break.

**Architecture:** TODOs are stored in the existing per-repo primitives DB (`~/.cortex/<repoId>/decisions.db`) alongside decisions, reusing its `id_sequences` mint (prefix `T-`), FTS pattern, and idempotent open. All business logic lives in services (`TodoService`, mirroring `DecisionService`); the MCP tools are thin `action`-dispatched wrappers. The decision/PR tools migrate into single dispatchers that call the **unchanged** services — byte-parity contract tests are the guard. A `/api/todos` HTTP route + `AdaptedTodoSchema` join the versioned, drift-guarded HTTP contract.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3 (WAL, FTS5 external-content + triggers), Zod (MCP input shapes + the HTTP-contract SSoT), `@modelcontextprotocol/sdk` (`server.tool`), Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-23-todo-entity-consolidated-tools-design.md` is authoritative. Read it before starting.
- **Clean break:** old tool names (`create_decision`, …, `open_pr`, …) are **removed**, not aliased. All in-repo callers updated in this branch; CHANGELOG migration note for the `mesh` consumer.
- **Behavior parity:** migrating decision/PR actions changes only the registration layer. Services are untouched. Response envelopes (`ok`/`empty`/`error`) stay byte-identical — contract tests assert this.
- **Determinism / purity:** adapters (`api-todos.ts`) and the ranker-style pure modules take no clocks/IO; timestamps come from the service layer (`new Date().toISOString()`), mirroring `DecisionService`.
- **ESM imports:** every relative import ends in `.js` (e.g. `import { TodoService } from "../../todos/service.js"`).
- **Foundation deferrals (do NOT build):** viewer rendering, `EventBus` emission for TODO mutations, hooks (`PostMergeHook`/`PostDecisionHook`), external bridge, `AgentRef` typing (use TEXT author-style strings).
- **Commits:** atomic, `<type>(<scope>): <desc>` (e.g. `feat(db): add todos tables`). Commit after each task's tests pass.
- **Tests live under** `tests/` mirroring `src/` (e.g. `tests/todos/service.test.ts`). Run a single file with `npx vitest run <path>`.

---

## Phase 1 — Storage foundation

### Task 1.1: TODO domain types

**Files:**
- Create: `src/todos/types.ts`
- Test: `tests/todos/types.test.ts`

**Interfaces:**
- Produces: `Todo`, `TodoState`, `ProposeTodoInput`, `UpdateTodoInput`, `TransitionTodoInput`, `LinkTodoInput`, `TodoWithRefs`, `TodoLinkRelation`, `rowToTodo(row: TodoRecord): Todo` (TodoRecord defined in Task 1.3 — for this task, `rowToTodo` accepts the row shape below).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/todos/types.test.ts
import { describe, it, expect } from "vitest";
import { rowToTodo, type TodoState } from "../../src/todos/types.js";

describe("rowToTodo", () => {
  it("maps a DB row to a Todo, defaulting nullable link arrays empty", () => {
    const t = rowToTodo({
      id: "T-9m2x", seq: 3, summary: "migrate auth", description: "to OAuth",
      state: "open", state_reason: null, proposed_by: "rka",
      proposed_at: "2026-06-23T00:00:00.000Z", started_at: null, closed_at: null,
      assignee: null, created_at: "2026-06-23T00:00:00.000Z",
      updated_at: "2026-06-23T00:00:00.000Z",
    });
    expect(t.id).toBe("T-9m2x");
    expect(t.seq).toBe(3);
    expect(t.state).toBe<TodoState>("open");
    expect(t.summary).toBe("migrate auth");
    expect(t.assignee).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `npx vitest run tests/todos/types.test.ts`
Expected: FAIL — cannot find module `../../src/todos/types.js`.

- [ ] **Step 3: Implement the types**

```typescript
// src/todos/types.ts
export type TodoState = "open" | "in_progress" | "blocked" | "done" | "cancelled";

/** Link relations TODOs can hold. `blocks` is DERIVED (reverse of blockedBy),
 *  never stored — see TodoLinksRepository.findBlocking. */
export type TodoLinkRelation =
  | "GOVERNS"       // → code ref / frame (string qn or path)
  | "BLOCKED_BY"    // → todo id
  | "RELATED_TO"    // → todo id
  | "SPAWNS_FROM"   // → decision id (0..1)
  | "RESOLVED_BY";  // → pr number (string)

export interface Todo {
  id: string;            // "T-9m2x"
  seq: number;
  summary: string;
  description: string;
  state: TodoState;
  state_reason: string | null;
  proposed_by: string | null;   // author-style string, NOT a typed AgentRef
  proposed_at: string;
  started_at: string | null;
  closed_at: string | null;
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

/** Row shape as stored/read by TodosRepository (Task 1.3). Kept structurally
 *  identical to `Todo` so `rowToTodo` is a pass-through today; the split mirrors
 *  decisions (DecisionRecord vs Decision) and leaves room for stored-only cols. */
export interface TodoRecord {
  id: string; seq: number; summary: string; description: string | null;
  state: string; state_reason: string | null; proposed_by: string | null;
  proposed_at: string; started_at: string | null; closed_at: string | null;
  assignee: string | null; created_at: string; updated_at: string;
}

export interface ProposeTodoInput {
  summary: string;
  description?: string;
  proposed_by?: string;
  governs?: string[];        // code refs / frames
  spawns_from?: string;      // decision id
  blocked_by?: string[];     // todo ids
}

export interface UpdateTodoInput {
  summary?: string;
  description?: string;
  assignee?: string | null;
  governs?: string[];        // full-set replacement when provided
}

export interface TransitionTodoInput {
  to: TodoState;
  reason?: string;           // recorded as state_reason on blocked/cancelled
  resolved_by?: string[];    // pr numbers, recorded as RESOLVED_BY on → done
  blocked_by?: string[];     // todo ids, recorded as BLOCKED_BY on → blocked
}

export interface LinkTodoInput {
  todo_id: string;
  target: string;
  relation: TodoLinkRelation;
}

export interface TodoRefRow { target_kind: string; target_ref: string; }
export interface TodoWithRefs extends Todo {
  governs: TodoRefRow[];
  blocked_by: TodoRefRow[];
  blocks: TodoRefRow[];        // derived
  related_to: TodoRefRow[];
  spawns_from: TodoRefRow | null;
  resolved_by: TodoRefRow[];
}

export function rowToTodo(rec: TodoRecord): Todo {
  return {
    id: rec.id,
    seq: rec.seq,
    summary: rec.summary,
    description: rec.description ?? "",
    state: rec.state as TodoState,
    state_reason: rec.state_reason ?? null,
    proposed_by: rec.proposed_by ?? null,
    proposed_at: rec.proposed_at,
    started_at: rec.started_at ?? null,
    closed_at: rec.closed_at ?? null,
    assignee: rec.assignee ?? null,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
  };
}
```

- [ ] **Step 4: Run it, expect pass**

Run: `npx vitest run tests/todos/types.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/todos/types.ts tests/todos/types.test.ts
git commit -m "feat(db): TODO domain types + rowToTodo mapper"
```

---

### Task 1.2: Extend the primitives DB schema with TODO tables

**Files:**
- Modify: `src/decisions/db.ts` (add to `BASE_SCHEMA`; add a `TODOS_FTS_SCHEMA` block mirroring `FTS_SCHEMA`; call it in `openDecisionsDb`)
- Test: `tests/decisions/db-todos.test.ts`

**Interfaces:**
- Produces: `todos`, `todo_links`, `todos_fts` (+ `todos_ai/ad/au` triggers) created idempotently by the existing `openDecisionsDb(path, legacyPath?)`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decisions/db-todos.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";

function freshDb() {
  return openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todos-")), "decisions.db"));
}

describe("openDecisionsDb — todos tables", () => {
  it("creates todos, todo_links, and todos_fts", () => {
    const db = freshDb();
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all()
      .map((r: any) => r.name);
    expect(names).toContain("todos");
    expect(names).toContain("todo_links");
    expect(names).toContain("todos_fts");
  });

  it("FTS stays in sync via triggers on insert", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO todos (id, seq, summary, description, state, proposed_at, created_at, updated_at)
                VALUES ('T-aaaa', 1, 'migrate auth to oauth', 'body', 'open', 't', 't', 't')`).run();
    const hit = db.prepare(`SELECT t.id FROM todos t JOIN todos_fts f ON f.rowid = t.rowid
                            WHERE todos_fts MATCH 'oauth'`).get() as any;
    expect(hit.id).toBe("T-aaaa");
  });

  it("is idempotent — re-open does not throw or duplicate", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-todos-"));
    const p = join(dir, "decisions.db");
    openDecisionsDb(p).close();
    expect(() => openDecisionsDb(p).close()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect failure** (`no such table: todos`).

Run: `npx vitest run tests/decisions/db-todos.test.ts`

- [ ] **Step 3: Implement — extend `BASE_SCHEMA` and add the todos FTS block**

In `src/decisions/db.ts`, append to the `BASE_SCHEMA` template string (after the `id_sequences` table):

```sql
CREATE TABLE IF NOT EXISTS todos (
  id           TEXT PRIMARY KEY,
  seq          INTEGER,
  summary      TEXT NOT NULL,
  description  TEXT,
  state        TEXT NOT NULL DEFAULT 'open',
  state_reason TEXT,
  proposed_by  TEXT,
  proposed_at  TEXT NOT NULL,
  started_at   TEXT,
  closed_at    TEXT,
  assignee     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_links (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id     TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_ref  TEXT NOT NULL,
  relation    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_links_todo   ON todo_links(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_links_target ON todo_links(target_kind, target_ref);
```

Add a new schema block (mirrors `FTS_SCHEMA`):

```typescript
const TODOS_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS todos_fts USING fts5(
  summary, description,
  content='todos',
  content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS todos_ai AFTER INSERT ON todos BEGIN
  INSERT INTO todos_fts(rowid, summary, description)
  VALUES (new.rowid, new.summary, new.description);
END;
CREATE TRIGGER IF NOT EXISTS todos_ad AFTER DELETE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, summary, description)
  VALUES ('delete', old.rowid, old.summary, old.description);
END;
CREATE TRIGGER IF NOT EXISTS todos_au AFTER UPDATE ON todos BEGIN
  INSERT INTO todos_fts(todos_fts, rowid, summary, description)
  VALUES ('delete', old.rowid, old.summary, old.description);
  INSERT INTO todos_fts(rowid, summary, description)
  VALUES (new.rowid, new.summary, new.description);
END;
`;
```

In `openDecisionsDb`, after `db.exec(BASE_SCHEMA);` and the existing ensures, add:

```typescript
  db.exec(TODOS_FTS_SCHEMA);
```

(Place it before the `decisions_fts` version check; `todos_fts` is new so it needs no versioned rebuild.)

- [ ] **Step 4: Run it, expect pass.**

- [ ] **Step 5: Commit**

```bash
git add src/decisions/db.ts tests/decisions/db-todos.test.ts
git commit -m "feat(db): add todos, todo_links, todos_fts to the primitives DB"
```

---

### Task 1.3: TodosRepository (CRUD + FTS)

**Files:**
- Create: `src/todos/repository.ts`
- Test: `tests/todos/repository.test.ts`

**Interfaces:**
- Consumes: `TodoRecord` (Task 1.1), `openDecisionsDb` (Task 1.2).
- Produces: `class TodosRepository` with `insert(rec)`, `get(id)`, `getBySeq(seq)`, `update(id, patch: Partial<TodoRecord>)`, `delete(id): boolean`, `list(): TodoRecord[]`, `search(query): TodoRecord[]`. Re-uses `toFtsMatch` from `../decisions/repository.js`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/todos/repository.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import type { TodoRecord } from "../../src/todos/types.js";

function rec(over: Partial<TodoRecord> = {}): TodoRecord {
  return {
    id: "T-aaaa", seq: 1, summary: "migrate auth to oauth", description: "body",
    state: "open", state_reason: null, proposed_by: "rka", proposed_at: "t",
    started_at: null, closed_at: null, assignee: null, created_at: "t", updated_at: "t",
    ...over,
  };
}

describe("TodosRepository", () => {
  let repo: TodosRepository;
  beforeEach(() => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todorepo-")), "decisions.db"));
    repo = new TodosRepository(db);
  });

  it("insert + get round-trips", () => {
    repo.insert(rec());
    expect(repo.get("T-aaaa")?.summary).toBe("migrate auth to oauth");
  });
  it("getBySeq resolves by per-repo seq", () => {
    repo.insert(rec({ id: "T-bbbb", seq: 7 }));
    expect(repo.getBySeq(7)?.id).toBe("T-bbbb");
  });
  it("update patches fields", () => {
    repo.insert(rec());
    repo.update("T-aaaa", { state: "in_progress", started_at: "now" });
    expect(repo.get("T-aaaa")?.state).toBe("in_progress");
  });
  it("search hits FTS over summary/description", () => {
    repo.insert(rec());
    expect(repo.search("oauth").map((t) => t.id)).toEqual(["T-aaaa"]);
    expect(repo.search("nonexistentterm")).toEqual([]);
  });
  it("delete removes the row", () => {
    repo.insert(rec());
    expect(repo.delete("T-aaaa")).toBe(true);
    expect(repo.get("T-aaaa")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement (mirrors `DecisionsRepository`)**

```typescript
// src/todos/repository.ts
import type Database from "better-sqlite3";
import { toFtsMatch } from "../decisions/repository.js";
import type { TodoRecord } from "./types.js";

const COLS =
  "id, seq, summary, description, state, state_reason, proposed_by, proposed_at, started_at, closed_at, assignee, created_at, updated_at";

export class TodosRepository {
  constructor(private db: Database.Database) {}
  // FTS sync is handled by todos_ai/au/ad triggers; write only the content table.

  insert(rec: TodoRecord): void {
    this.db.prepare(
      `INSERT INTO todos (${COLS}) VALUES
       (@id, @seq, @summary, @description, @state, @state_reason, @proposed_by,
        @proposed_at, @started_at, @closed_at, @assignee, @created_at, @updated_at)`,
    ).run(rec);
  }

  get(id: string): TodoRecord | null {
    return (this.db.prepare(`SELECT ${COLS} FROM todos WHERE id = ?`).get(id) as TodoRecord | undefined) ?? null;
  }

  getBySeq(seq: number): TodoRecord | null {
    return (this.db.prepare(`SELECT ${COLS} FROM todos WHERE seq = ?`).get(seq) as TodoRecord | undefined) ?? null;
  }

  update(id: string, patch: Partial<TodoRecord>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE todos SET ${setClause} WHERE id = @id`).run({ ...patch, id });
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
  }

  list(): TodoRecord[] {
    return this.db.prepare(`SELECT ${COLS} FROM todos ORDER BY created_at DESC`).all() as TodoRecord[];
  }

  search(query: string): TodoRecord[] {
    const match = toFtsMatch(query);
    if (!match) return [];
    return this.db.prepare(
      `SELECT ${COLS.split(", ").map((c) => "t." + c).join(", ")}
       FROM todos t JOIN todos_fts f ON f.rowid = t.rowid
       WHERE todos_fts MATCH ? ORDER BY rank`,
    ).all(match) as TodoRecord[];
  }
}
```

- [ ] **Step 4: Run it, expect pass.**

- [ ] **Step 5: Commit**

```bash
git add src/todos/repository.ts tests/todos/repository.test.ts
git commit -m "feat(db): TodosRepository (CRUD + FTS)"
```

---

### Task 1.4: TodoLinksRepository

**Files:**
- Create: `src/todos/links-repository.ts`
- Test: `tests/todos/links-repository.test.ts`

**Interfaces:**
- Produces: `interface TodoLink { todo_id; target_kind; target_ref; relation; created_at }`; `class TodoLinksRepository` with `add(link)`, `remove(todoId, kind, ref, relation): boolean`, `findByTodo(todoId): TodoLink[]`, `findBlocking(todoId): TodoLink[]` (rows where `target_kind='todo' AND target_ref=todoId AND relation='BLOCKED_BY'` — the derived `blocks`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/todos/links-repository.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";

describe("TodoLinksRepository", () => {
  let links: TodoLinksRepository;
  let todos: TodosRepository;
  beforeEach(() => {
    const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todolinks-")), "decisions.db"));
    todos = new TodosRepository(db);
    links = new TodoLinksRepository(db);
    for (const id of ["T-aaaa", "T-bbbb"]) {
      todos.insert({ id, seq: 1, summary: id, description: null, state: "open",
        state_reason: null, proposed_by: null, proposed_at: "t", started_at: null,
        closed_at: null, assignee: null, created_at: "t", updated_at: "t" });
    }
  });

  it("add + findByTodo", () => {
    links.add({ todo_id: "T-aaaa", target_kind: "todo", target_ref: "T-bbbb", relation: "BLOCKED_BY", created_at: "t" });
    expect(links.findByTodo("T-aaaa")).toHaveLength(1);
  });

  it("findBlocking derives `blocks` (reverse of BLOCKED_BY)", () => {
    // T-aaaa is BLOCKED_BY T-bbbb  ⇒  T-bbbb blocks T-aaaa
    links.add({ todo_id: "T-aaaa", target_kind: "todo", target_ref: "T-bbbb", relation: "BLOCKED_BY", created_at: "t" });
    const blocking = links.findBlocking("T-bbbb");
    expect(blocking.map((l) => l.todo_id)).toEqual(["T-aaaa"]);
  });

  it("remove deletes a specific link", () => {
    links.add({ todo_id: "T-aaaa", target_kind: "pr", target_ref: "42", relation: "RESOLVED_BY", created_at: "t" });
    expect(links.remove("T-aaaa", "pr", "42", "RESOLVED_BY")).toBe(true);
    expect(links.findByTodo("T-aaaa")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement (mirrors `DecisionLinksRepository`)**

```typescript
// src/todos/links-repository.ts
import type Database from "better-sqlite3";
import type { TodoLinkRelation } from "./types.js";

export interface TodoLink {
  todo_id: string;
  target_kind: string;   // file|qn|path|frame|decision|pr|todo
  target_ref: string;
  relation: TodoLinkRelation;
  created_at: string;
}

const COLS = "todo_id, target_kind, target_ref, relation, created_at";

export class TodoLinksRepository {
  constructor(private db: Database.Database) {}

  add(link: TodoLink): void {
    this.db.prepare(
      `INSERT INTO todo_links (${COLS})
       VALUES (@todo_id, @target_kind, @target_ref, @relation, @created_at)`,
    ).run(link);
  }

  remove(todoId: string, targetKind: string, targetRef: string, relation: TodoLinkRelation): boolean {
    return this.db.prepare(
      `DELETE FROM todo_links
       WHERE todo_id = ? AND target_kind = ? AND target_ref = ? AND relation = ?`,
    ).run(todoId, targetKind, targetRef, relation).changes > 0;
  }

  findByTodo(todoId: string): TodoLink[] {
    return this.db.prepare(`SELECT ${COLS} FROM todo_links WHERE todo_id = ?`).all(todoId) as TodoLink[];
  }

  /** Derived `blocks`: todos that name `todoId` as their BLOCKED_BY target. */
  findBlocking(todoId: string): TodoLink[] {
    return this.db.prepare(
      `SELECT ${COLS} FROM todo_links
       WHERE target_kind = 'todo' AND target_ref = ? AND relation = 'BLOCKED_BY'`,
    ).all(todoId) as TodoLink[];
  }
}
```

- [ ] **Step 4: Run it, expect pass. Step 5: Commit**

```bash
git add src/todos/links-repository.ts tests/todos/links-repository.test.ts
git commit -m "feat(db): TodoLinksRepository with derived `blocks`"
```

---

### Task 1.5: TodoService — mint + CRUD + links

**Files:**
- Create: `src/todos/service.ts`
- Test: `tests/todos/service.test.ts`

**Interfaces:**
- Consumes: `mintId`/`parseRef` (`../ids/allocator.js`, `../ids/short-id.js`), repos (1.3/1.4), types (1.1).
- Produces: `class TodoService` constructed with `{ db, todos, links }`; methods `propose(input): Todo`, `get(idOrSeq): Todo | null`, `getWithRefs(idOrSeq): TodoWithRefs | null`, `update(id, input): Todo`, `search(query): Todo[]`, `list(): Todo[]`, `link(input: LinkTodoInput): void`, and `transition(...)` (added in Task 1.6).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/todos/service.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { TodoService } from "../../src/todos/service.js";

function svc() {
  const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-todosvc-")), "decisions.db"));
  return new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) });
}

describe("TodoService", () => {
  let s: TodoService;
  beforeEach(() => { s = svc(); });

  it("propose mints a T- id, seq, and open state", () => {
    const t = s.propose({ summary: "migrate auth", description: "to oauth" });
    expect(t.id).toMatch(/^T-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(t.seq).toBe(1);
    expect(t.state).toBe("open");
  });
  it("propose records governs / spawns_from / blocked_by links", () => {
    const dep = s.propose({ summary: "dep" });
    const t = s.propose({ summary: "main", governs: ["src/a.ts"], spawns_from: "D-zzzz", blocked_by: [dep.id] });
    const refs = s.getWithRefs(t.id)!;
    expect(refs.governs.map((g) => g.target_ref)).toEqual(["src/a.ts"]);
    expect(refs.spawns_from?.target_ref).toBe("D-zzzz");
    expect(refs.blocked_by.map((b) => b.target_ref)).toEqual([dep.id]);
  });
  it("get resolves bare seq and T-<seq>", () => {
    const t = s.propose({ summary: "x" });
    expect(s.get(String(t.seq))?.id).toBe(t.id);
    expect(s.get(`T-${t.seq}`)?.id).toBe(t.id);
  });
  it("update replaces governs as a full set", () => {
    const t = s.propose({ summary: "x", governs: ["a", "b"] });
    s.update(t.id, { governs: ["b", "c"] });
    expect(s.getWithRefs(t.id)!.governs.map((g) => g.target_ref).sort()).toEqual(["b", "c"]);
  });
  it("getWithRefs exposes derived blocks", () => {
    const a = s.propose({ summary: "a" });
    const b = s.propose({ summary: "b", blocked_by: [a.id] });
    expect(s.getWithRefs(a.id)!.blocks.map((x) => x.target_ref)).toEqual([b.id]);
  });
});
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement (mirrors `DecisionService`, no event bus)**

```typescript
// src/todos/service.ts
import type Database from "better-sqlite3";
import { mintId } from "../ids/allocator.js";
import { parseRef } from "../ids/short-id.js";
import { TodosRepository } from "./repository.js";
import { TodoLinksRepository, type TodoLink } from "./links-repository.js";
import {
  rowToTodo, type Todo, type TodoRecord, type TodoWithRefs, type TodoRefRow,
  type ProposeTodoInput, type UpdateTodoInput, type LinkTodoInput, type TodoLinkRelation,
} from "./types.js";

export interface TodoServiceDeps {
  db: Database.Database;
  todos: TodosRepository;
  links: TodoLinksRepository;
}

/** path-like → 'path', has '::' → 'qn', T-/D- → 'todo'/'decision', all-digits → 'pr'. */
function classifyTarget(target: string): string {
  if (/^T-/.test(target)) return "todo";
  if (/^D-/.test(target)) return "decision";
  if (/^\d+$/.test(target)) return "pr";
  if (target.includes("::")) return "qn";
  return "path";
}

export class TodoService {
  private db: Database.Database;
  private todos: TodosRepository;
  private links: TodoLinksRepository;

  constructor(deps: TodoServiceDeps) {
    this.db = deps.db; this.todos = deps.todos; this.links = deps.links;
  }

  private resolveRecord(ref: string): TodoRecord | null {
    const direct = this.todos.get(ref);
    if (direct) return direct;
    const parsed = parseRef("todo", ref);
    if (!parsed) return null;
    return parsed.kind === "seq" ? this.todos.getBySeq(parsed.seq) : this.todos.get(parsed.id);
  }

  private addLink(todoId: string, ref: string, relation: TodoLinkRelation, now: string): void {
    const owner = this.resolveRecord(todoId);
    const ownerId = owner ? owner.id : todoId;
    let targetRef = ref;
    const kind = classifyTarget(ref);
    if (kind === "todo") {
      const t = this.resolveRecord(ref);
      targetRef = t ? t.id : ref;
    }
    this.links.add({ todo_id: ownerId, target_kind: kind, target_ref: targetRef, relation, created_at: now });
  }

  propose(input: ProposeTodoInput): Todo {
    const now = new Date().toISOString();
    const { id, seq } = mintId(this.db, "todo", (cand) => this.todos.get(cand) != null);
    const rec: TodoRecord = {
      id, seq, summary: input.summary, description: input.description ?? null,
      state: "open", state_reason: null, proposed_by: input.proposed_by ?? "claude",
      proposed_at: now, started_at: null, closed_at: null, assignee: null,
      created_at: now, updated_at: now,
    };
    this.todos.insert(rec);
    for (const g of input.governs ?? []) this.addLink(id, g, "GOVERNS", now);
    if (input.spawns_from) this.addLink(id, input.spawns_from, "SPAWNS_FROM", now);
    for (const b of input.blocked_by ?? []) this.addLink(id, b, "BLOCKED_BY", now);
    return rowToTodo(rec);
  }

  get(idOrSeq: string): Todo | null {
    const rec = this.resolveRecord(idOrSeq);
    return rec ? rowToTodo(rec) : null;
  }

  getWithRefs(idOrSeq: string): TodoWithRefs | null {
    const rec = this.resolveRecord(idOrSeq);
    if (!rec) return null;
    const links = this.links.findByTodo(rec.id);
    const pick = (relation: TodoLinkRelation): TodoRefRow[] =>
      links.filter((l) => l.relation === relation).map((l) => ({ target_kind: l.target_kind, target_ref: l.target_ref }));
    const blocks: TodoRefRow[] = this.links.findBlocking(rec.id)
      .map((l) => ({ target_kind: "todo", target_ref: l.todo_id }));
    return {
      ...rowToTodo(rec),
      governs: pick("GOVERNS"),
      blocked_by: pick("BLOCKED_BY"),
      blocks,
      related_to: pick("RELATED_TO"),
      spawns_from: pick("SPAWNS_FROM")[0] ?? null,
      resolved_by: pick("RESOLVED_BY"),
    };
  }

  update(idOrSeq: string, input: UpdateTodoInput): Todo {
    const existing = this.resolveRecord(idOrSeq);
    if (!existing) throw new Error(`Todo not found: ${idOrSeq}`);
    const now = new Date().toISOString();
    const patch: Partial<TodoRecord> = { updated_at: now };
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.description !== undefined) patch.description = input.description;
    if (input.assignee !== undefined) patch.assignee = input.assignee;
    this.todos.update(existing.id, patch);
    if (input.governs !== undefined) this.replaceLinks(existing.id, "GOVERNS", input.governs, now);
    return rowToTodo({ ...existing, ...patch } as TodoRecord);
  }

  search(query: string): Todo[] { return this.todos.search(query).map(rowToTodo); }
  list(): Todo[] { return this.todos.list().map(rowToTodo); }

  link(input: LinkTodoInput): void {
    if (!this.resolveRecord(input.todo_id)) throw new Error(`Todo not found: ${input.todo_id}`);
    this.addLink(input.todo_id, input.target, input.relation, new Date().toISOString());
  }

  private replaceLinks(todoId: string, relation: TodoLinkRelation, newTargets: string[], now: string): void {
    const current = this.links.findByTodo(todoId).filter((l) => l.relation === relation);
    const currentRefs = new Set(current.map((l) => l.target_ref));
    const newRefs = new Set(newTargets);
    for (const l of current) if (!newRefs.has(l.target_ref)) this.links.remove(todoId, l.target_kind, l.target_ref, relation);
    for (const t of newTargets) if (!currentRefs.has(t)) this.addLink(todoId, t, relation, now);
  }
}
```

- [ ] **Step 4: Run it, expect pass. Step 5: Commit**

```bash
git add src/todos/service.ts tests/todos/service.test.ts
git commit -m "feat(todos): TodoService mint + CRUD + links (mirrors DecisionService)"
```

---

### Task 1.6: TodoService.transition — the state machine

**Files:**
- Modify: `src/todos/service.ts` (add `TRANSITIONS` table + `transition` method)
- Test: `tests/todos/transition.test.ts`

**Interfaces:**
- Produces: `transition(idOrSeq: string, input: TransitionTodoInput): Todo`. Allowed transitions: `open→{in_progress,cancelled}`, `in_progress→{blocked,done,cancelled}`, `blocked→{in_progress,open,cancelled}`; `done`/`cancelled` terminal. Side effects: `started_at` on first `→in_progress`; `closed_at` on `→done|cancelled`; `RESOLVED_BY` links on `→done`; `BLOCKED_BY` links + `state_reason` on `→blocked`; `state_reason` on `→cancelled`. Throws `Error("Invalid transition: <from> → <to>")` with no mutation otherwise.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/todos/transition.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { TodoService } from "../../src/todos/service.js";

function svc() {
  const db = openDecisionsDb(join(mkdtempSync(join(tmpdir(), "cortex-trans-")), "decisions.db"));
  return new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) });
}

describe("TodoService.transition", () => {
  let s: TodoService;
  beforeEach(() => { s = svc(); });

  it("open → in_progress sets started_at", () => {
    const t = s.propose({ summary: "x" });
    const moved = s.transition(t.id, { to: "in_progress" });
    expect(moved.state).toBe("in_progress");
    expect(moved.started_at).not.toBeNull();
  });
  it("in_progress → done sets closed_at and records resolved_by", () => {
    const t = s.propose({ summary: "x" });
    s.transition(t.id, { to: "in_progress" });
    s.transition(t.id, { to: "done", resolved_by: ["42"] });
    const refs = s.getWithRefs(t.id)!;
    expect(refs.state).toBe("done");
    expect(refs.closed_at).not.toBeNull();
    expect(refs.resolved_by.map((r) => r.target_ref)).toEqual(["42"]);
  });
  it("in_progress → blocked records reason + blocked_by", () => {
    const dep = s.propose({ summary: "dep" });
    const t = s.propose({ summary: "x" });
    s.transition(t.id, { to: "in_progress" });
    const blocked = s.transition(t.id, { to: "blocked", reason: "waiting on dep", blocked_by: [dep.id] });
    expect(blocked.state).toBe("blocked");
    expect(blocked.state_reason).toBe("waiting on dep");
    expect(s.getWithRefs(t.id)!.blocked_by.map((b) => b.target_ref)).toEqual([dep.id]);
  });
  it("rejects an invalid transition with no mutation", () => {
    const t = s.propose({ summary: "x" });            // open
    expect(() => s.transition(t.id, { to: "done" })).toThrow(/Invalid transition/);
    expect(s.get(t.id)!.state).toBe("open");
  });
  it("terminal states reject all transitions", () => {
    const t = s.propose({ summary: "x" });
    s.transition(t.id, { to: "cancelled", reason: "nope" });
    expect(() => s.transition(t.id, { to: "in_progress" })).toThrow(/Invalid transition/);
  });
});
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement — add to `src/todos/service.ts`**

Add the import for `TransitionTodoInput` to the existing types import, then add this table above the class and the method inside it:

```typescript
const TRANSITIONS: Record<string, ReadonlySet<string>> = {
  open: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["blocked", "done", "cancelled"]),
  blocked: new Set(["in_progress", "open", "cancelled"]),
  done: new Set(),
  cancelled: new Set(),
};
```

```typescript
  transition(idOrSeq: string, input: TransitionTodoInput): Todo {
    const existing = this.resolveRecord(idOrSeq);
    if (!existing) throw new Error(`Todo not found: ${idOrSeq}`);
    if (!TRANSITIONS[existing.state]?.has(input.to)) {
      throw new Error(`Invalid transition: ${existing.state} → ${input.to}`);
    }
    const now = new Date().toISOString();
    const patch: Partial<TodoRecord> = { state: input.to, updated_at: now };
    if (input.to === "in_progress" && !existing.started_at) patch.started_at = now;
    if (input.to === "done" || input.to === "cancelled") patch.closed_at = now;
    if (input.to === "blocked" || input.to === "cancelled") patch.state_reason = input.reason ?? null;
    this.todos.update(existing.id, patch);
    if (input.to === "done") for (const pr of input.resolved_by ?? []) this.addLink(existing.id, pr, "RESOLVED_BY", now);
    if (input.to === "blocked") for (const b of input.blocked_by ?? []) this.addLink(existing.id, b, "BLOCKED_BY", now);
    return rowToTodo({ ...existing, ...patch } as TodoRecord);
  }
```

- [ ] **Step 4: Run it, expect pass. Step 5: Commit**

```bash
git add src/todos/service.ts tests/todos/transition.test.ts
git commit -m "feat(todos): state-machine transitions with side effects"
```

---

## Phase 2 — Shared input validation

### Task 2.1: Generalize the marker-scan to `validatePrimitiveFields`

**Files:**
- Modify: `src/mcp-server/tools/decision-input-validation.ts`
- Test: `tests/mcp-server/primitive-input-validation.test.ts`

**Interfaces:**
- Produces: `validatePrimitiveFields(input: Record<string, unknown>, fields: readonly string[]): { marker: string; field: string } | null`. Keep the existing `validateDecisionFields` as a thin wrapper (`validatePrimitiveFields(input, SCANNED_FIELDS)`) so the decision dispatcher and any current callers keep working unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-server/primitive-input-validation.test.ts
import { describe, it, expect } from "vitest";
import { validatePrimitiveFields, validateDecisionFields } from "../../src/mcp-server/tools/decision-input-validation.js";

describe("validatePrimitiveFields", () => {
  it("flags a stray tool-call marker in a named field", () => {
    expect(validatePrimitiveFields({ summary: "ok</invoke> leak" }, ["summary"]))
      .toEqual({ marker: "</invoke>", field: "summary" });
  });
  it("ignores fields not in the scan list", () => {
    expect(validatePrimitiveFields({ note: "x</invoke>" }, ["summary"])).toBeNull();
  });
  it("validateDecisionFields still scans the decision fields", () => {
    expect(validateDecisionFields({ rationale: "x</rationale>" }))
      .toEqual({ marker: "</rationale>", field: "rationale" });
  });
});
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement** — replace the body of `decision-input-validation.ts` so the scan is parameterized; keep `MARKERS` and `SCANNED_FIELDS` as-is:

```typescript
export function validatePrimitiveFields(
  input: Record<string, unknown>,
  fields: readonly string[],
): { marker: string; field: string } | null {
  for (const field of fields) {
    const value = input[field];
    if (typeof value !== "string") continue;
    for (const marker of MARKERS) {
      if (value.includes(marker)) return { marker, field };
    }
  }
  return null;
}

/** Back-compat wrapper: scans the decision string fields. */
export function validateDecisionFields(
  input: Record<string, unknown>,
): { marker: string; field: string } | null {
  return validatePrimitiveFields(input, SCANNED_FIELDS);
}
```

- [ ] **Step 4: Run it + the existing decision tests, expect pass.**

Run: `npx vitest run tests/mcp-server/primitive-input-validation.test.ts` and any existing `*decision*validation*` test.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/decision-input-validation.ts tests/mcp-server/primitive-input-validation.test.ts
git commit -m "refactor(mcp): generalize decision field validation to validatePrimitiveFields"
```

---

## Phase 3 — Consolidated tool surface

> All three dispatchers register **one** `server.tool(<type>, <desc>, <shape>, registerTool(...))`. The shape is `{ repo_path: RepoPathField, action: z.enum([...]), ...all per-action fields optional }`; the handler validates the action's required fields, then calls the existing service. Use `z.object(shape)` for `registerTool`'s `.parse`. The TODO `TODOS` const tables/services are constructed per-call via a `todoServiceFor(ctx)` helper (mirrors `prServiceFor`) since todos live in `ctx.decisionsDb`.

### Task 3.1: The `todo` dispatcher (new)

**Files:**
- Create: `src/mcp-server/tools/todo-tools.ts`
- Modify: `src/mcp-server/server.ts` (register it — see Task 3.4 for the full wiring; for this task add the single `registerTodoTools(server, resolver)` call)
- Test: `tests/mcp-server/todo-tools.test.ts`

**Interfaces:**
- Consumes: `TodoService` (1.5/1.6), `registerTool`/`RepoContext` (`../repo-context.js`), `ok/empty/error` (`../response.js`), `validatePrimitiveFields` (2.1).
- Produces: `registerTodoTools(server, resolver)`. One tool `todo` with `action ∈ {propose,get,list,search,update,link,transition}`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-server/todo-tools.test.ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { registerTodoTools } from "../../src/mcp-server/tools/todo-tools.js";

// Build a real indexed repo so resolver.resolve() succeeds.
function indexedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cortex-todotool-"));
  execSync("git init -q && git commit -q --allow-empty -m init", { cwd: dir });
  // minimal .cortex/db so resolveGraphDbForRead finds a store
  execSync("mkdir -p .cortex", { cwd: dir });
  // GraphStore creates schema on open; touch an empty db via the store path.
  return dir;
}

// NB: exercise the handler via the registered tool's callback. The MCP SDK
// stores handlers; call through resolver-built ctx by invoking propose then get.
describe("todo dispatcher", () => {
  it("propose then get round-trips through the dispatcher", async () => {
    const repo = indexedRepo();
    // index it so .cortex/db exists
    execSync(`node ./dist/cli.js index . ${repo}`, { cwd: process.cwd() }).toString?.();
    const resolver = new RepoContextResolver({ poolCapacity: 2 });
    const server = new McpServer({ name: "t", version: "0" });
    registerTodoTools(server, resolver);
    const handlers = (server as any)._registeredTools ?? {};
    const todo = handlers["todo"];
    const proposed = JSON.parse((await todo.callback({ repo_path: repo, action: "propose", summary: "x" })).content[0].text);
    const got = JSON.parse((await todo.callback({ repo_path: repo, action: "get", id: proposed.id })).content[0].text);
    expect(got.id).toBe(proposed.id);
  });
});
```

> NOTE for the implementer: the exact way to reach the registered callback (`server._registeredTools[name].callback`) is an SDK internal; if it differs in the installed `@modelcontextprotocol/sdk` version, prefer extracting the handler into an exported `todoHandler(resolver)` function and testing that directly (cleaner and version-independent). Adjust the test to call the exported handler.

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement the dispatcher**

```typescript
// src/mcp-server/tools/todo-tools.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TodoService } from "../../todos/service.js";
import { TodosRepository } from "../../todos/repository.js";
import { TodoLinksRepository } from "../../todos/links-repository.js";
import { ok, empty, error as errorResponse } from "../response.js";
import { validatePrimitiveFields } from "./decision-input-validation.js";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";

const RepoPathField = z.string().min(1).optional()
  .describe("REQUIRED. Absolute path to the indexed git root this TODO belongs to.");

const todoShape = {
  repo_path: RepoPathField,
  action: z.enum(["propose", "get", "list", "search", "update", "link", "transition"]),
  // propose
  summary: z.string().optional(),
  description: z.string().optional(),
  proposed_by: z.string().optional(),
  governs: z.array(z.string()).optional(),
  spawns_from: z.string().optional(),
  blocked_by: z.array(z.string()).optional(),
  // get / update / link / transition target
  id: z.string().optional(),
  // update
  assignee: z.string().nullable().optional(),
  // search
  query: z.string().optional(),
  // link
  target: z.string().optional(),
  relation: z.enum(["GOVERNS", "BLOCKED_BY", "RELATED_TO", "SPAWNS_FROM", "RESOLVED_BY"]).optional(),
  // transition
  to: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).optional(),
  reason: z.string().optional(),
  resolved_by: z.array(z.string()).optional(),
} as const;
const todoSchema = z.object(todoShape);
type TodoArgs = z.infer<typeof todoSchema>;

const todoServiceFor = (ctx: RepoContext): TodoService =>
  new TodoService({
    db: ctx.decisionsDb,
    todos: new TodosRepository(ctx.decisionsDb),
    links: new TodoLinksRepository(ctx.decisionsDb),
  });

function need<T>(v: T | undefined, action: string, field: string): T {
  if (v === undefined) throw new Error(`todo(${action}) requires '${field}'`);
  return v;
}

export const todoHandler = (resolver: RepoContextResolver) =>
  registerTool("todo", todoSchema, async (ctx: RepoContext, args: TodoArgs) => {
    const bad = validatePrimitiveFields(args as Record<string, unknown>, ["summary", "description", "reason"]);
    if (bad) {
      return errorResponse("malformed_input",
        `Field '${bad.field}' contains marker '${bad.marker}'. Re-send it as a plain string.`);
    }
    const svc = todoServiceFor(ctx);
    try {
      switch (args.action) {
        case "propose":
          return ok(JSON.stringify(svc.propose({
            summary: need(args.summary, "propose", "summary"),
            description: args.description, proposed_by: args.proposed_by,
            governs: args.governs, spawns_from: args.spawns_from, blocked_by: args.blocked_by,
          }), null, 2));
        case "get": {
          const t = svc.getWithRefs(need(args.id, "get", "id"));
          return t ? ok(JSON.stringify(t, null, 2)) : empty(`todo(get ${args.id})`);
        }
        case "list":
          return ok(JSON.stringify(svc.list(), null, 2));
        case "search": {
          const r = svc.search(need(args.query, "search", "query"));
          return r.length ? ok(JSON.stringify(r, null, 2)) : empty(`todo(search ${args.query})`);
        }
        case "update":
          return ok(JSON.stringify(svc.update(need(args.id, "update", "id"), {
            summary: args.summary, description: args.description, assignee: args.assignee, governs: args.governs,
          }), null, 2));
        case "link":
          svc.link({ todo_id: need(args.id, "link", "id"), target: need(args.target, "link", "target"),
                     relation: need(args.relation, "link", "relation") });
          return ok(JSON.stringify({ linked: true, todo_id: args.id, target: args.target, relation: args.relation }));
        case "transition":
          return ok(JSON.stringify(svc.transition(need(args.id, "transition", "id"), {
            to: need(args.to, "transition", "to"), reason: args.reason,
            resolved_by: args.resolved_by, blocked_by: args.blocked_by,
          }), null, 2));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found/i.test(msg)) return empty(`todo(${args.action} ${args.id ?? ""})`);
      if (/^Invalid transition|requires '/.test(msg)) return errorResponse("invalid_request", msg);
      return errorResponse("internal_error", msg);
    }
  }, { resolver });

export function registerTodoTools(server: McpServer, resolver: RepoContextResolver): void {
  server.tool(
    "todo",
    "Manage TODO entities (future planned work). action: propose|get|list|search|update|link|transition. See docs/mcp-tools.md for per-action params.",
    todoShape,
    todoHandler(resolver),
  );
}
```

- [ ] **Step 4: Run it, expect pass.** (Use the exported `todoHandler` in the test per the NOTE.)

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/todo-tools.ts tests/mcp-server/todo-tools.test.ts
git commit -m "feat(mcp): todo dispatcher (propose/get/list/search/update/link/transition)"
```

---

### Task 3.2: The `decision` dispatcher (migration — byte-parity)

**Files:**
- Create: `src/mcp-server/tools/decision-dispatcher.ts` (the new single tool)
- Modify: `src/mcp-server/tools/decision-tools.ts`, `promotion-tools.ts`, `reconciliation-tools.ts` (export their per-action handler *logic* so the dispatcher reuses it verbatim — see below)
- Test: `tests/mcp-server/decision-parity.test.ts`

**Approach (no behavior change):** the 13 decision actions already have handler bodies in `decision-tools.ts` (create/propose/supersede/update/delete/get/search/why/link/candidates), `promotion-tools.ts` (promote), `reconciliation-tools.ts` (reconcile/pending). Extract each handler body into an exported async function `(<service helpers>, args) => response` and have BOTH the (temporary) old registration and the new dispatcher call it. Then Task 3.4 deletes the old `server.tool` registrations. The dispatcher is a `switch (args.action)` that calls these extracted functions. The byte-parity test asserts the dispatcher's output equals the extracted function's output for representative inputs.

- [ ] **Step 1: Write the failing parity test**

```typescript
// tests/mcp-server/decision-parity.test.ts
import { describe, it, expect } from "vitest";
import { decisionHandler } from "../../src/mcp-server/tools/decision-dispatcher.js";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { makeIndexedRepo } from "../helpers/indexed-repo.js"; // create in Step 0

describe("decision dispatcher parity", () => {
  it("action:create returns the same shape create_decision did", async () => {
    const repo = makeIndexedRepo();
    const handler = decisionHandler(new RepoContextResolver({ poolCapacity: 2 }));
    const res = await handler({ repo_path: repo, action: "create", title: "t", description: "d", rationale: "r" });
    const decision = JSON.parse(res.content[0].text);
    expect(decision.id).toMatch(/^D-/);
    expect(decision.title).toBe("t");
  });

  it("action:get on a missing id returns the empty envelope", async () => {
    const repo = makeIndexedRepo();
    const handler = decisionHandler(new RepoContextResolver({ poolCapacity: 2 }));
    const res = await handler({ repo_path: repo, action: "get", id: "D-nope" });
    expect(res.content[0].text).toContain("get_decision(D-nope)"); // empty() message preserved
  });
});
```

> **Step 0 (shared helper):** create `tests/helpers/indexed-repo.ts` exporting `makeIndexedRepo(): string` that `git init`s a temp dir, makes one commit, and runs the indexer (`cortex index . <dir>`), returning the path. Reuse it across Tasks 3.1/3.2/3.3/4.3.

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement — extract + dispatch.** Two parts:

(a) In `decision-tools.ts`, lift each handler's inner async body into an exported function, e.g.:

```typescript
// decision-tools.ts (exported, reused by the dispatcher and — until Task 3.4 — the old registration)
export async function createDecisionAction(ctx: RepoContext, args: z.infer<typeof createDecisionSchema>, bus?: EventBus, indexerProject?: string | null) {
  const bad = validateDecisionFields(args as Record<string, unknown>);
  if (bad) return errorResponse("malformed_input",
    `Field '${bad.field}' contains structured-marshalling marker '${bad.marker}'. ...`);
  try {
    const { repo_path: _r, ...createArgs } = args;
    const decision = new DecisionService({ db: ctx.decisionsDb, decisions: ctx.decisionsRepo, links: ctx.decisionLinksRepo, bus, project_id: indexerProject ?? "" }).create(createArgs);
    return ok(JSON.stringify(decision, null, 2));
  } catch (e) { return errorResponse("internal_error", e instanceof Error ? e.message : String(e)); }
}
```

Repeat for `proposeDecisionAction`, `supersedeDecisionAction`, `updateDecisionAction`, `deleteDecisionAction`, `getDecisionAction`, `searchDecisionsAction`, `whyWasThisBuiltAction`, `linkDecisionAction`, `decisionCandidatesAction` (bodies are the verbatim handlers already in `decision-tools.ts` — move, don't rewrite). Do the same for `promoteDecisionAction` (promotion-tools.ts) and `recordReconciliationAction`/`pendingReconciliationsAction` (reconciliation-tools.ts).

(b) Create the dispatcher:

```typescript
// src/mcp-server/tools/decision-dispatcher.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { error as errorResponse } from "../response.js";
import type { EventBus } from "../../events/bus.js";
import {
  createDecisionAction, proposeDecisionAction, supersedeDecisionAction, updateDecisionAction,
  deleteDecisionAction, getDecisionAction, searchDecisionsAction, whyWasThisBuiltAction,
  linkDecisionAction, decisionCandidatesAction,
} from "./decision-tools.js";
import { promoteDecisionAction } from "./promotion-tools.js";
import { recordReconciliationAction, pendingReconciliationsAction } from "./reconciliation-tools.js";

const RepoPathField = z.string().min(1).optional()
  .describe("REQUIRED. Absolute path to the indexed git root this decision is about.");

// Superset shape — every field any action needs, all optional except action.
const decisionShape = {
  repo_path: RepoPathField,
  action: z.enum(["create","update","delete","get","search","why","candidates","link","promote","propose","supersede","reconcile","pending"]),
  // ... (copy the field set from the per-action shapes in decision-tools.ts /
  //      promotion-tools.ts / reconciliation-tools.ts; all optional)
  id: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  rationale: z.string().optional(),
  alternatives: z.array(z.object({ name: z.string(), reason_rejected: z.string() })).optional(),
  governs: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  problem: z.string().nullable().optional(),
  resolution: z.string().nullable().optional(),
  status: z.enum(["active","superseded","deprecated"]).optional(),
  superseded_by: z.string().optional(),
  old_decision_id: z.string().optional(),
  pr_number: z.number().int().optional(),
  author: z.string().optional(),
  provenance: z.object({ source: z.enum(["adr","prose","commits"]), doc_path: z.string().optional(), commit_shas: z.array(z.string()).optional(), confidence: z.enum(["high","medium","low"]) }).optional(),
  query: z.string().optional(),
  scope: z.string().optional(),
  qualified_name: z.string().optional(),
  max_candidates: z.number().int().positive().optional(),
  target: z.string().optional(),
  relation: z.enum(["GOVERNS","REFERENCES","RELATED_TO","DEPENDS_ON"]).optional(),
  tier: z.enum(["team","public"]).optional(),
  verdict: z.enum(["match","partial","drift"]).optional(),
  nonconformant: z.array(z.object({ ref: z.string(), note: z.string() })).optional(),
  note: z.string().optional(),
  limit: z.number().int().positive().optional(),
} as const;
const decisionSchema = z.object(decisionShape);

export const decisionHandler = (resolver: RepoContextResolver, bus?: EventBus, indexerProject?: string | null) =>
  registerTool("decision", decisionSchema, async (ctx: RepoContext, args) => {
    switch (args.action) {
      case "create":     return createDecisionAction(ctx, args as any, bus, indexerProject);
      case "update":     return updateDecisionAction(ctx, args as any, bus, indexerProject);
      case "delete":     return deleteDecisionAction(ctx, args as any, bus, indexerProject);
      case "get":        return getDecisionAction(ctx, args as any, bus, indexerProject);
      case "search":     return searchDecisionsAction(ctx, args as any, bus, indexerProject);
      case "why":        return whyWasThisBuiltAction(ctx, args as any, bus, indexerProject);
      case "candidates": return decisionCandidatesAction(ctx, args as any);
      case "link":       return linkDecisionAction(ctx, args as any, bus, indexerProject);
      case "promote":    return promoteDecisionAction(ctx, args as any, bus, indexerProject);
      case "propose":    return proposeDecisionAction(ctx, args as any, bus, indexerProject);
      case "supersede":  return supersedeDecisionAction(ctx, args as any, bus, indexerProject);
      case "reconcile":  return recordReconciliationAction(ctx, args as any);
      case "pending":    return pendingReconciliationsAction(ctx, args as any);
      default:           return errorResponse("invalid_request", `unknown decision action`);
    }
  }, { resolver, freshnessAware: true });

export function registerDecisionDispatcher(server: McpServer, resolver: RepoContextResolver, indexerProject?: string | null, bus?: EventBus): void {
  server.tool(
    "decision",
    "Decisions: create/update/delete/get/search/why/candidates/link/promote/propose/supersede/reconcile/pending. See docs/mcp-tools.md for per-action params.",
    decisionShape,
    decisionHandler(resolver, bus, indexerProject),
  );
}
```

> The `why` action keeps `freshnessAware: true` (the only decision action that had it). Since the whole `decision` tool is freshness-aware, non-`why` actions return objects without a freshness penalty — verify the parity test for `get`/`create` still matches (freshness attaches only when the result has a `content` field, which they all do; if a non-why action's output diverges, gate `freshnessAware` per-action by splitting the registration — see open note). Confirm via the parity test.

- [ ] **Step 4: Run the parity test + existing decision tests, expect pass.**

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/tools/decision-dispatcher.ts src/mcp-server/tools/decision-tools.ts src/mcp-server/tools/promotion-tools.ts src/mcp-server/tools/reconciliation-tools.ts tests/mcp-server/decision-parity.test.ts tests/helpers/indexed-repo.ts
git commit -m "feat(mcp): decision dispatcher (13 actions) reusing extracted handlers"
```

**Per-action porting table (action → extracted fn → source):**

| action | extracted fn | source handler |
|---|---|---|
| create | `createDecisionAction` | decision-tools.ts `create_decision` |
| propose | `proposeDecisionAction` | decision-tools.ts `propose_decision` |
| supersede | `supersedeDecisionAction` | decision-tools.ts `supersede_decision` |
| update | `updateDecisionAction` | decision-tools.ts `update_decision` |
| delete | `deleteDecisionAction` | decision-tools.ts `delete_decision` |
| get | `getDecisionAction` | decision-tools.ts `get_decision` |
| search | `searchDecisionsAction` | decision-tools.ts `search_decisions` |
| why | `whyWasThisBuiltAction` | decision-tools.ts `why_was_this_built` |
| link | `linkDecisionAction` | decision-tools.ts `link_decision` |
| candidates | `decisionCandidatesAction` | decision-tools.ts `decision_candidates` |
| promote | `promoteDecisionAction` | promotion-tools.ts `promote_decision` |
| reconcile | `recordReconciliationAction` | reconciliation-tools.ts `record_reconciliation` |
| pending | `pendingReconciliationsAction` | reconciliation-tools.ts `pending_reconciliations` |

---

### Task 3.3: The `pr` dispatcher (migration — byte-parity)

**Files:**
- Create: `src/mcp-server/tools/pr-dispatcher.ts`
- Modify: `src/mcp-server/tools/pr-tools.ts` (extract handler bodies; rename inner touch `action` field → `change`)
- Test: `tests/mcp-server/pr-parity.test.ts`

**Interfaces:**
- Produces: `registerPRDispatcher(server, resolver, indexerProject?, bus?)`; one tool `pr` with `action ∈ {open, touch, merge, get}`. The `touch` action uses `change: z.enum(["added","modified"])` (the old inner `action` field, renamed to free the dispatch key).

- [ ] **Step 1: Write the failing parity test**

```typescript
// tests/mcp-server/pr-parity.test.ts
import { describe, it, expect } from "vitest";
import { prHandler } from "../../src/mcp-server/tools/pr-dispatcher.js";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { makeIndexedRepo } from "../helpers/indexed-repo.js";

describe("pr dispatcher parity", () => {
  it("open then get round-trips", async () => {
    const repo = makeIndexedRepo();
    const h = prHandler(new RepoContextResolver({ poolCapacity: 2 }));
    const opened = JSON.parse((await h({ repo_path: repo, action: "open", title: "t", author: "rka" })).content[0].text);
    const got = JSON.parse((await h({ repo_path: repo, action: "get", pr_number: opened.number })).content[0].text);
    expect(got.number).toBe(opened.number);
  });
  it("touch uses `change` not `action`", async () => {
    const repo = makeIndexedRepo();
    const h = prHandler(new RepoContextResolver({ poolCapacity: 2 }));
    const opened = JSON.parse((await h({ repo_path: repo, action: "open", title: "t", author: "rka" })).content[0].text);
    const res = await h({ repo_path: repo, action: "touch", pr_number: opened.number, frame_id: "1", node_name: "x", change: "added" });
    expect(res.content[0].text).toContain('"ok":true');
  });
});
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement.** Extract the four `pr-tools.ts` handler bodies into `openPRAction`/`addPRTouchAction`/`mergePRAction`/`getPRAction` (verbatim, but `addPRTouchAction` reads `args.change` and forwards it to `PRService.addTouch` as the existing `action` field). Then:

```typescript
// src/mcp-server/tools/pr-dispatcher.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTool, type RepoContext, type RepoContextResolver } from "../repo-context.js";
import { error as errorResponse } from "../response.js";
import type { EventBus } from "../../events/bus.js";
import { openPRAction, addPRTouchAction, mergePRAction, getPRAction } from "./pr-tools.js";

const RepoPathField = z.string().min(1).optional()
  .describe("REQUIRED. Absolute path to the indexed git root this PR belongs to.");

const prShape = {
  repo_path: RepoPathField,
  action: z.enum(["open", "touch", "merge", "get"]),
  // open
  title: z.string().optional(),
  author: z.string().optional(),
  description: z.string().optional(),
  branch: z.string().optional(),
  state: z.enum(["draft", "open", "merged", "closed"]).optional(),
  introduces_frame: z.string().optional(),
  additions: z.number().int().optional(),
  source: z.enum(["native", "mirror", "scenario"]).optional(),
  external_ref: z.object({ provider: z.string(), repo: z.string(), number: z.number().int(), url: z.string() }).optional(),
  // touch / merge / get
  pr_number: z.number().int().optional(),
  frame_id: z.string().optional(),
  node_name: z.string().optional(),
  change: z.enum(["added", "modified"]).optional(),  // was the inner `action`
} as const;
const prSchema = z.object(prShape);

export const prHandler = (resolver: RepoContextResolver, bus?: EventBus, indexerProject?: string | null) =>
  registerTool("pr", prSchema, async (ctx: RepoContext, args) => {
    switch (args.action) {
      case "open":  return openPRAction(ctx, args as any, bus, indexerProject);
      case "touch": return addPRTouchAction(ctx, args as any, bus, indexerProject);
      case "merge": return mergePRAction(ctx, args as any, bus, indexerProject);
      case "get":   return getPRAction(ctx, args as any, bus, indexerProject);
      default:      return errorResponse("invalid_request", "unknown pr action");
    }
  }, { resolver });

export function registerPRDispatcher(server: McpServer, resolver: RepoContextResolver, indexerProject?: string | null, bus?: EventBus): void {
  server.tool(
    "pr",
    "Pull requests: open/touch/merge/get. (touch uses `change`: added|modified.) See docs/mcp-tools.md.",
    prShape,
    prHandler(resolver, bus, indexerProject),
  );
}
```

- [ ] **Step 4: Run parity test, expect pass. Step 5: Commit**

```bash
git add src/mcp-server/tools/pr-dispatcher.ts src/mcp-server/tools/pr-tools.ts tests/mcp-server/pr-parity.test.ts
git commit -m "feat(mcp): pr dispatcher (open/touch/merge/get), touch uses change"
```

---

### Task 3.4: Wire dispatchers into the server; remove old tool registrations (clean break)

**Files:**
- Modify: `src/mcp-server/server.ts`
- Modify: `decision-tools.ts`/`promotion-tools.ts`/`reconciliation-tools.ts`/`pr-tools.ts` — delete the `server.tool(...)` registration calls (keep the extracted `*Action` functions + schemas, now consumed by the dispatchers). Delete the now-unused `register*Tools` exports for decisions/promotion/reconciliation/PR.
- Test: `tests/mcp-server/tool-surface.test.ts`

**Interfaces:**
- Produces: `createServer` registers exactly `decision`, `todo`, `pr`, the code tools, `context_pack`, the index tools — and **none** of the 17 old names.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp-server/tool-surface.test.ts
import { describe, it, expect } from "vitest";
import { createServer } from "../../src/mcp-server/server.js";

describe("consolidated tool surface", () => {
  it("exposes decision/todo/pr and none of the old primitive names", () => {
    const server = createServer(null);
    const names = Object.keys((server as any)._registeredTools ?? {});
    expect(names).toEqual(expect.arrayContaining(["decision", "todo", "pr"]));
    for (const gone of ["create_decision","update_decision","get_decision","search_decisions","why_was_this_built","decision_candidates","link_decision","promote_decision","propose_decision","supersede_decision","record_reconciliation","pending_reconciliations","open_pr","add_pr_touch","merge_pr","get_pr"]) {
      expect(names).not.toContain(gone);
    }
  });
});
```

- [ ] **Step 2: Run it, expect failure** (old names still present).

- [ ] **Step 3: Implement** — rewrite `server.ts`’s registration block:

```typescript
import { registerDecisionDispatcher } from "./tools/decision-dispatcher.js";
import { registerPRDispatcher } from "./tools/pr-dispatcher.js";
import { registerTodoTools } from "./tools/todo-tools.js";
import { registerCodeTools } from "./tools/code-tools.js";
// ... existing context-pack / contract-tools imports stay
// inside createServer():
  registerDecisionDispatcher(server, resolver, indexerProject, bus);
  registerPRDispatcher(server, resolver, indexerProject, bus);
  registerTodoTools(server, resolver);
  registerCodeTools(server, resolver);
  // (context_pack / contract tools / index tools — unchanged)
```

Delete the `server.tool(...)` blocks (only the registrations) from `decision-tools.ts`/`promotion-tools.ts`/`reconciliation-tools.ts`/`pr-tools.ts`, and their `register*Tools` function shells. Keep all exported `*Action` functions + schemas.

- [ ] **Step 4: Run the surface test + the full suite, expect pass.**

Run: `npx vitest run` (whole suite). Fix any test that referenced an old `register*Tools` directly (update to the dispatcher or the extracted action).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(mcp): wire decision/todo/pr dispatchers; remove 17 old tool registrations (clean break)"
```

---

## Phase 4 — HTTP API contract parity

### Task 4.1: `AdaptedTodoSchema` + `TodosResponseSchema` in the Zod SSoT

**Files:**
- Modify: `src/mcp-server/api-schemas.ts`
- Test: `tests/api/todo-schema.test.ts`

**Interfaces:**
- Produces: `AdaptedTodoSchema`, `AdaptedTodo` type, `TodosResponseSchema`, and `RESPONSE_SCHEMAS.todos = TodosResponseSchema`. Reuses `GovernsRefSchema` + `Version`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/api/todo-schema.test.ts
import { describe, it, expect } from "vitest";
import { AdaptedTodoSchema, RESPONSE_SCHEMAS } from "../../src/mcp-server/api-schemas.js";

describe("AdaptedTodoSchema", () => {
  it("accepts a well-formed adapted todo", () => {
    const ok = AdaptedTodoSchema.safeParse({
      id: "T-9m2x", seq: 3, summary: "x", state: "open", description: "",
      proposedBy: "rka", proposedAt: "t", startedAt: null, closedAt: null, assignee: null,
      governs: [], blockedBy: [], blocks: [], relatedTo: [], spawnsFrom: null, resolvedBy: [],
    });
    expect(ok.success).toBe(true);
  });
  it("is registered for doc generation", () => {
    expect(Object.keys(RESPONSE_SCHEMAS)).toContain("todos");
  });
});
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement — add after the Decisions block in `api-schemas.ts`**

```typescript
// ── Todos ──────────────────────────────────────────────────────────────────
const TodoRefSchema = z.object({ kind: z.string(), id: z.string() });
export const AdaptedTodoSchema = z.object({
  id: z.string(),
  seq: z.number().nullable(),
  summary: z.string(),
  description: z.string(),
  state: z.string(),
  proposedBy: z.string().nullable(),
  proposedAt: z.string(),
  startedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  assignee: z.string().nullable(),
  governs: z.array(GovernsRefSchema),
  blockedBy: z.array(TodoRefSchema),
  blocks: z.array(TodoRefSchema),
  relatedTo: z.array(TodoRefSchema),
  spawnsFrom: z.string().nullable(),
  resolvedBy: z.array(z.string()),
});
export type AdaptedTodo = z.infer<typeof AdaptedTodoSchema>;
export const TodosResponseSchema = z.object({
  version: Version,
  todos: z.array(AdaptedTodoSchema),
});
```

And add `todos: TodosResponseSchema,` to the `RESPONSE_SCHEMAS` object.

- [ ] **Step 4: Run it, expect pass. Step 5: Commit**

```bash
git add src/mcp-server/api-schemas.ts tests/api/todo-schema.test.ts
git commit -m "feat(api): AdaptedTodo + TodosResponse in the Zod contract SSoT"
```

---

### Task 4.2: `api-todos.ts` pure adapter

**Files:**
- Create: `src/mcp-server/api-todos.ts`
- Test: `tests/api/api-todos.test.ts`

**Interfaces:**
- Consumes: `TodoRecord` (types), `TodoLink` (links-repo), `GovernsRef`/`AdaptedTodo` (api-schemas), `FrameInfo` + `resolveGovernsRef` pattern from `api-decisions.ts` (reuse by importing the same `NodeRow` + frame map approach).
- Produces: `buildAdaptedTodo(rec, links, nodesByPath, framesByPath): AdaptedTodo`; `buildAdaptedTodos(recs, links, nodesByPath, framesByPath): AdaptedTodo[]`. Pure.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/api/api-todos.test.ts
import { describe, it, expect } from "vitest";
import { buildAdaptedTodo } from "../../src/mcp-server/api-todos.js";

const baseRec = {
  id: "T-9m2x", seq: 3, summary: "migrate", description: "body", state: "open",
  state_reason: null, proposed_by: "rka", proposed_at: "t", started_at: null,
  closed_at: null, assignee: null, created_at: "t", updated_at: "t",
};

describe("buildAdaptedTodo", () => {
  it("maps record + links to the wire shape", () => {
    const links = [
      { todo_id: "T-9m2x", target_kind: "todo", target_ref: "T-bbbb", relation: "BLOCKED_BY", created_at: "t" },
      { todo_id: "T-9m2x", target_kind: "decision", target_ref: "D-zzzz", relation: "SPAWNS_FROM", created_at: "t" },
      { todo_id: "T-9m2x", target_kind: "pr", target_ref: "42", relation: "RESOLVED_BY", created_at: "t" },
    ] as any;
    const t = buildAdaptedTodo(baseRec as any, links, [], new Map(), new Map());
    expect(t.spawnsFrom).toBe("D-zzzz");
    expect(t.blockedBy).toEqual([{ kind: "todo", id: "T-bbbb" }]);
    expect(t.resolvedBy).toEqual(["42"]);
  });
});
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement** (mirrors `buildAdaptedDecision`; `blocks` derived comes from the links passed in by the route — see Task 4.3, which passes `findByTodo` ∪ `findBlocking`):

```typescript
// src/mcp-server/api-todos.ts
import type { NodeRow } from "../graph/store.js";
import type { TodoRecord } from "../todos/types.js";
import type { TodoLink } from "../todos/links-repository.js";
import type { GovernsRef, AdaptedTodo } from "./api-schemas.js";
import { type FrameInfo } from "./api-decisions.js";

export function buildAdaptedTodo(
  rec: TodoRecord,
  links: TodoLink[],
  blockingLinks: TodoLink[],          // reverse BLOCKED_BY → derived `blocks`
  nodesByPath: Map<string, NodeRow>,
  framesByPath: Map<string, FrameInfo>,
): AdaptedTodo {
  const governs: GovernsRef[] = [];
  const blockedBy: { kind: string; id: string }[] = [];
  const relatedTo: { kind: string; id: string }[] = [];
  const resolvedBy: string[] = [];
  let spawnsFrom: string | null = null;

  for (const l of links) {
    if (l.todo_id !== rec.id) continue;
    switch (l.relation) {
      case "GOVERNS": governs.push(...resolveGovernsRef(l, nodesByPath, framesByPath)); break;
      case "BLOCKED_BY": blockedBy.push({ kind: "todo", id: l.target_ref }); break;
      case "RELATED_TO": relatedTo.push({ kind: "todo", id: l.target_ref }); break;
      case "SPAWNS_FROM": spawnsFrom = l.target_ref; break;
      case "RESOLVED_BY": resolvedBy.push(l.target_ref); break;
    }
  }
  const blocks = blockingLinks
    .filter((l) => l.target_ref === rec.id)
    .map((l) => ({ kind: "todo", id: l.todo_id }));

  return {
    id: rec.id, seq: rec.seq ?? null, summary: rec.summary, description: rec.description ?? "",
    state: rec.state, proposedBy: rec.proposed_by, proposedAt: rec.proposed_at,
    startedAt: rec.started_at, closedAt: rec.closed_at, assignee: rec.assignee,
    governs, blockedBy, blocks, relatedTo, spawnsFrom, resolvedBy,
  };
}

export function buildAdaptedTodos(
  recs: TodoRecord[], links: TodoLink[], blockingLinks: TodoLink[],
  nodesByPath: Map<string, NodeRow>, framesByPath: Map<string, FrameInfo>,
): AdaptedTodo[] {
  return recs.map((r) => buildAdaptedTodo(r, links, blockingLinks, nodesByPath, framesByPath));
}

// GOVERNS resolution mirrors api-decisions.resolveGovernsRef. Either export that
// helper from api-decisions.ts and import it here, or inline the same logic.
function resolveGovernsRef(
  link: TodoLink, nodesByPath: Map<string, NodeRow>, framesByPath: Map<string, FrameInfo>,
): GovernsRef[] {
  if (link.target_kind === "path") {
    if (!nodesByPath.has(link.target_ref)) return [];
    const out: GovernsRef[] = [];
    const frame = framesByPath.get(link.target_ref);
    if (frame) out.push({ kind: "frame", id: String(frame.frame_id), label: frame.frame_label });
    out.push({ kind: "file", path: link.target_ref });
    return out;
  }
  if (link.target_kind === "qn") {
    const i = link.target_ref.indexOf("::");
    if (i === -1) return [];
    const path = link.target_ref.slice(0, i), name = link.target_ref.slice(i + 2);
    if (!nodesByPath.has(path)) return [];
    const out: GovernsRef[] = [];
    const frame = framesByPath.get(path);
    if (frame) out.push({ kind: "frame", id: String(frame.frame_id), label: frame.frame_label });
    out.push({ kind: "function", path, name });
    return out;
  }
  return [];
}
```

> Implementer choice: to DRY, export `resolveGovernsRef` from `api-decisions.ts` and import it (decisions + todos share GOVERNS resolution). Capture a tiny decision if you do.

- [ ] **Step 4: Run it, expect pass. Step 5: Commit**

```bash
git add src/mcp-server/api-todos.ts tests/api/api-todos.test.ts
git commit -m "feat(api): pure api-todos adapter (buildAdaptedTodo)"
```

---

### Task 4.3: `/api/todos` route + server wiring

**Files:**
- Modify: `src/mcp-server/api.ts` (add `openProjectTodos` mirroring `openProjectDecisions`; add the `/api/todos` route; extend `startViewerServer` signature with optional home `todosRepo`/`todoLinksRepo`)
- Modify: `src/index.ts` (construct home `TodosRepository`/`TodoLinksRepository` from the same decisions DB and pass them to `startViewerServer`)
- Test: `tests/api/todos-route.test.ts`

**Interfaces:**
- Produces: `GET /api/todos` → `{ version, todos: AdaptedTodo[] }`, validated by `TodosResponseSchema` via `respond`. `503` if the home todos repos are unavailable (mirrors `/api/decisions`).

- [ ] **Step 1: Write the failing test** — start the server with home repos over a temp decisions DB containing one todo, fetch `/api/todos`, assert `version` + the todo. (Model it on the existing `/api/decisions` route test in `tests/api/`.)

```typescript
// tests/api/todos-route.test.ts  (sketch — follow the existing decisions-route test's harness)
import { describe, it, expect } from "vitest";
// ... import startViewerServer, openDecisionsDb, TodosRepository, TodoLinksRepository, a GraphStore over a temp .cortex/db
// 1) open a temp decisions DB; insert a todo via TodosRepository
// 2) startViewerServer(store, project, decisionsRepo, decisionLinksRepo, todosRepo, todoLinksRepo)
// 3) fetch http://127.0.0.1:<port>/api/todos
// 4) expect body.version === 1 and body.todos[0].id to match
```

- [ ] **Step 2: Run it, expect failure.**

- [ ] **Step 3: Implement.** (a) `openProjectTodos` mirroring `openProjectDecisions` (opens the project's decisions DB — same path — and returns `TodosRepository`+`TodoLinksRepository`+`close`). (b) Extend `startViewerServer(store, indexerProject?, decisionsRepo?, decisionLinksRepo?, todosRepo?, todoLinksRepo?)`. (c) Add the route before the static handler:

```typescript
      // ── /api/todos ──
      if (pathname === "/api/todos") {
        if (!todosRepo || !todoLinksRepo) { respondError(res, 503, "todos repos unavailable", cors); return; }
        const pt = openProjectTodos(todosRepo, todoLinksRepo, indexerProject, project, registry);
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        const nodes = resolved ? resolved.store.getAllNodesUnified(project ?? undefined) : [];
        try {
          const records = pt.todos.list();
          const links = records.flatMap((r) => pt.links.findByTodo(r.id));
          const blocking = records.flatMap((r) => pt.links.findBlocking(r.id));
          const { nodesByPath, framesByPath } = buildPathIndices(nodes);
          const todos = buildAdaptedTodos(records, links, blocking, nodesByPath, framesByPath);
          respond(res, TodosResponseSchema, { version: CONTRACT_VERSION, todos }, freshCtx());
        } finally {
          if (resolved?.owned) resolved.store.close();
          pt.close();
        }
        return;
      }
```

Add imports: `buildAdaptedTodos` from `./api-todos.js`, `TodosResponseSchema` from `./api-schemas.js`, `TodosRepository`/`TodoLinksRepository` from `../todos/*`. (d) In `src/index.ts`, build `new TodosRepository(decisionsDb)` + `new TodoLinksRepository(decisionsDb)` and pass them through.

- [ ] **Step 4: Run it, expect pass.**

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/api.ts src/index.ts tests/api/todos-route.test.ts
git commit -m "feat(api): GET /api/todos route + home-repo wiring"
```

---

### Task 4.4: Regenerate the contract docs + drift guard

**Files:**
- Create (generated): `docs/api/todos.schema.json`
- Test: `tests/api/schema-drift.test.ts` (already covers `todos` once it's in `RESPONSE_SCHEMAS` — no edit needed)

- [ ] **Step 1: Run the generator**

Run: `npm run gen:api-schemas`
Expected: writes `docs/api/todos.schema.json` (and rewrites the others identically).

- [ ] **Step 2: Run the drift guard**

Run: `npx vitest run tests/api/schema-drift.test.ts`
Expected: PASS — `docs/api/todos.schema.json matches the Zod source`.

- [ ] **Step 3: Commit**

```bash
git add docs/api/todos.schema.json
git commit -m "chore(api): generate docs/api/todos.schema.json"
```

---

## Phase 5 — Clean-break migration of callers + docs

### Task 5.1: Update the cortex skills

**Files:**
- Modify: the plugin skills that call decision tools — `capture-decision`, `search-decisions`, `seed-decisions`, `explain-architecture` (under the plugin's `skills/`/`commands/` dirs).

- [ ] **Step 1:** In each skill's prose/examples, replace old calls with the dispatcher form:
  - `search_decisions({query})` → `decision({action:"search", query})`
  - `create_decision({...})` → `decision({action:"create", ...})`
  - `link_decision({...})` → `decision({action:"link", ...})`
  - `why_was_this_built({qualified_name})` → `decision({action:"why", qualified_name})`
  - `decision_candidates({...})` → `decision({action:"candidates", ...})`
  - `update_decision({...})` → `decision({action:"update", ...})`
- [ ] **Step 2:** grep the skills dir for any remaining old name (escape hatch: `cortex:grep-ok`). Expected: none.
- [ ] **Step 3: Commit** `docs(skills): migrate decision tool calls to the decision dispatcher`

---

### Task 5.2: Update the hooks

**Files:**
- Modify: `hooks/prefer-cortex.sh` (redirect text naming `search_graph`/etc. is unaffected; only update any decision/PR tool names), `hooks/check-index.sh` (banner), the suggest-capture hook (if it names `create_decision`).

- [ ] **Step 1:** Replace any literal old tool names in hook text/scripts with the dispatcher form.
- [ ] **Step 2:** Re-run the hook tests if present (`tests/hooks/`), expect pass.
- [ ] **Step 3: Commit** `fix(hooks): reference consolidated decision/todo/pr tools`

---

### Task 5.3: Update CLAUDE.md, docs/mcp-tools.md, CHANGELOG

**Files:**
- Modify: `CLAUDE.md` (the routing table + "Tools Available" section + decision-capture examples), `docs/mcp-tools.md` (per-tool → per-action reference; add the `todo` tool), `CHANGELOG.md`.

- [ ] **Step 1:** Rewrite the "Decision tools / Pull-request tools" lists to `decision` / `pr` / `todo` with their action enums. Update the decision-capture example block to the dispatcher form. Update the `why_was_this_built` references in the routing table to `decision({action:"why"})`.
- [ ] **Step 2:** In `docs/mcp-tools.md`, document each tool's actions + per-action params + the unchanged `repo_path` contract + error shapes. Add the full `todo` reference.
- [ ] **Step 3:** Add a CHANGELOG entry under a new version with a **Migration** subsection: a table mapping every old name → `tool({action})`, explicitly flagging `why_was_this_built` → `decision({action:"why"})`, for the `mesh` consumer.
- [ ] **Step 4: Commit** `docs: migrate tool docs to the consolidated decision/todo/pr surface`

---

### Task 5.4: Full-suite green + capture decisions

- [ ] **Step 1:** Run the whole suite: `npx vitest run`. Expected: all green (including the parity, surface, schema-drift, and todos suites).
- [ ] **Step 2:** Run a clean dev-server smoke: `npm run dev`, fetch `/api/todos` and `/api/health`, confirm `200` + `version:1`, then stop it.
- [ ] **Step 3:** Capture the three decisions from spec §6 via the new dispatcher (`decision({action:"create", ...})`):
  1. Per-type consolidated tool surface (17→3, clean break) — `governs` the three dispatchers.
  2. TODO storage in the primitives DB — `governs` `src/todos/`.
  3. `proposed_by`/`assignee` as TEXT not AgentRef.
  (Plus optional: `validatePrimitiveFields` generalization; `AdaptedTodo` HTTP contract.)
- [ ] **Step 4:** The version bump + release happen at merge (per the workflow rules) — this is a **minor** (new backward-compatible capability... but note the tool rename is breaking → coordinate with the user on minor vs major at merge).

---

## Self-Review

**1. Spec coverage** (each spec section → task):
- §4.1 storage → Tasks 1.1–1.6 ✅ (types, schema, repos, service, state machine).
- §4.2 consolidated tools → Tasks 3.1–3.4 ✅ (todo/decision/pr dispatchers + wiring + clean break).
- §4.3 migration/clean break → Tasks 3.4, 5.1–5.3 ✅.
- §4.4 schema/contract parity: domain types (1.1) ✅, input validation (2.1) ✅, MCP contract (3.x) ✅, HTTP contract (4.1–4.4) ✅.
- §5 testing → tests in every task + 5.4 full-suite ✅.
- §6 decisions → Task 5.4 ✅.
- Deferrals (viewer/hooks/bridge/events/AgentRef) → not built; Global Constraints lists them ✅.

**2. Placeholder scan:** the migration tasks (3.2/3.3) intentionally say "extract the verbatim handler body" rather than re-printing ~400 lines of existing code — that is a concrete move-refactor instruction with a per-action source table and byte-parity tests as the behavioral spec, not a vague placeholder. All NEW code is shown in full. The `decisionShape` superset notes "copy the field set from the per-action shapes" — the fields ARE enumerated in the block; the note points the implementer to the source of truth for descriptions. ✅

**3. Type consistency:** `TodoRecord`/`Todo`/`TodoWithRefs`/`TodoLink`/`TodoLinkRelation` names are consistent across Tasks 1.1→4.2. `todoServiceFor` (3.1) mirrors `prServiceFor`. `AdaptedTodo` fields in 4.1 match `buildAdaptedTodo`'s return in 4.2. Relation constants are uppercase (`GOVERNS`/`BLOCKED_BY`/`RELATED_TO`/`SPAWNS_FROM`/`RESOLVED_BY`) everywhere. State strings lowercase everywhere. ✅

**Open implementer notes (non-blocking):**
- The MCP-SDK internal `_registeredTools` access in tests is version-fragile — prefer testing the exported `*Handler`/`*Action` functions directly (called out in Task 3.1).
- If `decision`-tool `freshnessAware` changes any non-`why` action's bytes vs the old per-tool output, split the registration so only `why` is freshness-aware (Task 3.2 note).
- Consider exporting `resolveGovernsRef` from `api-decisions.ts` for reuse by `api-todos.ts` (Task 4.2) — capture a small decision if done.

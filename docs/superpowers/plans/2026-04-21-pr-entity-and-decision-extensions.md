# PR Entity & Decision Extensions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Cortex's data model with first-class PR entities and richer decisions (problem/resolution narrative + typed relationship edges), plus the MCP surface to propose, supersede, open, touch, and merge — with merge ratifying introduced decisions from `proposed` to `active`.

**Architecture:** Graph-native — no new tables. Decisions remain `nodes` rows with `kind='decision'` and JSON `data`; new `problem` / `resolution` fields live in `data`. PRs are `nodes` with `kind='pull_request'` and a rich `data` JSON (number, state, touches inline, source, external_ref). Relationships use new `edges.relation` values (`PR_INTRODUCES_DECISION`, `DECISION_RELATED_TO`, etc.). The FTS5 virtual table is recreated on first startup after upgrade to add `problem` + `resolution` columns. A new `PRService` in `src/prs/` mirrors `DecisionService`'s emit pattern.

**Tech Stack:** TypeScript (ESM, `.js` imports), better-sqlite3, Vitest, Zod, `@modelcontextprotocol/sdk` via `InMemoryTransport` in contract tests, the existing `src/events` bus + worker + WS fanout.

**Spec:** [2026-04-21-pr-entity-and-decision-extensions-design.md](../specs/2026-04-21-pr-entity-and-decision-extensions-design.md)

---

## File Structure

**New files:**

- `src/prs/types.ts` — `PullRequest`, `PRTouch`, `PRState`, `PRSource`, `OpenPRInput`, `AddPRTouchInput` types. One responsibility: the PR wire shape.
- `src/prs/service.ts` — `PRService` class: `open()`, `addTouch()`, `merge()`, `get()`. Emits `pr.*` events via the bus. Owns transaction boundaries. Ratifies introduced decisions on merge.
- `src/mcp-server/tools/pr-tools.ts` — `registerPRTools(server, prService)` — binds `open_pr`, `add_pr_touch`, `merge_pr`, `get_pr` to the MCP server.
- `tests/prs/service.test.ts` — Vitest unit tests for `PRService` against a real in-memory `GraphStore`.
- `tests/mcp-contract/pr-tools.test.ts` — Contract tests for the four PR tools via the existing harness.
- `tests/mcp-contract/decision-extensions.test.ts` — Contract tests for new decision fields, `propose_decision`, `supersede_decision`, new `link_decision` relations, extended `get_decision` resolution of PR refs + decision relations.

**Modified files:**

- `src/graph/schema.ts` — `CREATE_FTS` adds `problem` + `resolution` columns.
- `src/graph/store.ts` — `migrate()` detects outdated FTS, drops + recreates + repopulates; `indexDecisionContent()` / `updateDecisionContent()` include `problem` + `resolution` in FTS inserts/updates.
- `src/decisions/types.ts` — `Decision` gains `problem?: string | null`, `resolution?: string | null`; `DecisionStatus` union adds `'proposed'`; new `SupersedeDecisionInput`, `ProposeDecisionInput`.
- `src/decisions/service.ts` — `create()` / `update()` persist `problem` + `resolution`; new `propose()`, `supersede()`, `linkRelatedTo()`, `linkDependsOn()` methods; extended `get()` resolves new edges + PR refs. Emits `decision.proposed`, `decision.ratified` events.
- `src/mcp-server/tools/decision-tools.ts` — New `propose_decision` + `supersede_decision` handlers; `create_decision` / `update_decision` Zod schemas extended; `link_decision` enum adds `RELATED_TO` + `DEPENDS_ON`; `get_decision` / `search_decisions` response shape carries new fields.
- `src/events/types.ts` — `Event` union adds `pr.opened`, `pr.touched`, `pr.merged`, `decision.ratified` kinds; extends `decision.proposed` payload.
- `src/events/worker/mutation-deriver.ts` — Cases for the new event kinds, producing `add_node` / `update_node` / `add_edge` mutations.
- `src/index.ts` — Instantiate `PRService`, pass to `registerPRTools`.
- `src/mcp-server/server.ts` — Import and call `registerPRTools`.

---

### Task 0: Branch setup

Already on branch `docs/pr-entity-design-spec` for spec + plan commits. For implementation, switch to a fresh feature branch.

- [ ] **Step 1: Create implementation branch**

```bash
git checkout main
git pull origin main
git checkout -b feature/api/pr-entity-and-decision-extensions
```

Expected: clean switch to the new branch, nothing to pull.

---

### Task 1: Extend decision + PR + event types

**Files:**
- Modify: `src/decisions/types.ts`
- Create: `src/prs/types.ts`
- Modify: `src/events/types.ts`

- [ ] **Step 1: Extend `Decision` and `DecisionStatus`**

Edit `src/decisions/types.ts`:

```ts
export type DecisionStatus = "proposed" | "active" | "superseded" | "deprecated";

export interface Decision {
  id: string;
  title: string;
  description: string;             // legacy — prefer problem + resolution on new writes
  rationale: string;
  alternatives: Alternative[];
  tier: string;
  status: DecisionStatus;
  superseded_by: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
  // NEW — narrative split
  problem: string | null;
  resolution: string | null;
}

export interface ProposeDecisionInput {
  title: string;
  problem: string;
  resolution: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];
  references?: string[];
  author?: string;
  pr_number?: number;              // if set, link new decision as introduced-by
}

export interface SupersedeDecisionInput {
  old_decision_id: string;
  title: string;
  problem: string;
  resolution: string;
  rationale: string;
  alternatives?: Alternative[];
  governs?: string[];
  references?: string[];
  author?: string;
}
```

Keep `CreateDecisionInput` / `UpdateDecisionInput` as they are but extend both with optional `problem?: string | null` / `resolution?: string | null`.

- [ ] **Step 2: Create `src/prs/types.ts`**

```ts
export type PRState = "draft" | "open" | "merged" | "closed";
export type PRSource = "native" | "mirror" | "scenario";
export type PRTouchAction = "added" | "modified";

export interface PRTouch {
  frame_id: string;
  node_name: string;
  action: PRTouchAction;
}

export interface PRExternalRef {
  provider: string;
  repo: string;
  number: number;
  url: string;
}

export interface PullRequest {
  id: string;                      // node UUID
  number: number;                  // display id, monotonic
  title: string;
  state: PRState;
  author: string | null;
  opened_at: string;
  merged_at: string | null;
  closed_at: string | null;
  branch: string | null;
  description: string | null;
  introduces_frame: string | null;
  additions: number;
  comment_count: number;
  last_activity_at: string | null;
  source: PRSource;
  external_ref: PRExternalRef | null;
  last_synced_at: string | null;
  touches: PRTouch[];
}

export interface OpenPRInput {
  title: string;
  author: string;
  description?: string | null;
  branch?: string | null;
  state?: PRState;                 // default 'open'
  introduces_frame?: string | null;
  additions?: number;
  source?: PRSource;               // default 'native'
  external_ref?: PRExternalRef | null;
}

export interface AddPRTouchInput {
  pr_number: number;
  frame_id: string;
  node_name: string;
  action: PRTouchAction;
}

export interface PullRequestWithRefs extends PullRequest {
  introduces_decisions: string[];  // decision IDs
  implements_decisions: string[];
  challenges_decisions: string[];
  discusses_decisions: string[];
  linked_prs: { relation: "depends_on" | "related_to"; pr_number: number }[];
}
```

- [ ] **Step 3: Extend `Event` union in `src/events/types.ts`**

Add to the discriminated union:

```ts
| {
    id: string;
    kind: "decision.proposed";
    actor: string;
    project_id: string;
    created_at: string;
    payload: {
      decision_id: string;
      title: string;
      pr_number: number | null;
    };
  }
| {
    id: string;
    kind: "decision.ratified";
    actor: string;
    project_id: string;
    created_at: string;
    payload: {
      decision_id: string;
      via_pr_number: number;
    };
  }
| {
    id: string;
    kind: "pr.opened";
    actor: string;
    project_id: string;
    created_at: string;
    payload: {
      pr_number: number;
      title: string;
      author: string | null;
      state: PRState;
      source: PRSource;
    };
  }
| {
    id: string;
    kind: "pr.touched";
    actor: string;
    project_id: string;
    created_at: string;
    payload: {
      pr_number: number;
      frame_id: string;
      node_name: string;
      action: PRTouchAction;
    };
  }
| {
    id: string;
    kind: "pr.merged";
    actor: string;
    project_id: string;
    created_at: string;
    payload: {
      pr_number: number;
      ratified_decisions: string[];
    };
  };
```

Import the types at the top:

```ts
import type { PRState, PRSource, PRTouchAction } from "../prs/types.js";
```

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

Expected: clean (no errors). If errors, existing call sites may need harmless widening for the new fields (Decision fields default to null for existing constructors).

- [ ] **Step 5: Commit**

```bash
git add src/decisions/types.ts src/prs/types.ts src/events/types.ts
git commit -m "feat(types): add PR + decision narrative + event-kind types"
```

---

### Task 2: FTS5 schema update + startup migration

**Files:**
- Modify: `src/graph/schema.ts`
- Modify: `src/graph/store.ts`
- Test: `tests/graph/fts-migration.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/graph/fts-migration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("FTS migration: old schema -> new schema", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-fts-mig-"));
    dbPath = join(dir, "graph.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("recreates FTS with problem + resolution columns when old schema detected", () => {
    // simulate pre-upgrade DB: create with old FTS only
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT,
        qualified_name TEXT, file_path TEXT, data TEXT NOT NULL DEFAULT '{}',
        tier TEXT NOT NULL DEFAULT 'personal',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT,
        relation TEXT, data TEXT DEFAULT '{}', created_at TEXT);
      CREATE TABLE edge_annotations (id TEXT, decision_id TEXT, edge_id TEXT, created_at TEXT);
      CREATE VIRTUAL TABLE decisions_fts USING fts5(title, description, rationale, node_id UNINDEXED);
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO nodes (id, kind, name, data, created_at, updated_at)
       VALUES (?, 'decision', ?, ?, ?, ?)`
    ).run("d1", "Old", JSON.stringify({ description: "desc", rationale: "why" }), now, now);
    db.prepare(
      "INSERT INTO decisions_fts (title, description, rationale, node_id) VALUES (?, ?, ?, ?)"
    ).run("Old", "desc", "why", "d1");
    db.close();

    // open via GraphStore — should detect old schema and migrate
    const store = new GraphStore(dbPath);

    const cols = (store as any).db
      .prepare(`PRAGMA table_info(decisions_fts)`)
      .all()
      .map((r: { name: string }) => r.name);
    expect(cols).toContain("problem");
    expect(cols).toContain("resolution");

    // existing row still searchable
    const hits = (store as any).db
      .prepare("SELECT node_id FROM decisions_fts WHERE decisions_fts MATCH 'desc'")
      .all();
    expect(hits.map((h: { node_id: string }) => h.node_id)).toContain("d1");
  });
});
```

- [ ] **Step 2: Run it to verify failure**

```bash
npx vitest run tests/graph/fts-migration.test.ts
```

Expected: FAIL — `cols` does not contain `problem`.

- [ ] **Step 3: Update `src/graph/schema.ts`**

Replace `CREATE_FTS`:

```ts
export const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, description, rationale, problem, resolution,
  node_id UNINDEXED
);
`;
```

- [ ] **Step 4: Add FTS migration logic to `src/graph/store.ts`**

Find the `migrate()` method (around line 44). Extend it:

```ts
private migrate(): void {
  this.db.exec(CREATE_TABLES);
  this.db.exec(CREATE_INDEXES);
  this.migrateFts();
  this.db.exec(CREATE_FTS);
}

private migrateFts(): void {
  // Detect whether decisions_fts exists and lacks the new columns.
  const existing = this.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_fts'")
    .get() as { name?: string } | undefined;
  if (!existing?.name) return; // fresh DB — CREATE_FTS will build the new shape
  const cols = this.db
    .prepare("PRAGMA table_info(decisions_fts)")
    .all()
    .map((r: { name: string }) => r.name);
  if (cols.includes("problem") && cols.includes("resolution")) return;
  // Drop and repopulate.
  this.db.exec("DROP TABLE decisions_fts;");
  this.db.exec(`
    CREATE VIRTUAL TABLE decisions_fts USING fts5(
      title, description, rationale, problem, resolution,
      node_id UNINDEXED
    );
  `);
  const rows = this.db
    .prepare("SELECT id, name, data FROM nodes WHERE kind = 'decision'")
    .all() as { id: string; name: string; data: string }[];
  const insert = this.db.prepare(
    "INSERT INTO decisions_fts (title, description, rationale, problem, resolution, node_id) VALUES (?, ?, ?, ?, ?, ?)"
  );
  for (const row of rows) {
    const data = JSON.parse(row.data || "{}");
    insert.run(
      row.name ?? "",
      data.description ?? "",
      data.rationale ?? "",
      data.problem ?? "",
      data.resolution ?? "",
      row.id
    );
  }
}
```

- [ ] **Step 5: Update `indexDecisionContent()` and `updateDecisionContent()`**

Search `src/graph/store.ts` for these helpers (called from `createNode` / `updateNode` when `kind === 'decision'`). Extend their INSERT / UPDATE statements to include `problem` and `resolution`:

```ts
private indexDecisionContent(id: string, name: string, data: Record<string, unknown>): void {
  this.db.prepare(
    `INSERT INTO decisions_fts (title, description, rationale, problem, resolution, node_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    name ?? "",
    (data.description as string | undefined) ?? "",
    (data.rationale as string | undefined) ?? "",
    (data.problem as string | undefined) ?? "",
    (data.resolution as string | undefined) ?? "",
    id
  );
}

private updateDecisionContent(id: string, name: string, data: Record<string, unknown>): void {
  this.db.prepare("DELETE FROM decisions_fts WHERE node_id = ?").run(id);
  this.indexDecisionContent(id, name, data);
}
```

(If the existing signatures differ, preserve them and only add the new column writes.)

- [ ] **Step 6: Run test to verify pass**

```bash
npx vitest run tests/graph/fts-migration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full test suite to catch regressions**

```bash
npx vitest run
```

Expected: all green. (Existing decision FTS tests should still pass — new columns are empty for existing decisions.)

- [ ] **Step 8: Commit**

```bash
git add src/graph/schema.ts src/graph/store.ts tests/graph/fts-migration.test.ts
git commit -m "feat(graph): FTS5 adds problem+resolution with startup migration"
```

---

### Task 3: DecisionService — persist problem + resolution

**Files:**
- Modify: `src/decisions/service.ts`
- Test: `tests/decisions/problem-resolution.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/problem-resolution.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionSearch } from "../../src/decisions/search.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DecisionService — problem + resolution", () => {
  let dir: string;
  let store: GraphStore;
  let service: DecisionService;
  let search: DecisionSearch;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-"));
    store = new GraphStore(join(dir, "g.db"));
    service = new DecisionService(store);
    search = new DecisionSearch(store);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("create persists problem + resolution in data JSON", () => {
    const d = service.create({
      title: "LOD",
      description: "legacy",
      rationale: "why",
      problem: "unreadable at zoom",
      resolution: "band projection",
      alternatives: [],
    });
    expect(d.problem).toBe("unreadable at zoom");
    expect(d.resolution).toBe("band projection");

    const fetched = service.get(d.id);
    expect(fetched?.problem).toBe("unreadable at zoom");
    expect(fetched?.resolution).toBe("band projection");
  });

  it("existing decisions without problem/resolution read null", () => {
    // Simulate legacy row — write directly via store
    const raw = store.createNode({
      kind: "decision",
      name: "Old",
      data: { description: "d", rationale: "r" },
    });
    const fetched = service.get(raw.id);
    expect(fetched?.problem).toBeNull();
    expect(fetched?.resolution).toBeNull();
  });

  it("update replaces problem + resolution", () => {
    const d = service.create({
      title: "LOD",
      description: "legacy",
      rationale: "why",
      problem: "old problem",
      resolution: "old resolution",
    });
    const u = service.update(d.id, { problem: "new problem", resolution: "new resolution" });
    expect(u.problem).toBe("new problem");
    expect(u.resolution).toBe("new resolution");
  });

  it("search matches on problem field", () => {
    service.create({
      title: "LOD",
      description: "legacy",
      rationale: "why",
      problem: "unreadable at zoom",
      resolution: "band projection",
    });
    const hits = search.search("unreadable");
    expect(hits.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
npx vitest run tests/decisions/problem-resolution.test.ts
```

Expected: FAIL on `d.problem` expectations — service drops the fields.

- [ ] **Step 3: Update `DecisionService.create`**

In `src/decisions/service.ts`, the `create()` method writes a `data` JSON object. Extend construction to include the new fields and the existing Decision return to read them back:

```ts
create(input: CreateDecisionInput): Decision {
  const data: Record<string, unknown> = {
    description: input.description,
    rationale: input.rationale,
    alternatives: input.alternatives ?? [],
    author: input.author ?? this.defaultActor,
    status: "active",
    superseded_by: null,
    problem: input.problem ?? null,            // NEW
    resolution: input.resolution ?? null,      // NEW
  };
  const node = this.store.createNode({ kind: "decision", name: input.title, data });
  /* existing GOVERNS / REFERENCES edge writes, existing event emission */
  return this.nodeToDecision(node);
}
```

(Keep the existing flow — just add the two new fields into `data`.)

- [ ] **Step 4: Update `DecisionService.update`**

Mirror the addition in `update()` — merge incoming `problem` / `resolution` into the loaded data object:

```ts
if (input.problem !== undefined) data.problem = input.problem;
if (input.resolution !== undefined) data.resolution = input.resolution;
```

- [ ] **Step 5: Update `nodeToDecision` helper**

Probably lives in `src/decisions/types.ts`. Ensure it reads new fields with a null default:

```ts
export function nodeToDecision(node: NodeRow): Decision {
  const data = JSON.parse(node.data || "{}");
  return {
    id: node.id,
    title: node.name,
    description: data.description ?? "",
    rationale: data.rationale ?? "",
    alternatives: data.alternatives ?? [],
    tier: node.tier,
    status: data.status ?? "active",
    superseded_by: data.superseded_by ?? null,
    author: data.author ?? null,
    created_at: node.created_at,
    updated_at: node.updated_at,
    problem: data.problem ?? null,         // NEW
    resolution: data.resolution ?? null,   // NEW
  };
}
```

- [ ] **Step 6: Run test to verify pass**

```bash
npx vitest run tests/decisions/problem-resolution.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run full suite**

```bash
npx vitest run
```

Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/decisions/service.ts src/decisions/types.ts tests/decisions/problem-resolution.test.ts
git commit -m "feat(decisions): persist problem + resolution fields"
```

---

### Task 4: DecisionService.propose

**Files:**
- Modify: `src/decisions/service.ts`
- Test: extend `tests/decisions/problem-resolution.test.ts` with a `describe("propose")` block, OR create `tests/decisions/propose.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/propose.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../../src/events/types.js";

describe("DecisionService.propose", () => {
  let dir: string;
  let store: GraphStore;
  let service: DecisionService;
  let events: Event[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-prop-"));
    store = new GraphStore(join(dir, "g.db"));
    events = [];
    service = new DecisionService(store, {
      bus: { emit: (e: Event) => events.push(e) },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates a decision with status=proposed", () => {
    const d = service.propose({
      title: "causal ordering",
      problem: "need temporal order",
      resolution: "Lamport + wall-clock tiebreaker",
      rationale: "causal consistency without clock sync",
    });
    expect(d.status).toBe("proposed");
    expect(service.get(d.id)?.status).toBe("proposed");
  });

  it("emits decision.proposed with pr_number null when no PR linked", () => {
    const d = service.propose({
      title: "causal ordering",
      problem: "x",
      resolution: "y",
      rationale: "z",
    });
    const ev = events.find((e) => e.kind === "decision.proposed");
    expect(ev).toBeDefined();
    expect((ev as any).payload.decision_id).toBe(d.id);
    expect((ev as any).payload.pr_number).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/decisions/propose.test.ts
```

Expected: FAIL — `service.propose` does not exist.

- [ ] **Step 3: Add `propose()` method to `DecisionService`**

```ts
propose(input: ProposeDecisionInput): Decision {
  const data: Record<string, unknown> = {
    description: input.resolution,                 // legacy field mirrors resolution until callers migrate
    rationale: input.rationale,
    alternatives: input.alternatives ?? [],
    author: input.author ?? this.defaultActor,
    status: "proposed",
    superseded_by: null,
    problem: input.problem,
    resolution: input.resolution,
  };
  const node = this.store.createNode({ kind: "decision", name: input.title, data });
  // governs / references edges (reuse existing logic)
  for (const target of input.governs ?? []) this.linkGoverns(node.id, target);
  for (const ref of input.references ?? []) this.linkReference(node.id, ref);
  // optional: link to PR as 'introduces'
  if (input.pr_number != null) {
    const pr = this.findPrByNumber(input.pr_number);
    if (pr) {
      this.store.createEdge({
        source_id: pr.id,
        target_id: node.id,
        relation: "PR_INTRODUCES_DECISION",
        data: {},
      });
    }
  }
  this.emit({
    id: newUlid(),
    kind: "decision.proposed",
    actor: this.defaultActor,
    project_id: this.projectId,
    created_at: new Date().toISOString(),
    payload: {
      decision_id: node.id,
      title: input.title,
      pr_number: input.pr_number ?? null,
    },
  });
  return this.nodeToDecision(node);
}

private findPrByNumber(num: number): { id: string } | null {
  const row = (this.store as any).db
    .prepare(
      `SELECT id FROM nodes WHERE kind = 'pull_request'
       AND CAST(json_extract(data, '$.number') AS INTEGER) = ?`
    )
    .get(num) as { id: string } | undefined;
  return row ?? null;
}
```

(If `(this.store as any).db` access is not the codebase convention, expose a narrow `findPrByNumber` on `GraphStore` instead.)

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run tests/decisions/propose.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/service.ts tests/decisions/propose.test.ts
git commit -m "feat(decisions): add propose() with decision.proposed event"
```

---

### Task 5: DecisionService.supersede (atomic)

**Files:**
- Modify: `src/decisions/service.ts`
- Test: `tests/decisions/supersede.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DecisionService.supersede", () => {
  let dir: string;
  let store: GraphStore;
  let service: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-sup-"));
    store = new GraphStore(join(dir, "g.db"));
    service = new DecisionService(store);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates new active decision and marks old superseded with link", () => {
    const old = service.create({
      title: "territory hulls",
      description: "d",
      rationale: "r",
      problem: "governance viz",
      resolution: "hulls",
    });
    const next = service.supersede({
      old_decision_id: old.id,
      title: "marginalia",
      problem: "hulls noisy at scale",
      resolution: "pills on focused frame edge",
      rationale: "document metaphor",
    });
    const refreshedOld = service.get(old.id)!;
    const refreshedNew = service.get(next.id)!;
    expect(refreshedNew.status).toBe("active");
    expect(refreshedOld.status).toBe("superseded");
    expect(refreshedOld.superseded_by).toBe(next.id);
  });

  it("throws if old_decision_id does not exist, without partial write", () => {
    expect(() =>
      service.supersede({
        old_decision_id: "nonexistent",
        title: "x",
        problem: "p",
        resolution: "r",
        rationale: "why",
      })
    ).toThrow();
    // No dangling decision created
    const dbCount = (store as any).db
      .prepare("SELECT COUNT(*) as c FROM nodes WHERE kind='decision'")
      .get() as { c: number };
    expect(dbCount.c).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/decisions/supersede.test.ts
```

Expected: FAIL — method missing.

- [ ] **Step 3: Add `supersede()` to `DecisionService`**

```ts
supersede(input: SupersedeDecisionInput): Decision {
  return this.store.transaction(() => {
    const oldNode = this.store.getNode(input.old_decision_id);
    if (!oldNode || oldNode.kind !== "decision") {
      throw new Error(`Decision not found: ${input.old_decision_id}`);
    }
    // Create new decision as active
    const created = this.create({
      title: input.title,
      description: input.resolution,
      rationale: input.rationale,
      alternatives: input.alternatives,
      governs: input.governs,
      references: input.references,
      author: input.author,
      problem: input.problem,
      resolution: input.resolution,
    });
    // Mark old superseded
    this.update(input.old_decision_id, {
      status: "superseded",
      superseded_by: created.id,
    });
    // Create SUPERSEDES edge
    this.store.createEdge({
      source_id: created.id,
      target_id: input.old_decision_id,
      relation: "SUPERSEDES",
      data: {},
    });
    return created;
  });
}
```

If `GraphStore` lacks a `transaction(fn)` helper, add one:

```ts
transaction<T>(fn: () => T): T {
  const run = this.db.transaction(fn);
  return run();
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run tests/decisions/supersede.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/service.ts src/graph/store.ts tests/decisions/supersede.test.ts
git commit -m "feat(decisions): add supersede() atomic transaction"
```

---

### Task 6: DecisionService — relation linking + extended get()

**Files:**
- Modify: `src/decisions/service.ts`
- Test: `tests/decisions/relations.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecisionService } from "../../src/decisions/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("DecisionService relations", () => {
  let dir: string;
  let store: GraphStore;
  let service: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-rel-"));
    store = new GraphStore(join(dir, "g.db"));
    service = new DecisionService(store);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("linkRelatedTo + linkDependsOn create edges and appear in getWithRefs", () => {
    const a = service.create({ title: "A", description: "d", rationale: "r", problem: "p", resolution: "res" });
    const b = service.create({ title: "B", description: "d", rationale: "r", problem: "p", resolution: "res" });
    const c = service.create({ title: "C", description: "d", rationale: "r", problem: "p", resolution: "res" });

    service.linkRelatedTo(a.id, b.id);
    service.linkDependsOn(a.id, c.id);

    const view = service.getWithRefs(a.id)!;
    expect(view.related_decisions.map((d) => d.id).sort()).toEqual([b.id].sort());
    expect(view.depends_on.map((d) => d.id).sort()).toEqual([c.id].sort());
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/decisions/relations.test.ts
```

Expected: FAIL — methods missing.

- [ ] **Step 3: Add relation linking and extended get**

Add to `DecisionService`:

```ts
linkRelatedTo(fromId: string, toId: string): void {
  this.requireDecisions(fromId, toId);
  this.store.createEdge({ source_id: fromId, target_id: toId, relation: "DECISION_RELATED_TO", data: {} });
}

linkDependsOn(fromId: string, toId: string): void {
  this.requireDecisions(fromId, toId);
  this.store.createEdge({ source_id: fromId, target_id: toId, relation: "DECISION_DEPENDS_ON", data: {} });
}

private requireDecisions(...ids: string[]): void {
  for (const id of ids) {
    const n = this.store.getNode(id);
    if (!n || n.kind !== "decision") throw new Error(`Decision not found: ${id}`);
  }
}

getWithRefs(id: string): DecisionWithRefs | null {
  const base = this.get(id);
  if (!base) return null;
  const edges = this.store.getEdgesBySource(id).concat(this.store.getEdgesByTarget(id));
  const related = edges.filter(
    (e) => e.relation === "DECISION_RELATED_TO"
  );
  const deps = edges.filter((e) => e.relation === "DECISION_DEPENDS_ON");
  const prIntro = edges.filter(
    (e) => e.relation === "PR_INTRODUCES_DECISION" && e.target_id === id
  );
  const prImpl = edges.filter(
    (e) => e.relation === "PR_IMPLEMENTS_DECISION" && e.target_id === id
  );
  const prChal = edges.filter(
    (e) => e.relation === "PR_CHALLENGES_DECISION" && e.target_id === id
  );
  const prDisc = edges.filter(
    (e) => e.relation === "PR_DISCUSSES_DECISION" && e.target_id === id
  );
  return {
    ...base,
    related_decisions: related
      .map((e) => this.store.getNode(e.source_id === id ? e.target_id : e.source_id))
      .filter((n): n is NodeRow => !!n && n.kind === "decision")
      .map((n) => this.nodeToDecision(n)),
    depends_on: deps
      .filter((e) => e.source_id === id)
      .map((e) => this.store.getNode(e.target_id))
      .filter((n): n is NodeRow => !!n && n.kind === "decision")
      .map((n) => this.nodeToDecision(n)),
    introduced_in: this.prRefForEdges(prIntro),
    implemented_by: this.prRefsForEdges(prImpl),
    challenged_by: this.prRefsForEdges(prChal),
    discussed_in: this.prRefsForEdges(prDisc),
  };
}

private prRefForEdges(edges: EdgeRow[]): PRRef | null {
  const first = edges[0];
  if (!first) return null;
  return this.prRefsForEdges([first])[0] ?? null;
}

private prRefsForEdges(edges: EdgeRow[]): PRRef[] {
  return edges
    .map((e) => this.store.getNode(e.source_id))
    .filter((n): n is NodeRow => !!n && n.kind === "pull_request")
    .map((n) => {
      const data = JSON.parse(n.data || "{}");
      return { number: data.number, title: n.name, state: data.state };
    });
}
```

Add `DecisionWithRefs` and `PRRef` types to `src/decisions/types.ts`:

```ts
export interface PRRef {
  number: number;
  title: string;
  state: PRState;
}

export interface DecisionWithRefs extends Decision {
  related_decisions: Decision[];
  depends_on: Decision[];
  introduced_in: PRRef | null;
  implemented_by: PRRef[];
  challenged_by: PRRef[];
  discussed_in: PRRef[];
}
```

(Import `PRState` from `../prs/types.js`.)

- [ ] **Step 4: Run test to verify pass**

```bash
npx vitest run tests/decisions/relations.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/service.ts src/decisions/types.ts tests/decisions/relations.test.ts
git commit -m "feat(decisions): related_to / depends_on linking + getWithRefs"
```

---

### Task 7: PRService — types wired, `open()`

**Files:**
- Create: `src/prs/service.ts`
- Test: `tests/prs/service.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { PRService } from "../../src/prs/service.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event } from "../../src/events/types.js";

describe("PRService.open", () => {
  let dir: string;
  let store: GraphStore;
  let service: PRService;
  let events: Event[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-open-"));
    store = new GraphStore(join(dir, "g.db"));
    events = [];
    service = new PRService(store, {
      bus: { emit: (e) => events.push(e) },
      default_actor: "tester",
      project_id: "test-project",
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("allocates monotonic numbers starting at 1", () => {
    const a = service.open({ title: "first", author: "mira" });
    const b = service.open({ title: "second", author: "kai" });
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
  });

  it("stores state='open' and source='native' by default, touches=[]", () => {
    const pr = service.open({ title: "x", author: "mira" });
    expect(pr.state).toBe("open");
    expect(pr.source).toBe("native");
    expect(pr.touches).toEqual([]);
  });

  it("emits pr.opened", () => {
    const pr = service.open({ title: "x", author: "mira" });
    const ev = events.find((e) => e.kind === "pr.opened");
    expect(ev).toBeDefined();
    expect((ev as any).payload.pr_number).toBe(pr.number);
    expect((ev as any).payload.title).toBe("x");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
npx vitest run tests/prs/service.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `PRService`**

Create `src/prs/service.ts`:

```ts
import type { GraphStore } from "../graph/store.js";
import type { EventBus, Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";
import type {
  PullRequest,
  OpenPRInput,
  AddPRTouchInput,
  PullRequestWithRefs,
  PRTouch,
} from "./types.js";

export interface PRServiceDeps {
  bus?: EventBus;
  default_actor?: string;
  project_id?: string;
}

export class PRService {
  private bus?: EventBus;
  private defaultActor: string;
  private projectId: string;

  constructor(private store: GraphStore, deps: PRServiceDeps = {}) {
    this.bus = deps.bus;
    this.defaultActor = deps.default_actor ?? "system";
    this.projectId = deps.project_id ?? "";
  }

  open(input: OpenPRInput): PullRequest {
    return this.store.transaction(() => {
      const number = this.allocateNumber();
      const now = new Date().toISOString();
      const data = {
        number,
        state: input.state ?? "open",
        author: input.author,
        opened_at: now,
        merged_at: null,
        closed_at: null,
        branch: input.branch ?? null,
        description: input.description ?? null,
        introduces_frame: input.introduces_frame ?? null,
        additions: input.additions ?? 0,
        comment_count: 0,
        last_activity_at: now,
        source: input.source ?? "native",
        external_ref: input.external_ref ?? null,
        last_synced_at: null,
        touches: [] as PRTouch[],
      };
      const node = this.store.createNode({ kind: "pull_request", name: input.title, data });
      this.emit({
        id: newUlid(),
        kind: "pr.opened",
        actor: this.defaultActor,
        project_id: this.projectId,
        created_at: now,
        payload: {
          pr_number: number,
          title: input.title,
          author: input.author ?? null,
          state: data.state,
          source: data.source,
        },
      });
      return this.nodeToPr(node);
    });
  }

  private allocateNumber(): number {
    const row = (this.store as any).db
      .prepare(
        `SELECT COALESCE(MAX(CAST(json_extract(data, '$.number') AS INTEGER)), 0) + 1 AS n
         FROM nodes WHERE kind = 'pull_request'`
      )
      .get() as { n: number };
    return row.n;
  }

  private nodeToPr(node: { id: string; name: string; data: string }): PullRequest {
    const data = JSON.parse(node.data || "{}");
    return {
      id: node.id,
      number: data.number,
      title: node.name,
      state: data.state,
      author: data.author ?? null,
      opened_at: data.opened_at,
      merged_at: data.merged_at ?? null,
      closed_at: data.closed_at ?? null,
      branch: data.branch ?? null,
      description: data.description ?? null,
      introduces_frame: data.introduces_frame ?? null,
      additions: data.additions ?? 0,
      comment_count: data.comment_count ?? 0,
      last_activity_at: data.last_activity_at ?? null,
      source: data.source ?? "native",
      external_ref: data.external_ref ?? null,
      last_synced_at: data.last_synced_at ?? null,
      touches: data.touches ?? [],
    };
  }

  private emit(event: Event): void {
    this.bus?.emit(event);
  }
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
npx vitest run tests/prs/service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prs/service.ts tests/prs/service.test.ts
git commit -m "feat(prs): PRService.open() with monotonic numbering"
```

---

### Task 8: PRService.addTouch

**Files:**
- Modify: `src/prs/service.ts`
- Extend: `tests/prs/service.test.ts`

- [ ] **Step 1: Add failing test**

Append to `tests/prs/service.test.ts`:

```ts
describe("PRService.addTouch", () => {
  let dir: string;
  let store: GraphStore;
  let service: PRService;
  let events: Event[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-touch-"));
    store = new GraphStore(join(dir, "g.db"));
    events = [];
    service = new PRService(store, {
      bus: { emit: (e) => events.push(e) },
      project_id: "t",
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("appends touch to inline array and emits pr.touched", () => {
    const pr = service.open({ title: "x", author: "m" });
    service.addTouch({
      pr_number: pr.number,
      frame_id: "src/temporal",
      node_name: "timeline.ts",
      action: "added",
    });
    const refreshed = service.get(pr.number)!;
    expect(refreshed.touches).toEqual([
      { frame_id: "src/temporal", node_name: "timeline.ts", action: "added" },
    ]);
    const ev = events.find((e) => e.kind === "pr.touched");
    expect(ev).toBeDefined();
  });

  it("is idempotent on duplicate touch", () => {
    const pr = service.open({ title: "x", author: "m" });
    service.addTouch({ pr_number: pr.number, frame_id: "a", node_name: "b", action: "added" });
    service.addTouch({ pr_number: pr.number, frame_id: "a", node_name: "b", action: "added" });
    expect(service.get(pr.number)!.touches.length).toBe(1);
  });

  it("throws on unknown PR number", () => {
    expect(() =>
      service.addTouch({ pr_number: 999, frame_id: "a", node_name: "b", action: "added" })
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/prs/service.test.ts
```

Expected: FAIL — `addTouch` missing, `get` missing.

- [ ] **Step 3: Implement `addTouch` and minimal `get`**

In `src/prs/service.ts`:

```ts
addTouch(input: AddPRTouchInput): void {
  this.store.transaction(() => {
    const node = this.findByNumber(input.pr_number);
    if (!node) throw new Error(`PR not found: #${input.pr_number}`);
    const data = JSON.parse(node.data || "{}");
    const touches: PRTouch[] = data.touches ?? [];
    const exists = touches.some(
      (t) => t.frame_id === input.frame_id && t.node_name === input.node_name && t.action === input.action
    );
    if (exists) return;
    touches.push({ frame_id: input.frame_id, node_name: input.node_name, action: input.action });
    data.touches = touches;
    this.store.updateNode(node.id, { data });
    this.emit({
      id: newUlid(),
      kind: "pr.touched",
      actor: this.defaultActor,
      project_id: this.projectId,
      created_at: new Date().toISOString(),
      payload: {
        pr_number: input.pr_number,
        frame_id: input.frame_id,
        node_name: input.node_name,
        action: input.action,
      },
    });
  });
}

get(number: number): PullRequest | null {
  const node = this.findByNumber(number);
  return node ? this.nodeToPr(node) : null;
}

private findByNumber(num: number): { id: string; name: string; data: string } | null {
  const row = (this.store as any).db
    .prepare(
      `SELECT id, name, data FROM nodes WHERE kind = 'pull_request'
       AND CAST(json_extract(data, '$.number') AS INTEGER) = ?`
    )
    .get(num) as { id: string; name: string; data: string } | undefined;
  return row ?? null;
}
```

- [ ] **Step 4: Run, verify pass, commit**

```bash
npx vitest run tests/prs/service.test.ts
git add src/prs/service.ts tests/prs/service.test.ts
git commit -m "feat(prs): addTouch() appends inline, emits pr.touched"
```

---

### Task 9: PRService.merge (atomic + ratify)

**Files:**
- Modify: `src/prs/service.ts`
- Extend: `tests/prs/service.test.ts`
- Modify: `src/decisions/service.ts` (add `ratify()` helper called by merge)

- [ ] **Step 1: Add failing test**

Append to `tests/prs/service.test.ts`:

```ts
import { DecisionService } from "../../src/decisions/service.js";

describe("PRService.merge", () => {
  let dir: string;
  let store: GraphStore;
  let prs: PRService;
  let decisions: DecisionService;
  let events: Event[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-merge-"));
    store = new GraphStore(join(dir, "g.db"));
    events = [];
    const bus = { emit: (e: Event) => events.push(e) };
    decisions = new DecisionService(store, { bus });
    prs = new PRService(store, { bus, decisions });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("ratifies introduced proposed decisions from proposed to active on merge", () => {
    const pr = prs.open({ title: "add temporal", author: "mira", introduces_frame: "src/temporal" });
    const prop = decisions.propose({
      title: "causal ordering",
      problem: "need order",
      resolution: "Lamport",
      rationale: "causality",
      pr_number: pr.number,
    });
    const result = prs.merge(pr.number);
    expect(result.ratified_decisions).toContain(prop.id);
    expect(decisions.get(prop.id)!.status).toBe("active");
    expect(prs.get(pr.number)!.state).toBe("merged");
  });

  it("emits pr.merged and decision.ratified", () => {
    const pr = prs.open({ title: "x", author: "m" });
    const prop = decisions.propose({
      title: "y",
      problem: "p",
      resolution: "r",
      rationale: "w",
      pr_number: pr.number,
    });
    prs.merge(pr.number);
    expect(events.find((e) => e.kind === "pr.merged")).toBeDefined();
    expect(events.find((e) => e.kind === "decision.ratified")).toBeDefined();
  });

  it("merging an already-merged PR throws", () => {
    const pr = prs.open({ title: "x", author: "m" });
    prs.merge(pr.number);
    expect(() => prs.merge(pr.number)).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/prs/service.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Add `ratify()` to `DecisionService`**

```ts
ratify(decisionId: string, viaPrNumber: number): void {
  const d = this.get(decisionId);
  if (!d) throw new Error(`Decision not found: ${decisionId}`);
  if (d.status !== "proposed") return;     // noop
  this.update(decisionId, { status: "active" });
  this.emit({
    id: newUlid(),
    kind: "decision.ratified",
    actor: this.defaultActor,
    project_id: this.projectId,
    created_at: new Date().toISOString(),
    payload: { decision_id: decisionId, via_pr_number: viaPrNumber },
  });
}
```

- [ ] **Step 4: Add `merge()` to `PRService`**

```ts
export interface PRServiceDeps {
  bus?: EventBus;
  default_actor?: string;
  project_id?: string;
  decisions?: DecisionService;       // needed for ratify
}

// ...

merge(number: number): { pr_number: number; ratified_decisions: string[] } {
  return this.store.transaction(() => {
    const node = this.findByNumber(number);
    if (!node) throw new Error(`PR not found: #${number}`);
    const data = JSON.parse(node.data || "{}");
    if (data.state === "merged") throw new Error(`PR #${number} already merged`);
    const now = new Date().toISOString();
    data.state = "merged";
    data.merged_at = now;
    data.last_activity_at = now;
    this.store.updateNode(node.id, { data });

    // find introduced decisions that are still proposed
    const edges = this.store
      .getEdgesBySource(node.id)
      .filter((e) => e.relation === "PR_INTRODUCES_DECISION");
    const ratified: string[] = [];
    for (const e of edges) {
      const dec = this.store.getNode(e.target_id);
      if (!dec || dec.kind !== "decision") continue;
      const dd = JSON.parse(dec.data || "{}");
      if (dd.status === "proposed" && this.decisions) {
        this.decisions.ratify(e.target_id, number);
        ratified.push(e.target_id);
      }
    }

    this.emit({
      id: newUlid(),
      kind: "pr.merged",
      actor: this.defaultActor,
      project_id: this.projectId,
      created_at: now,
      payload: { pr_number: number, ratified_decisions: ratified },
    });
    return { pr_number: number, ratified_decisions: ratified };
  });
}
```

Add `decisions?: DecisionService` to the service constructor deps and store it as a field.

- [ ] **Step 5: Run, verify pass, commit**

```bash
npx vitest run tests/prs/service.test.ts
git add src/prs/service.ts src/decisions/service.ts tests/prs/service.test.ts
git commit -m "feat(prs): merge() atomically ratifies introduced decisions"
```

---

### Task 10: PRService.getWithRefs

**Files:**
- Modify: `src/prs/service.ts`
- Extend: `tests/prs/service.test.ts`

- [ ] **Step 1: Add failing test**

```ts
describe("PRService.getWithRefs", () => {
  let dir: string;
  let store: GraphStore;
  let prs: PRService;
  let decisions: DecisionService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-pr-refs-"));
    store = new GraphStore(join(dir, "g.db"));
    const bus = { emit: () => {} };
    decisions = new DecisionService(store, { bus });
    prs = new PRService(store, { bus, decisions });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves introduces / implements / challenges / discusses groups", () => {
    const pr = prs.open({ title: "x", author: "m" });
    const intro = decisions.propose({
      title: "a", problem: "p", resolution: "r", rationale: "w", pr_number: pr.number,
    });
    const impl = decisions.create({ title: "b", description: "d", rationale: "r", problem: "p", resolution: "r" });
    store.createEdge({ source_id: prs.get(pr.number)!.id, target_id: impl.id, relation: "PR_IMPLEMENTS_DECISION", data: {} });

    const view = prs.getWithRefs(pr.number)!;
    expect(view.introduces_decisions).toContain(intro.id);
    expect(view.implements_decisions).toContain(impl.id);
  });
});
```

- [ ] **Step 2: Implement `getWithRefs`**

```ts
getWithRefs(number: number): PullRequestWithRefs | null {
  const base = this.get(number);
  if (!base) return null;
  const edges = this.store.getEdgesBySource(base.id);

  const pick = (relation: string): string[] =>
    edges.filter((e) => e.relation === relation).map((e) => e.target_id);

  return {
    ...base,
    introduces_decisions: pick("PR_INTRODUCES_DECISION"),
    implements_decisions: pick("PR_IMPLEMENTS_DECISION"),
    challenges_decisions: pick("PR_CHALLENGES_DECISION"),
    discusses_decisions: pick("PR_DISCUSSES_DECISION"),
    linked_prs: edges
      .filter((e) => e.relation === "PR_LINK_DEPENDS_ON" || e.relation === "PR_LINK_RELATED_TO")
      .map((e) => {
        const target = this.store.getNode(e.target_id);
        const tdata = target ? JSON.parse(target.data || "{}") : {};
        return {
          relation: e.relation === "PR_LINK_DEPENDS_ON" ? ("depends_on" as const) : ("related_to" as const),
          pr_number: tdata.number,
        };
      }),
  };
}
```

- [ ] **Step 3: Run, verify pass, commit**

```bash
npx vitest run tests/prs/service.test.ts
git add src/prs/service.ts tests/prs/service.test.ts
git commit -m "feat(prs): getWithRefs resolves decision + PR edge groups"
```

---

### Task 11: Extend mutation-deriver for new event kinds

**Files:**
- Modify: `src/events/worker/mutation-deriver.ts`
- Test: `tests/events/mutation-deriver.test.ts` (extend existing, if present, else create)

- [ ] **Step 1: Write the failing test**

Append (or create) test cases:

```ts
import { describe, it, expect } from "vitest";
import { deriveMutations } from "../../src/events/worker/mutation-deriver.js";
import type { Event } from "../../src/events/types.js";

describe("deriveMutations — PR + decision ratification events", () => {
  it("pr.opened produces add_node for pull_request", () => {
    const ev: Event = {
      id: "e1",
      kind: "pr.opened",
      actor: "mira",
      project_id: "p",
      created_at: "2026-04-21T00:00:00Z",
      payload: { pr_number: 1, title: "x", author: "m", state: "open", source: "native" },
    };
    const muts = deriveMutations(ev);
    expect(muts.some((m) => m.op === "add_node")).toBe(true);
  });

  it("pr.touched produces update_node", () => {
    const ev: Event = {
      id: "e2", kind: "pr.touched", actor: "m", project_id: "p", created_at: "t",
      payload: { pr_number: 1, frame_id: "a", node_name: "b", action: "added" },
    };
    const muts = deriveMutations(ev);
    expect(muts.some((m) => m.op === "update_node")).toBe(true);
  });

  it("pr.merged produces update_node for PR and update_node per ratified decision", () => {
    const ev: Event = {
      id: "e3", kind: "pr.merged", actor: "m", project_id: "p", created_at: "t",
      payload: { pr_number: 1, ratified_decisions: ["d1", "d2"] },
    };
    const muts = deriveMutations(ev);
    // 1 PR update + 2 decision updates
    expect(muts.filter((m) => m.op === "update_node").length).toBe(3);
  });

  it("decision.ratified produces update_node", () => {
    const ev: Event = {
      id: "e4", kind: "decision.ratified", actor: "m", project_id: "p", created_at: "t",
      payload: { decision_id: "d1", via_pr_number: 1 },
    };
    const muts = deriveMutations(ev);
    expect(muts.some((m) => m.op === "update_node" && m.id === "d1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify failure**

```bash
npx vitest run tests/events/mutation-deriver.test.ts
```

- [ ] **Step 3: Extend `deriveMutations` switch**

Add cases in `src/events/worker/mutation-deriver.ts`:

```ts
case "decision.proposed":
  return [{ op: "add_node", node: { id: event.payload.decision_id, kind: "decision", name: event.payload.title } }];

case "decision.ratified":
  return [{ op: "update_node", id: event.payload.decision_id, fields: { /* status in data */ } }];

case "pr.opened":
  return [{ op: "add_node", node: {
    id: event.id, kind: "pull_request", name: event.payload.title,
    data: { number: event.payload.pr_number, state: event.payload.state, source: event.payload.source },
  }}];

case "pr.touched":
  return [{ op: "update_node", id: `pr:${event.payload.pr_number}`, fields: {} }];

case "pr.merged":
  return [
    { op: "update_node", id: `pr:${event.payload.pr_number}`, fields: {} },
    ...event.payload.ratified_decisions.map((id) => ({ op: "update_node" as const, id, fields: {} })),
  ];
```

(Follow exactly the `WireNode` / mutation-shape conventions you find in the existing cases. Use the PR node's UUID if accessible; otherwise use a `pr:<number>` wire id and resolve in the client.)

- [ ] **Step 4: Run test, verify pass, commit**

```bash
npx vitest run tests/events/mutation-deriver.test.ts
git add src/events/worker/mutation-deriver.ts tests/events/mutation-deriver.test.ts
git commit -m "feat(events): derive mutations for pr.*/decision.ratified"
```

---

### Task 12: MCP tools — `propose_decision` + `supersede_decision` + extensions

**Files:**
- Modify: `src/mcp-server/tools/decision-tools.ts`

- [ ] **Step 1: Add `propose_decision` handler**

After the existing `create_decision` registration:

```ts
server.tool(
  "propose_decision",
  "Create a proposed decision (status='proposed'). Optionally link to a PR as 'introduces'.",
  {
    title: z.string(),
    problem: z.string(),
    resolution: z.string(),
    rationale: z.string(),
    alternatives: z.array(AlternativeSchema).optional(),
    governs: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
    pr_number: z.number().int().optional(),
  },
  async (params) => {
    try {
      const d = service.propose(params);
      return ok(JSON.stringify(d, null, 2));
    } catch (e) {
      return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
    }
  }
);
```

- [ ] **Step 2: Add `supersede_decision` handler**

```ts
server.tool(
  "supersede_decision",
  "Atomically create a new decision that supersedes an existing one.",
  {
    old_decision_id: z.string(),
    title: z.string(),
    problem: z.string(),
    resolution: z.string(),
    rationale: z.string(),
    alternatives: z.array(AlternativeSchema).optional(),
    governs: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
  },
  async (params) => {
    try {
      const d = service.supersede(params);
      return ok(JSON.stringify(d, null, 2));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not found/i.test(msg)) return empty(`supersede_decision(${params.old_decision_id})`);
      return errorResponse("internal_error", msg);
    }
  }
);
```

- [ ] **Step 3: Extend `create_decision` + `update_decision` Zod schemas**

In the existing registrations, add to the schema object:

```ts
problem: z.string().optional().describe("Narrative: what question this decision answers"),
resolution: z.string().optional().describe("Narrative: what was decided"),
```

- [ ] **Step 4: Extend `link_decision`**

Change the relation enum:

```ts
relation: z.enum(["GOVERNS", "REFERENCES", "RELATED_TO", "DEPENDS_ON"])
  .optional()
  .describe("Edge type (default: GOVERNS)"),
```

And dispatch inside the handler:

```ts
const rel = relation ?? "GOVERNS";
if (rel === "GOVERNS") service.linkGoverns(decision_id, target);
else if (rel === "REFERENCES") service.linkReference(decision_id, target);
else if (rel === "RELATED_TO") service.linkRelatedTo(decision_id, target);
else if (rel === "DEPENDS_ON") service.linkDependsOn(decision_id, target);
```

- [ ] **Step 5: Extend `get_decision` response**

Replace the handler's `service.get(id)` call with `service.getWithRefs(id)`, returning the extended shape. If `get_decision` was always just `service.get(...)`, preserve behavior for missing IDs (return `empty(...)`).

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server/tools/decision-tools.ts
git commit -m "feat(mcp): propose/supersede + extended update/get/link decision tools"
```

---

### Task 13: MCP tools — `open_pr` / `add_pr_touch` / `merge_pr` / `get_pr`

**Files:**
- Create: `src/mcp-server/tools/pr-tools.ts`

- [ ] **Step 1: Write pr-tools.ts**

```ts
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PRService } from "../../prs/service.js";
import { ok, empty, error as errorResponse } from "../response.js";

export function registerPRTools(server: McpServer, prs: PRService): void {
  server.tool(
    "open_pr",
    "Create a pull request entity in the graph.",
    {
      title: z.string(),
      author: z.string(),
      description: z.string().optional(),
      branch: z.string().optional(),
      state: z.enum(["draft", "open", "merged", "closed"]).optional(),
      introduces_frame: z.string().optional(),
      additions: z.number().int().optional(),
      source: z.enum(["native", "mirror", "scenario"]).optional(),
      external_ref: z
        .object({
          provider: z.string(),
          repo: z.string(),
          number: z.number().int(),
          url: z.string(),
        })
        .optional(),
    },
    async (params) => {
      try {
        const pr = prs.open(params);
        return ok(JSON.stringify(pr, null, 2));
      } catch (e) {
        return errorResponse("internal_error", e instanceof Error ? e.message : String(e));
      }
    }
  );

  server.tool(
    "add_pr_touch",
    "Record that a PR touches (adds or modifies) a file.",
    {
      pr_number: z.number().int(),
      frame_id: z.string(),
      node_name: z.string(),
      action: z.enum(["added", "modified"]),
    },
    async (params) => {
      try {
        prs.addTouch(params);
        return ok(JSON.stringify({ ok: true, ...params }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`add_pr_touch(#${params.pr_number})`);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "merge_pr",
    "Mark a PR merged. Ratifies any introduced decisions from proposed to active.",
    { pr_number: z.number().int() },
    async ({ pr_number }) => {
      try {
        const result = prs.merge(pr_number);
        return ok(JSON.stringify(result, null, 2));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not found/i.test(msg)) return empty(`merge_pr(#${pr_number})`);
        return errorResponse("internal_error", msg);
      }
    }
  );

  server.tool(
    "get_pr",
    "Fetch a PR with resolved decision refs and linked PRs.",
    { pr_number: z.number().int() },
    async ({ pr_number }) => {
      const pr = prs.getWithRefs(pr_number);
      if (!pr) return empty(`get_pr(#${pr_number})`);
      return ok(JSON.stringify(pr, null, 2));
    }
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/mcp-server/tools/pr-tools.ts
git commit -m "feat(mcp): register open_pr / add_pr_touch / merge_pr / get_pr"
```

---

### Task 14: Server bootstrap — instantiate PRService, register tools

**Files:**
- Modify: `src/index.ts`
- Modify: `src/mcp-server/server.ts` (or wherever tool registration is orchestrated)
- Modify: `tests/mcp-contract/harness.ts` (add PR service + tools)

- [ ] **Step 1: Construct `PRService` alongside `DecisionService`**

In `src/index.ts`, find where `DecisionService` is created (around lines 20-40 per exploration notes). Add:

```ts
import { PRService } from "./prs/service.js";
import { registerPRTools } from "./mcp-server/tools/pr-tools.js";

const decisionService = new DecisionService(store, {
  bus,
  default_actor: defaultActor,
  project_id: projectId,
});
const prService = new PRService(store, {
  bus,
  default_actor: defaultActor,
  project_id: projectId,
  decisions: decisionService,
});

// ...registration site...
registerDecisionTools(server, decisionService, search);
registerPRTools(server, prService);
```

- [ ] **Step 2: Update the test harness**

In `tests/mcp-contract/harness.ts`, import and wire `PRService`:

```ts
import { PRService } from "../../src/prs/service.js";
import { registerPRTools } from "../../src/mcp-server/tools/pr-tools.js";

// inside createHarness, after DecisionService construction:
const prService = new PRService(store, {
  default_actor: "tester",
  project_id: project,
  decisions: service,
});
registerPRTools(server, prService);
```

Return `prService` on the `HarnessContext` object for tests that want direct access.

- [ ] **Step 3: Typecheck + existing tests**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: clean. Existing contract tests still pass because no existing tool behaviour changed.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts src/mcp-server/server.ts tests/mcp-contract/harness.ts
git commit -m "feat(server): wire PRService + register PR tools at bootstrap"
```

---

### Task 15: Contract test — PR lifecycle end-to-end

**Files:**
- Create: `tests/mcp-contract/pr-tools.test.ts`

- [ ] **Step 1: Write the lifecycle test**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, type HarnessContext, callTool } from "./harness.js";
import { ResponseSchema } from "../../src/mcp-server/response.js";

describe("PR tools contract — lifecycle", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("open_pr → add_pr_touch × 3 → propose_decision(pr_number) → merge_pr ratifies", async () => {
    // open
    const openRes = await callTool(h, "open_pr", { title: "temporal subsystem", author: "mira", introduces_frame: "src/temporal" });
    expect(ResponseSchema.safeParse(openRes).success).toBe(true);
    expect(openRes.isError).toBeFalsy();
    const pr = JSON.parse(openRes.content[0].text);
    expect(pr.number).toBeTypeOf("number");
    expect(pr.state).toBe("open");

    // touches
    for (const touch of [
      { frame_id: "src/temporal", node_name: "timeline.ts",  action: "added" },
      { frame_id: "src/temporal", node_name: "ordering.ts",  action: "added" },
      { frame_id: "src/events",   nodeName: "emitter.ts",    action: "modified" },
    ]) {
      const tRes = await callTool(h, "add_pr_touch", { pr_number: pr.number, ...touch });
      expect(tRes.isError).toBeFalsy();
    }

    // propose a decision introduced by the PR
    const propRes = await callTool(h, "propose_decision", {
      title: "causal ordering",
      problem: "need order",
      resolution: "Lamport + wall clock",
      rationale: "causal consistency",
      pr_number: pr.number,
    });
    const prop = JSON.parse(propRes.content[0].text);
    expect(prop.status).toBe("proposed");

    // merge
    const mRes = await callTool(h, "merge_pr", { pr_number: pr.number });
    const merged = JSON.parse(mRes.content[0].text);
    expect(merged.ratified_decisions).toContain(prop.id);

    // PR and decision final state
    const getPr = JSON.parse((await callTool(h, "get_pr", { pr_number: pr.number })).content[0].text);
    expect(getPr.state).toBe("merged");
    const getDec = JSON.parse((await callTool(h, "get_decision", { id: prop.id })).content[0].text);
    expect(getDec.status).toBe("active");
  });

  it("merge_pr on unknown number returns No results", async () => {
    const res = await callTool(h, "merge_pr", { pr_number: 99999 });
    expect(res.content[0].text.startsWith("No results:")).toBe(true);
  });

  it("get_pr on unknown number returns No results", async () => {
    const res = await callTool(h, "get_pr", { pr_number: 99999 });
    expect(res.content[0].text.startsWith("No results:")).toBe(true);
  });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run tests/mcp-contract/pr-tools.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-contract/pr-tools.test.ts
git commit -m "test(mcp-contract): PR lifecycle end-to-end"
```

---

### Task 16: Contract test — Decision extensions + backwards compat

**Files:**
- Create: `tests/mcp-contract/decision-extensions.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, type HarnessContext, callTool } from "./harness.js";

describe("decision extensions contract", () => {
  let h: HarnessContext;
  beforeAll(async () => { h = await createHarness(); });
  afterAll(async () => { await h.close(); });

  it("propose_decision creates status=proposed and is readable via get_decision", async () => {
    const r = await callTool(h, "propose_decision", {
      title: "D1",
      problem: "p",
      resolution: "r",
      rationale: "why",
    });
    const d = JSON.parse(r.content[0].text);
    expect(d.status).toBe("proposed");
    expect(d.problem).toBe("p");
    expect(d.resolution).toBe("r");

    const g = JSON.parse((await callTool(h, "get_decision", { id: d.id })).content[0].text);
    expect(g.status).toBe("proposed");
    expect(g.problem).toBe("p");
  });

  it("supersede_decision atomic: old becomes superseded, new is active with superseded_by->old backlink", async () => {
    const a = JSON.parse(
      (await callTool(h, "create_decision", {
        title: "old", description: "d", rationale: "r", problem: "p", resolution: "res",
      })).content[0].text
    );
    const b = JSON.parse(
      (await callTool(h, "supersede_decision", {
        old_decision_id: a.id, title: "new", problem: "np", resolution: "nr", rationale: "why",
      })).content[0].text
    );
    expect(b.status).toBe("active");
    const ga = JSON.parse((await callTool(h, "get_decision", { id: a.id })).content[0].text);
    expect(ga.status).toBe("superseded");
    expect(ga.superseded_by).toBe(b.id);
  });

  it("link_decision supports RELATED_TO and DEPENDS_ON", async () => {
    const a = JSON.parse((await callTool(h, "create_decision", { title: "A", description: "d", rationale: "r" })).content[0].text);
    const b = JSON.parse((await callTool(h, "create_decision", { title: "B", description: "d", rationale: "r" })).content[0].text);
    const c = JSON.parse((await callTool(h, "create_decision", { title: "C", description: "d", rationale: "r" })).content[0].text);

    await callTool(h, "link_decision", { decision_id: a.id, target: b.id, relation: "RELATED_TO" });
    await callTool(h, "link_decision", { decision_id: a.id, target: c.id, relation: "DEPENDS_ON" });

    const view = JSON.parse((await callTool(h, "get_decision", { id: a.id })).content[0].text);
    expect(view.related_decisions.map((d: any) => d.id)).toContain(b.id);
    expect(view.depends_on.map((d: any) => d.id)).toContain(c.id);
  });

  it("legacy decision (no problem/resolution) remains readable with null fields", async () => {
    // write directly via store to simulate legacy row
    const { store } = h;
    const now = new Date().toISOString();
    (store as any).db.prepare(
      `INSERT INTO nodes (id, kind, name, data, created_at, updated_at)
       VALUES (?, 'decision', ?, ?, ?, ?)`
    ).run("legacy-1", "Old", JSON.stringify({ description: "d", rationale: "r" }), now, now);

    const g = JSON.parse((await callTool(h, "get_decision", { id: "legacy-1" })).content[0].text);
    expect(g.problem).toBeNull();
    expect(g.resolution).toBeNull();
    expect(g.description).toBe("d");
  });

  it("search_decisions finds matches on new problem field", async () => {
    await callTool(h, "propose_decision", {
      title: "Z", problem: "unicorn banana rarity", resolution: "x", rationale: "r",
    });
    const r = await callTool(h, "search_decisions", { query: "unicorn" });
    expect(r.content[0].text).toContain("unicorn");
  });
});
```

- [ ] **Step 2: Run**

```bash
npx vitest run tests/mcp-contract/decision-extensions.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp-contract/decision-extensions.test.ts
git commit -m "test(mcp-contract): decision extensions + backwards compat"
```

---

### Task 17: Final full-suite verification

- [ ] **Step 1: Run the full suite**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all tests green, no TypeScript errors.

- [ ] **Step 2: Summarise for PR**

Prepare PR description covering:
- Extended decisions with `problem`/`resolution` + new `proposed` / `ratified` status transitions
- New `pull_request` entity stored as graph node
- New MCP tools: `propose_decision`, `supersede_decision`, `open_pr`, `add_pr_touch`, `merge_pr`, `get_pr`
- Extended MCP tools: `create_decision`, `update_decision`, `link_decision`, `get_decision`, `search_decisions`
- New event kinds: `pr.opened`, `pr.touched`, `pr.merged`, `decision.proposed` (now emitted), `decision.ratified`
- FTS5 migration on first startup after upgrade
- No data loss; existing decisions readable as before

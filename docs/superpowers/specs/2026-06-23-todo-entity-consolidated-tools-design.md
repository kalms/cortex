# TODO entity + consolidated per-type tool surface — design

> **Status:** adopted, ready for implementation planning. Brainstormed
> 2026-06-23. This is the **foundation slice** of the TODO entity (the
> headline feature of the post-taxonomy line, designed in
> [`docs/specs/cortex-v0.3/todo-entity.md`](../../specs/cortex-v0.3/todo-entity.md))
> combined with the P7 tool-surface consolidation from
> [`HANDOFF.md`](../../../HANDOFF.md).

---

## 1. Summary

Introduce the **TODO entity** — the third user-authored primitive alongside
`Decision` and `PullRequest`, representing *future* planned work — and, in the
same slice, **consolidate the MCP primitive tool surface** from 17 granular
tools into 3 per-type, `action`-dispatched tools (`decision`, `todo`, `pr`).

TODOs are born directly in the consolidated shape; decisions and PRs are
migrated into it at the same time (a **clean break** — old tool names removed,
all callers updated). This avoids building a granular TODO tool surface only to
re-fold it later, and pays down the P7 token-tax debt while we're in the area.

This slice gives TODO **full schema/contract parity with decisions** — an
explicit domain-types module, input validation, and the versioned HTTP API
contract — on top of storage + tools. Only the viewer *rendering*, the hooks,
the external-system bridge, and live event emission are deferred to later
slices.

## 2. Goals / non-goals

**Goals**
- Durable TODO storage in the existing primitives DB, mirroring the decisions
  layer (tables, repositories, FTS, `T-` IDs + per-repo `seq`, idempotent
  migration).
- A state machine (`open → in_progress → blocked → done/cancelled`) enforced in
  the service layer, never via direct state mutation.
- A consolidated, `action`-dispatched MCP tool per primitive type:
  `decision` (13 actions), `todo` (7 actions), `pr` (4 actions).
- Behavior parity for every migrated decision/PR action, guarded by contract
  tests (the service logic does not change; only the registration layer does).
- All in-repo callers (skills, hooks, docs) updated to the new tool names; a
  CHANGELOG migration note for the external `mesh` consumer.
- **Full schema/contract parity with decisions** (see §4.4): an explicit
  `src/todos/types.ts`; TODO input validation; and the versioned HTTP API
  contract (`AdaptedTodoSchema` in the Zod SSoT + a pure adapter + `GET
  /api/todos` + drift-guarded generated JSON).

**Non-goals (deferred slices)**
- **Viewer rendering:** yellow TODO dots, drawer surface, marginalia pills,
  decision→TODO leader lines, the decision drawer "Tasks" section (touches
  [`src/viewer/adapters.js`](../../../src/viewer/adapters.js), `viewer.js`). The
  HTTP contract that *feeds* the viewer (`/api/todos` + `AdaptedTodoSchema`) is
  **in scope** this slice (§4.4); only the pixels are deferred.
- **Live event emission:** the decision/PR dispatchers preserve their existing
  `EventBus` broadcasts exactly, but **new TODO actions do not emit yet** — TODO
  live-stream events land with the viewer/multiplayer slice (no live consumer
  exists until then).
- **Hooks:** `PostMergeHook` auto-completing `resolvedBy` TODOs on PR merge; a
  new `PostDecisionHook` linking `spawnsFrom`.
- **External bridge:** Linear/JIRA/GitHub mirroring (`link_external`,
  `pull_external_todo`, `push_todo_to_external`). The design notes already defer
  full bidirectional sync to v1.5.
- A full `AgentRef` identity model (see §4.1 simplification).
- Any change to the code/graph/index tools (`search_graph`, `context_pack`,
  `index_*`, `query_graph`, etc.) — untouched.

## 3. Background — current state (verified against the code)

- **Primitives DB:** `~/.cortex/<repoId>/decisions.db`, opened idempotently by
  `openDecisionsDb` in [`src/decisions/db.ts`](../../../src/decisions/db.ts).
  Tables: `decisions`, `decision_links`, `schema_meta`, and **`id_sequences`**
  — already keyed `entity_type TEXT PRIMARY KEY` with the comment
  `'decision' | 'todo'` and `next_val`. FTS5 is an external-content table
  (`decisions_fts`) synced by `decisions_ai/ad/au` triggers; the repository
  writes only the content table.
- **Repository pattern:** `DecisionsRepository`
  ([`src/decisions/repository.ts`](../../../src/decisions/repository.ts)) —
  `insert/get/getBySeq/update/delete/list/search` + `toFtsMatch` (safe FTS
  query builder). `DecisionLinksRepository`
  ([`src/decisions/links-repository.ts`](../../../src/decisions/links-repository.ts))
  holds governance/supersession/PR links. Mint logic (`D-<base32x4>` + `seq`
  from `id_sequences`) lives in `DecisionService`
  ([`src/decisions/service.ts`](../../../src/decisions/service.ts)).
- **PRs** are `pull_request` nodes in the **graph DB** (not the decisions DB),
  managed by `PRService` ([`src/prs/service.ts`](../../../src/prs/service.ts)):
  `open / addTouch / merge / getWithRefs`. `merge` ratifies any introduced
  proposed decisions. So consolidating PRs is purely a tool-layer change.
- **Tool registration:** `server.tool(name, description, zodShape, handler)` via
  the MCP SDK, where `handler = registerTool(name, schema, fn, { resolver })`
  injects a per-call `RepoContext` (DB handles, graph store). Tools are grouped
  into `register*Tools(server, resolver, indexerProject, bus)` in
  [`src/mcp-server/server.ts`](../../../src/mcp-server/server.ts):
  `registerDecisionTools`, `registerPromotionTools`, `registerCodeTools`,
  `registerPRTools`, `registerReconciliationTools`. Responses use the
  `ok/empty/error` helpers in `src/mcp-server/response.ts`.
- **HTTP API contract:** [`api-schemas.ts`](../../../src/mcp-server/api-schemas.ts)
  is the Zod **single source of truth** (`CONTRACT_VERSION = 1`; every response
  carries a `version` literal). `AdaptedDecisionSchema` lives there; the pure
  [`api-decisions.ts`](../../../src/mcp-server/api-decisions.ts) adapter maps DB
  rows → the wire shape; `npm run gen:api-schemas` regenerates
  `docs/api/*.schema.json`, guarded by `tests/api/schema-drift.test.ts`. The
  card vocabulary (`summary`/`state`/`proposedBy`/…) is already shared across
  primitives — decisions adapt *to* it.

**Current primitive tool inventory (17):**

| File | Tools |
|---|---|
| `tools/decision-tools.ts` | `create_decision`, `update_decision`, `delete_decision`, `get_decision`, `search_decisions`, `why_was_this_built`, `decision_candidates`, `link_decision` |
| `tools/promotion-tools.ts` | `promote_decision`, `propose_decision`, `supersede_decision` |
| `tools/reconciliation-tools.ts` | `record_reconciliation`, `pending_reconciliations` |
| `tools/pr-tools.ts` | `open_pr`, `add_pr_touch`, `merge_pr`, `get_pr` |

## 4. Design

### 4.1 Storage foundation (mirrors decisions)

Add two tables to `BASE_SCHEMA` in `db.ts`, `CREATE TABLE IF NOT EXISTS`
(additive; no data migration — no TODOs exist yet):

```sql
CREATE TABLE IF NOT EXISTS todos (
  id           TEXT PRIMARY KEY,   -- 'T-<base32x4>'
  seq          INTEGER,            -- per-repo display sequence
  summary      TEXT NOT NULL,
  description  TEXT,
  state        TEXT NOT NULL DEFAULT 'open',   -- open|in_progress|blocked|done|cancelled
  state_reason TEXT,               -- last block/cancel reason (nullable)
  proposed_by  TEXT,               -- author-style string (see simplification)
  proposed_at  TEXT NOT NULL,
  started_at   TEXT,               -- set on first → in_progress
  closed_at    TEXT,               -- set on → done|cancelled
  assignee     TEXT,               -- author-style string, nullable
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS todo_links (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  todo_id     TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,      -- file|function|symbol|frame|decision|pr|todo
  target_ref  TEXT NOT NULL,      -- string qn / path / id (NOT graph node id)
  relation    TEXT NOT NULL,      -- governs|blockedBy|relatedTo|spawnsFrom|resolvedBy
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todo_links_todo   ON todo_links(todo_id);
CREATE INDEX IF NOT EXISTS idx_todo_links_target ON todo_links(target_kind, target_ref);
```

Plus a `todos_fts` external-content FTS5 table over `summary, description` with
`todos_ai/ad/au` triggers, exactly mirroring the decisions FTS pattern. Because
`todos_fts` is new, no FTS-version rebuild of `decisions_fts` is needed.

- **`TodosRepository`** + **`TodoLinksRepository`** mirroring the decision
  repos (content-table-only writes; FTS via triggers; `toFtsMatch` reused or
  duplicated).
- **`TodoService`** mirroring `DecisionService`, reusing the **same
  `id_sequences` mint** with `entity_type='todo'` and prefix `T-`. Factor the
  mint helper out of `DecisionService` if it isn't already shared, so both
  primitives use one implementation.
- **Links semantics:** `relation` ∈ `governs` (code refs / frames),
  `blockedBy` (→ todo), `relatedTo` (→ todo), `spawnsFrom` (→ decision; 0..1),
  `resolvedBy` (→ pr). `blocks` is **derived** (reverse query over
  `blockedBy`), never stored. Refs are **string** qns/paths/ids, consistent
  with the decisions convention.

**State machine** (table-driven, enforced in `TodoService.transition`):

| From | Allowed `to` |
|---|---|
| `open` | `in_progress`, `cancelled` |
| `in_progress` | `blocked`, `done`, `cancelled` |
| `blocked` | `in_progress`, `open`, `cancelled` |
| `done` | — (terminal) |
| `cancelled` | — (terminal) |

`transition(id, to, { reason?, resolvedBy?, blockedBy? })`:
- Rejects invalid transitions with a clear `error` and **no mutation**.
- Side effects: set `started_at` on the first `→ in_progress`; set `closed_at`
  on `→ done|cancelled`; on `→ done` record `resolvedBy` PR links; on
  `→ blocked` record `blockedBy` links + `state_reason`; on `→ cancelled`
  record `state_reason`.

**Simplification vs. the 2026-05 design notes:** `proposed_by` / `assignee` are
TEXT author-style strings (like decisions' `author`), **not** a typed
`AgentRef`. The multiplayer agent-identity model is not needed for the
foundation; revisit when the viewer/multiplayer slices land. Recorded as a
decision (§6).

### 4.2 Consolidated per-type tool surface

Register **one** `server.tool` per primitive. The input shape is a Zod
**discriminated union on `action`** so each action gets precise per-action
validation and clear error messages; the tool *description* lists the actions
and their required fields compactly and points to
[`docs/mcp-tools.md`](../../mcp-tools.md) for full params (matching the existing
"description restates the doc" convention being tightened under P7). All three
tools keep the required absolute `repo_path` contract and the `ok/empty/error`
response envelope.

| Tool | `action` values → existing behavior |
|---|---|
| `decision` | `create`, `update`, `delete`, `get`, `search`, `why` (←`why_was_this_built`, takes `qualified_name`), `candidates` (←`decision_candidates`), `link`, `promote`, `propose`, `supersede`, `reconcile` (←`record_reconciliation`), `pending` (←`pending_reconciliations`) |
| `todo` | `propose`, `get`, `list`, `search`, `update`, `link`, `transition` |
| `pr` | `open`, `touch` (←`add_pr_touch`), `merge`, `get` |

- Action values preserve the old verb so the mapping is mechanical.
- **Collision fix:** `add_pr_touch` already carries an inner
  `action: "added"|"modified"`. Under `pr({action:"touch", …})` that inner
  field is renamed **`change`** to avoid shadowing the dispatch key.
- **Dispatch architecture:** `decision-tools.ts`, `promotion-tools.ts`, and
  `reconciliation-tools.ts` collapse into a single `decision` dispatcher;
  `pr-tools.ts` into a single `pr` dispatcher; a new `todo` dispatcher is added.
  Each dispatcher validates, switches on `action`, and calls the **existing**
  `DecisionService` / `PRService` / new `TodoService` methods. **No service
  logic moves or changes** — this is the property contract tests assert. The
  decision/PR dispatchers preserve their current `EventBus` emission exactly.
- Net top-level primitive tools: **17 → 3**.

### 4.3 Migration & back-compat — clean break

Old tool names are **removed**, not aliased. Same-slice updates:

- **Cortex skills:** `capture-decision`, `search-decisions`, `seed-decisions`,
  `explain-architecture` — rewrite their tool calls to the new
  `decision({action: …})` form.
- **Hooks:** `prefer-cortex.sh` redirect text, `check-index.sh` banner, the
  suggest-capture hook — any literal tool names.
- **Docs:** `CLAUDE.md` (the routing table + decision-capture examples — note
  the heavily-referenced `why_was_this_built` becomes `decision({action:"why"})`),
  `docs/mcp-tools.md` (the per-tool reference becomes per-action), any
  architecture docs naming the tools.
- **CHANGELOG:** a migration note mapping every old name → new
  `tool({action})` form for the external `mesh` consumer (updated in lockstep,
  same owner).

`why_was_this_built` is the highest-traffic rename (it appears throughout
CLAUDE.md and the routing hook); call it out explicitly in the migration note.

### 4.4 Schema & contract parity with decisions

TODO is a first-class primitive: it gets the same four contract layers decisions
have, not just storage + tools.

1. **Domain types** — new `src/todos/types.ts` mirroring
   [`src/decisions/types.ts`](../../../src/decisions/types.ts): a `Todo`
   interface, per-operation input types (`ProposeTodoInput`, `UpdateTodoInput`,
   `TransitionTodoInput`, `LinkTodoInput`), a `TodoWithRefs` (resolved
   `governs` / `blockedBy` / derived `blocks` / `relatedTo` / `spawnsFrom` /
   `resolvedBy`), and a `rowToTodo(row)` mapper. The service/repository speak
   these types, not loose records.
2. **Input validation** — generalize `validateDecisionFields`
   ([decision-input-validation.ts](../../../src/mcp-server/tools/decision-input-validation.ts))
   into `validatePrimitiveFields(input, fields)` — the same stray tool-call/XML
   marker scan (`</invoke>`, `</rationale>`, …) — and call it for both decisions
   (`title`/`description`/`rationale`/`problem`/`resolution`) and todos
   (`summary`/`description`/`state_reason`). A small consolidation win in its own
   right. Every dispatcher runs it before any mutation.
3. **MCP tool contract** — the consolidated Zod discriminated-union shapes +
   `ok/empty/error` envelope (§4.2).
4. **HTTP API contract** — full parity with the decisions HTTP contract:
   - `AdaptedTodoSchema` added to
     [`api-schemas.ts`](../../../src/mcp-server/api-schemas.ts) (the Zod **single
     source of truth**, `version`-stamped via the shared `CONTRACT_VERSION`
     literal), reusing the already-shared card vocabulary (`summary` / `state` /
     `proposedBy` / `proposedAt` / `governs` / `relatedTo` / …) and
     `GovernsRefSchema`.
   - A pure `src/mcp-server/api-todos.ts` adapter (`buildAdaptedTodo` /
     `buildAdaptedTodos`) mirroring
     [`api-decisions.ts`](../../../src/mcp-server/api-decisions.ts) — DB rows +
     links → `AdaptedTodo`, fully unit-testable.
   - A `GET /api/todos` route in `api.ts` mirroring `/api/decisions`.
   - `docs/api/todos.schema.json` **regenerated** via `npm run gen:api-schemas`
     (never hand-edited) and covered by the drift-guard test
     (`tests/api/schema-drift.test.ts`).

   Deferred (later slices): viewer *rendering* of this data, and `EventBus`
   emission for TODO mutations.

## 5. Testing strategy

- **Storage:** `TodosRepository` CRUD + FTS round-trips; `todo_links` insert /
  reverse-`blocks` derivation; mint produces unique `T-` ids + monotonic
  per-repo `seq`; idempotent `openDecisionsDb` (re-open is a no-op, existing
  decisions untouched).
- **State machine:** every allowed transition succeeds and stamps the right
  timestamps/links; every disallowed transition returns `error` and does not
  mutate; terminal states reject all transitions.
- **Tool dispatch:** `todo` action routing + discriminated-union validation
  errors (unknown action, missing per-action field).
- **Contract / byte-parity:** for every migrated `decision` and `pr` action,
  assert the response is identical to the pre-migration tool's output (the
  guard that consolidation changed no behavior — same approach used for the
  shared code-search engine and the HTTP contract).
- **Types/adapter:** `rowToTodo` round-trips; `buildAdaptedTodo` (pure) maps
  rows + links → `AdaptedTodo`, incl. `governs`, `blockedBy`, and derived
  `blocks`.
- **Input validation:** `validatePrimitiveFields` rejects stray markers in TODO
  fields, and the existing decision validation suite still passes unchanged
  after the generalization.
- **HTTP contract:** `GET /api/todos` returns a `version`-stamped
  `AdaptedTodo[]`; `npm run gen:api-schemas` produces `docs/api/todos.schema.json`
  and the drift-guard test passes against it.
- Full existing suite stays green.

## 6. Decisions to capture (during/after implementation)

1. **Per-type consolidated tool surface (17→3, clean break).** The P7
   breaking-prompt-change decision the HANDOFF flagged. Rationale: cohesive
   per-entity boundary; reduced surface + maintenance; discriminated-union
   validation. Alternatives considered: granular-per-design (rejected: sprawl),
   single `primitive(kind, action)` mega-tool (rejected: invalid kind×action
   combos, mushy validation, higher call-error rate), deprecation-window
   back-compat (rejected: defers the win). Governs the three tool dispatchers.
2. **TODO entity storage in the primitives DB.** Same `decisions.db`, reusing
   `id_sequences`/FTS/open machinery. Alternative: separate `todos.db`
   (rejected: duplicates machinery, splits `id_sequences`).
3. **`proposed_by`/`assignee` as TEXT, not `AgentRef`.** Foundation
   simplification; revisit at the multiplayer/viewer slice.
4. **`validatePrimitiveFields` generalization.** The decision marker-scan becomes
   shared primitive input validation across decisions + todos.
5. **`AdaptedTodo` joins the versioned HTTP contract at parity** — schema in the
   Zod SSoT + pure adapter + `/api/todos` route + drift-guarded generated JSON,
   reusing the shared primitive-card vocabulary. Viewer rendering deferred.

## 7. Deferred slices (sequence after this lands)

1. **Viewer** — TODO dots + drawer + marginalia + decision→TODO leader lines.
2. **Hooks** — `PostMergeHook` auto-complete; `PostDecisionHook` `spawnsFrom`.
3. **External bridge** — one-shot mirroring first; bidirectional sync is v1.5.

## 8. Open questions

- **`todos_fts` columns:** `summary` + `description` only, or also index linked
  ref strings? Start with `summary`/`description` (mirrors decisions); revisit
  if search recall is poor.
- **`state_reason` retention:** foundation stores only the *latest* reason. A
  full transition/activity log is deferred (it pairs with the
  discussion/comments model the design notes also defer).
- **`why` under `decision`:** `why_was_this_built` is semantically a
  code→decision query, not a decision mutation. It fits as a `decision` read
  action, but if its call volume justifies it later, it could *also* be exposed
  as a thin top-level convenience. Foundation: fold it in, no alias.

## 9. References

- [`docs/specs/cortex-v0.3/todo-entity.md`](../../specs/cortex-v0.3/todo-entity.md) — full TODO entity design notes (schema, state machine, visual treatment, drawer, full tool list, hooks, external bridge).
- [`HANDOFF.md`](../../../HANDOFF.md) — P7 (reduce token tax) and the agentic-experience line.
- [`docs/superpowers/specs/2026-06-08-short-primitive-ids-design.md`](2026-06-08-short-primitive-ids-design.md) — the `D-`/`T-` id scheme + `id_sequences` reservation.
- [`docs/architecture/decisions-storage.md`](../../architecture/decisions-storage.md) — primitives-store architecture the TODO storage mirrors.

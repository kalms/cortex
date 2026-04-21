# PR Entity & Decision Extensions — Data Model and MCP Surface

**Date:** 2026-04-21
**Status:** Proposed
**Scope label:** Spec A (precedes Spec B — 2D viewer port, Spec C — presence & multiplayer-test, Spec D — reconciliation)

## Problem

Cortex today treats decisions as first-class but pull requests as nothing — git commits exist as events, but there is no PR abstraction the graph can point at, link from, or derive state from. The decision schema captures title/description/rationale/alternatives but lacks the narrative split (problem/resolution) and relationship edges (introducedIn, implementedBy, relatedTo, dependsOn) that the multiplayer engineering design in [docs/cortex-multiplayer-spec.md](../../cortex-multiplayer-spec.md) relies on to make decisions self-contained reading units.

Result: the data model cannot represent what the product framing requires. No downstream surface — viewer drawer, scenario DSL, presence stream — can be built until the entities it reads are real.

## Goal

Extend Cortex's persisted schema so that:

- A **pull request** is a first-class graph entity with typed relationships to code nodes, decisions, and (by label) frames.
- A **decision** carries self-contained narrative (problem, resolution, rationale, alternatives) and typed relationship edges to other decisions and to PRs.
- The **MCP surface** exposes the primitives needed to propose decisions, supersede them atomically, open PRs, record the nodes they touch, and merge them — with merge ratifying introduced decisions from `proposed` to `active`.
- The **event stream** emits new event kinds (`pr.opened`, `pr.touched`, `pr.merged`, `decision.proposed`, `decision.ratified`) so downstream consumers (future viewer, scenario DSL) can drive UI state without polling.

The data model is **source-agnostic**: the same PR shape serves scenario-created, native (Cortex-authored), and future GitHub-mirrored PRs. Only two forward-compat fields (`source`, `external_ref`) anticipate later adapters; everything else is load-bearing today.

This is the substrate for Spec B (viewer port). Spec A ships independently: the MCP server gets more expressive even without any UI change.

## In Scope

- Schema additions:
  - `decisions` table: add nullable `problem TEXT`, `resolution TEXT` columns; leave existing `description` for backwards compat.
  - New tables: `pull_requests`, `pr_touches`, `pr_decision_refs`, `pr_links`, `decision_relations`.
  - New FTS5 triggers covering `problem` + `resolution`.
- New MCP tools: `propose_decision`, `supersede_decision`, `open_pr`, `add_pr_touch`, `merge_pr`, `get_pr`.
- Extended MCP tools: `update_decision` (new fields), `get_decision` (new fields + PR refs + decision relations), `search_decisions` (FTS over new fields).
- New event kinds emitted by the worker: `pr.opened`, `pr.touched`, `pr.merged`, `decision.ratified`; start emitting previously-declared `decision.proposed`.
- Forward-only additive migration; existing decisions readable with new fields as null.
- Test coverage: unit per tool, integration per lifecycle (propose → open_pr → touch → merge → ratify), backwards-compat assertion on existing decisions.

## Out of Scope

- **Reconciliation engine.** No derivation of `stale` / `drift` state. Decision `status` is set manually via `update_decision` / `supersede_decision` / `merge_pr`. Becomes Spec D.
- **Viewer changes.** No modifications to `src/viewer/`, no drawer, no marginalia, no floating PR/decision dots. Spec B handles viewer integration.
- **Presence, multi-agent cursors, WS subscription model.** Spec C.
- **GitHub sync adapter.** No webhook ingestion, no polling worker, no conflict resolution. Schema has room for it (`source`, `external_ref`) but no code.
- **Review / diff / comment surface.** Review will land as its own entity family (reviews, comments, threaded replies) in a later spec when the near-future review work begins. This spec does not add anticipatory columns for review; `comment_count` is a counter only.
- **Declarative (non-code-aligned) decisions** — noted in multiplayer spec §3.3, deferred.
- **Evidence fields** (`validatedBy`, `observedImpact`) — deferred in multiplayer spec §3.1.
- **Frame as persisted entity.** Frames remain derived from path structure. `introduces_frame` is a string label the viewer interprets via the same derivation logic.

## Architecture

### Schema — decisions (additive)

```sql
ALTER TABLE decisions ADD COLUMN problem TEXT;
ALTER TABLE decisions ADD COLUMN resolution TEXT;
```

Existing columns (`title`, `description`, `rationale`, `alternatives`, `tier`, `status`, `superseded_by`, `author`, `created_at`, `updated_at`) are unchanged.

- `problem` — narrative: what question this decision answers.
- `resolution` — narrative: what was decided.
- `description` stays in place as legacy. New writes SHOULD populate `problem` + `resolution`; existing reads see `description` as the combined narrative when `problem` / `resolution` are null. API layer returns both; callers can pick.

Provenance mapping (no schema change):

- Spec's `proposedBy` → existing `author` column.
- Spec's `proposedAt` → existing `created_at` column.

Status enum extends existing values — `proposed` added:

```
status ∈ { proposed, active, superseded, deprecated }
```

(Today's values: `active`, `superseded`, `deprecated`. `proposed` is new and lives in the same column.)

### Schema — pull requests (new)

```sql
CREATE TABLE pull_requests (
  project_id       TEXT NOT NULL,
  number           INTEGER NOT NULL,
  title            TEXT NOT NULL,
  state            TEXT NOT NULL CHECK(state IN ('draft','open','merged','closed')),
  author           TEXT,
  opened_at        TEXT NOT NULL,          -- ISO 8601
  merged_at        TEXT,
  closed_at        TEXT,
  branch           TEXT,
  description      TEXT,
  introduces_frame TEXT,                   -- string label matching derived-frame convention
  additions        INTEGER NOT NULL DEFAULT 0,
  comment_count    INTEGER NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  source           TEXT,                   -- 'native' | 'mirror' | 'scenario'
  external_provider TEXT,                  -- e.g. 'github'
  external_repo    TEXT,
  external_number  INTEGER,
  external_url     TEXT,
  last_synced_at   TEXT,
  PRIMARY KEY (project_id, number)
);

CREATE TABLE pr_touches (
  project_id TEXT NOT NULL,
  pr_number  INTEGER NOT NULL,
  frame_id   TEXT NOT NULL,                -- derived frame label (e.g. 'src/viewer')
  node_name  TEXT NOT NULL,                -- file name within frame (e.g. 'projection.js')
  action     TEXT NOT NULL CHECK(action IN ('added','modified')),
  PRIMARY KEY (project_id, pr_number, frame_id, node_name),
  FOREIGN KEY (project_id, pr_number) REFERENCES pull_requests(project_id, number) ON DELETE CASCADE
);

CREATE TABLE pr_decision_refs (
  project_id  TEXT NOT NULL,
  pr_number   INTEGER NOT NULL,
  decision_id TEXT NOT NULL,
  relation    TEXT NOT NULL CHECK(relation IN ('introduces','implements','challenges','discusses')),
  PRIMARY KEY (project_id, pr_number, decision_id, relation),
  FOREIGN KEY (project_id, pr_number) REFERENCES pull_requests(project_id, number) ON DELETE CASCADE
);

CREATE TABLE pr_links (
  project_id TEXT NOT NULL,
  pr_a       INTEGER NOT NULL,
  pr_b       INTEGER NOT NULL,
  relation   TEXT NOT NULL CHECK(relation IN ('depends_on','related_to')),
  PRIMARY KEY (project_id, pr_a, pr_b, relation)
);
```

**Key choices:**

- PR `number` is **Cortex-allocated**, monotonic per project. Makes scenario-created and native PRs have stable references. Mirror adapter (future) stores external number separately and maps; collision with Cortex's own allocation handled at adapter layer.
- `introduces_frame` is a **string label**, not a FK. Frames stay derived from paths; a PR can introduce a frame that does not yet exist in the derivation (because its files have not been merged). After merge, the files land and the frame surfaces naturally.
- Touches reference nodes by `(frame_id, node_name)` string pair — not by a node FK — so a PR can reference files that do not yet exist (pre-merge). The viewer resolves the string pair to live nodes when it renders.
- `pr_decision_refs.relation` covers all four PR-role categories from the multiplayer spec (§3.1: introducedIn, implementedBy, challengedBy, discussedIn) in a single table with a typed relation column. The API surface exposes them as the spec's four distinct arrays; storage is unified.

### Schema — decision relations (new)

```sql
CREATE TABLE decision_relations (
  project_id    TEXT NOT NULL,
  from_decision TEXT NOT NULL,
  to_decision   TEXT NOT NULL,
  relation      TEXT NOT NULL CHECK(relation IN ('related_to','depends_on')),
  PRIMARY KEY (project_id, from_decision, to_decision, relation)
);
```

Directional. `related_to` is bidirectional in meaning but stored one-sided; API resolves both directions on read.

### FTS5

Existing decisions FTS index adds `problem` and `resolution` columns. New triggers mirror the existing INSERT/UPDATE/DELETE pattern. Reindex job runs once at migration for existing rows (null problem/resolution → empty contribution).

### MCP tools — contract summary

All tools follow the response contract established by Spec "MCP Tool Contract Repair" (2026-04-20): `SuccessResponse | NoResultsResponse | ErrorResponse`, Zod-validated.

**`propose_decision`** — new
- Input: `title`, `problem`, `resolution`, `rationale`, `alternatives[]?`, `governs[]?` (EntityRef), `pr_number?` (if provided, links as `introduces`)
- Effect: creates decision with `status='proposed'`; if `pr_number` given, writes `pr_decision_refs(relation='introduces')`
- Emits: `decision.proposed`
- Returns: decision id

**`update_decision`** — extended
- Existing input extended with `problem?`, `resolution?` (and existing `title?`, `description?`, `rationale?`, `alternatives?`, `status?`, `superseded_by?`)
- Emits: `decision.updated` (existing)

**`supersede_decision`** — new
- Input: `old_decision_id`, plus a full new-decision payload (`title`, `problem`, `resolution`, `rationale`, `alternatives?`, `governs?`)
- Effect: atomic — create new decision with `status='active'`, set old decision `status='superseded'` and `superseded_by=new.id`
- Emits: `decision.created` (for new), `decision.superseded` (for old)
- Returns: new decision id

**`open_pr`** — new
- Input: `number?` (optional; allocated if absent), `title`, `description?`, `author`, `branch?`, `state?` (default `'open'`), `introduces_frame?`, `source?` (default inferred by server — `'native'` for MCP client calls, caller-provided for scenario/mirror)
- Effect: writes `pull_requests` row
- Emits: `pr.opened`
- Returns: `pr_number`

**`add_pr_touch`** — new
- Input: `pr_number`, `frame_id`, `node_name`, `action`
- Effect: upsert into `pr_touches`
- Emits: `pr.touched`
- Returns: ok / noop (if touch already exists)

**`merge_pr`** — new
- Input: `pr_number`
- Effect (single transaction):
  1. Set `pull_requests.state='merged'`, `merged_at=now()`
  2. For each `pr_decision_refs` where `relation='introduces'` and referenced decision has `status='proposed'`: update decision `status='active'`, emit `decision.ratified`
  3. Emit `pr.merged` with payload listing ratified decision ids
- Returns: `{ pr_number, ratified_decisions: [id, ...] }`

**`get_pr`** — new
- Input: `pr_number`
- Returns full PR with resolved touches, decision refs (grouped by relation), and linked PRs.

**`get_decision`** — extended
- Return shape adds: `problem`, `resolution`, `related_decisions[]`, `depends_on[]`, `introduced_in` (PR ref | null), `implemented_by[]`, `challenged_by[]`, `discussed_in[]`.
- Existing fields preserved. Callers that only know old fields continue to work.

**`search_decisions`** — extended
- FTS matches cover `problem` + `resolution` in addition to existing `title` + `description` + `rationale`.
- Return shape matches extended `get_decision`.

**`link_decision`** — extended
- Accepts new relation types: `RELATED_TO`, `DEPENDS_ON` (in addition to existing `GOVERNS`, `REFERENCES`).
- Decision-to-decision relations write to `decision_relations`; code-entity relations preserve existing behavior.

### Events

New kinds in `src/events/types.ts`:

- `pr.opened` — `{ pr_number, title, author, state, source }`
- `pr.touched` — `{ pr_number, frame_id, node_name, action }`
- `pr.merged` — `{ pr_number, ratified_decisions: [id, ...] }`
- `decision.ratified` — `{ decision_id, via_pr_number }`
- `decision.proposed` — already declared, now emitted by `propose_decision`

Mutation derivation in the event worker extends to the new kinds: open/touch/merge produce `pull_request` mutations; ratified produces a `decision` mutation with the new status.

Worker persistence uses the same events.db pattern — no schema change to the event log itself; new kinds are additive to the enum.

### Source-agnostic adapter shape (forward-compat only, not built)

The scenario runner (Spec C), a future GitHub webhook worker, and any "open a PR from inside Cortex" surface all reduce to the same three calls:

```
open_pr → add_pr_touch (×N) → merge_pr
```

`source` distinguishes origin for auditing and for suppressing re-emission when a mirror adapter replays external events. No conditional code paths in the MCP tools — the tools are agnostic. The adapter layer (not in this spec) handles provenance.

## Migration

Single forward-only migration script, registered in the existing migration runner:

1. `ALTER TABLE decisions ADD COLUMN problem TEXT`
2. `ALTER TABLE decisions ADD COLUMN resolution TEXT`
3. Create `pull_requests`, `pr_touches`, `pr_decision_refs`, `pr_links`, `decision_relations` tables + indexes
4. Drop + recreate decisions FTS5 virtual table with `problem` and `resolution` added; repopulate from base table
5. Re-register FTS triggers

**Idempotency:** migration checks for column existence before ALTER; re-running is a noop. Matches existing migration conventions.

**Rollback:** not supported (additive migrations, no down script). Existing migration system does not support rollback; this spec does not change that.

**Backwards compat assertion:** existing decisions remain readable via `get_decision` with `problem = null`, `resolution = null`. No data loss, no behavior change for decisions that existed before migration.

## Testing Strategy

**Unit (Vitest):**

- Schema migration: apply on an empty DB, apply on a populated DB with existing decisions, re-apply (idempotency check).
- Each new MCP tool: happy path + each validation error + edge case (e.g. `merge_pr` on an already-merged PR; `add_pr_touch` with nonexistent `pr_number`).
- `propose_decision` without `pr_number` creates a decision with no `pr_decision_refs` row.
- `supersede_decision` atomicity: if decision creation fails mid-way, old decision status is unchanged.

**Integration (MCP contract harness from Spec 2026-04-20):**

- Full lifecycle: `propose_decision` → `open_pr` → `add_pr_touch` (×3) → `merge_pr` → assert decision `status='active'`, assert `decision.ratified` event emitted with correct payload.
- `supersede_decision` flow: old decision reads as superseded, new decision reads as active, `superseded_by` chain resolves.
- Backwards compat: pre-migration decisions (fixture with only `title` + `description` + `rationale`) read correctly via extended `get_decision` with nulls in new fields.
- Event emission: every new tool emits the right kind with the right payload; WS broadcast reaches a test client.

**Fixture:**

- Extend `tests/fixtures/sample-project/` with a seed of 2–3 decisions (one proposed, one active, one superseded chain) and 1–2 PRs, to exercise `get_pr` and the extended `get_decision`.

## Open Questions

1. **Author mutability.** `update_decision` currently allows any field change. Should `author` be immutable after creation (preserving original proposer identity)? **Proposed default:** immutable. `updated_at` tracks last mutation; an optional `last_updated_by` column could be added later if audit becomes a requirement. Not in scope here.
2. **PR number collision across mirror + native.** If a GitHub adapter lands later with external numbers matching Cortex-allocated numbers, the adapter must namespace (e.g. mirror PRs allocate from a reserved high range or use `external_number` as primary display and allocate internal numbers starting from 10000). **Deferred:** adapter's problem; schema already separates internal from external.
3. **Frame label stability under rename.** If a directory renames, existing `pr_touches.frame_id` values orphan. **Accepted for v1:** the scenario runner and any native PR creation happens in a short time window; real mirror adapters will need resolution logic. Flagged for Spec C / future GitHub adapter.
4. **Empty-alternatives canonical form.** Existing `decisions.alternatives` uses JSON; new tools preserve that. `propose_decision` with no alternatives stores `[]`, not null.

## Follow-on work (not this spec)

- **Spec B — 2D viewer port.** Reads the new schema, renders drawer + marginalia + floating PR/decision dots + merge animation.
- **Spec C — Presence & multiplayer-test.** Scenario DSL composes the new MCP tools; presence layer adds T1+T2 event capture (MCP tool calls + CC plugin hooks).
- **Spec D — Reconciliation engine.** Derives `status='stale'` from governed-code drift; requires no schema change beyond what this spec ships (string-match against governed files' content hashes).
- **Review / diff surface.** Separate entity family (reviews, comments, threaded replies) on top of the PR entity. No schema change to this spec's tables.
- **GitHub mirror adapter.** Composes `open_pr` / `add_pr_touch` / `merge_pr` on webhook events. Populates `source='mirror'` + `external_*`.

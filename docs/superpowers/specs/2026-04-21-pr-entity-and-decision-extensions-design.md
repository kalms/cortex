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

- Schema additions (graph-native, no new tables):
  - Decision `data` JSON: add nullable `problem`, `resolution` fields; leave existing `description` for backwards compat.
  - Decision `status` JSON field: accept new value `'proposed'` alongside existing `active | superseded | deprecated`.
  - New `nodes.kind` value: `'pull_request'`, with PR fields (number, state, touches[], source, external_ref, …) inside `data`.
  - New `edges.relation` values: `PR_INTRODUCES_DECISION`, `PR_IMPLEMENTS_DECISION`, `PR_CHALLENGES_DECISION`, `PR_DISCUSSES_DECISION`, `PR_LINK_DEPENDS_ON`, `PR_LINK_RELATED_TO`, `DECISION_RELATED_TO`, `DECISION_DEPENDS_ON`.
  - FTS5 `decisions_fts` virtual table: drop and recreate with added `problem` + `resolution` columns; repopulate from existing decision nodes.
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

### Storage model — graph-native (no new tables)

Cortex persists decisions and all typed relationships through a generic graph schema (`src/graph/schema.ts`): the `nodes` table (discriminated by `kind`, with a JSON `data` column for kind-specific fields) and the `edges` table (discriminated by `relation`, with a JSON `data` column). Decisions today are `nodes` rows with `kind='decision'`; supersedes links, governance, and references are all rows in `edges`. This spec introduces no new tables — only new `kind` / `relation` values and new fields inside the existing JSON `data` columns.

#### Decision `data` JSON — new fields (additive)

```jsonc
{
  "problem":    "TEXT or null",   // new — narrative: what question this decision answers
  "resolution": "TEXT or null",   // new — narrative: what was decided
  // existing fields unchanged: rationale, alternatives, author, status, superseded_by
}
```

`title` / `description` remain in the `nodes` row (`name` column holds title; `description` lives in `data`). `description` is legacy — new writes SHOULD populate `problem` + `resolution`. Existing reads see `description` as the combined narrative when `problem` / `resolution` are null. API returns all three; callers can pick.

Provenance mapping (no change):

- Spec's `proposedBy` → existing `author` field in decision `data`.
- Spec's `proposedAt` → existing `created_at` column on `nodes`.

Status enum extends: `status ∈ { proposed, active, superseded, deprecated }` (today's values: `active`, `superseded`, `deprecated`; `proposed` is new and lives in the same JSON field).

#### PR as a node — `kind='pull_request'`

```jsonc
{
  "number":           123,                          // int, monotonic; allocated by open_pr
  "title":            "...",                         // also stored as nodes.name
  "state":            "draft|open|merged|closed",
  "author":           "...",
  "opened_at":        "ISO 8601",
  "merged_at":        "ISO 8601 or null",
  "closed_at":        "ISO 8601 or null",
  "branch":           "... or null",
  "description":      "... or null",
  "introduces_frame": "frame label or null",         // string matching derived-frame convention
  "additions":        0,
  "comment_count":    0,
  "last_activity_at": "ISO 8601 or null",
  "source":           "native|mirror|scenario",      // forward-compat
  "external_ref":     { "provider": "...", "repo": "...", "number": 456, "url": "..." } or null,
  "last_synced_at":   "ISO 8601 or null",
  "touches":          [                              // inline — see note below
    { "frame_id": "src/temporal", "node_name": "timeline.ts", "action": "added" },
    { "frame_id": "src/events",   "node_name": "emitter.ts",  "action": "modified" }
  ]
}
```

PR node `id` is a UUID (matching decisions). PR `number` is a display identifier inside `data`.

**Number allocation:** `open_pr` computes
```sql
SELECT COALESCE(MAX(CAST(json_extract(data, '$.number') AS INTEGER)), 0) + 1
FROM nodes
WHERE kind = 'pull_request';
```
Monotonic across the whole Cortex instance. Sufficient for v1 (one Cortex instance per user, scenarios are short-lived). A future GitHub adapter handles external-vs-internal numbering at its own layer.

**Touches stored inline on the PR node** rather than as `edges` rows. Rationale: `edges.target_id` is `NOT NULL REFERENCES nodes(id)`, so edges cannot point at nodes that do not yet exist — and PR `touches` with `action='added'` reference files that will not exist until merge. The inline array sidesteps placeholder-node complexity. Viewer resolves `(frame_id, node_name)` pairs to live nodes at render time (same resolution logic either way). Trade-off: "which PRs touch node X?" is answered by iterating active PRs, not by edge traversal. Acceptable for expected v1 scale.

#### New edge relations

| `relation` | source kind | target kind | `data` |
|---|---|---|---|
| `PR_INTRODUCES_DECISION`  | pull_request | decision     | `{}` |
| `PR_IMPLEMENTS_DECISION`  | pull_request | decision     | `{}` |
| `PR_CHALLENGES_DECISION`  | pull_request | decision     | `{}` |
| `PR_DISCUSSES_DECISION`   | pull_request | decision     | `{}` |
| `PR_LINK_DEPENDS_ON`      | pull_request | pull_request | `{}` |
| `PR_LINK_RELATED_TO`      | pull_request | pull_request | `{}` |
| `DECISION_RELATED_TO`     | decision     | decision     | `{}` |
| `DECISION_DEPENDS_ON`     | decision     | decision     | `{}` |

Existing relations (`GOVERNS`, `REFERENCES`, `SUPERSEDES`) are unchanged. `PR_*_DECISION` edges cover the four PR-role categories from the multiplayer spec (§3.1: introducedIn, implementedBy, challengedBy, discussedIn) as distinct relation values; the API surface exposes them as four arrays on `get_decision` and as relation-grouped arrays on `get_pr`. Decision-side `relatedTo` and `dependsOn` are directional edges; `get_decision` resolves both incoming and outgoing to build the display array.

#### FTS5

Existing:
```sql
CREATE VIRTUAL TABLE decisions_fts USING fts5(
  title, description, rationale, node_id UNINDEXED
);
```

New: drop and recreate with added columns, then repopulate from the base table:
```sql
DROP TABLE IF EXISTS decisions_fts;
CREATE VIRTUAL TABLE decisions_fts USING fts5(
  title, description, rationale, problem, resolution, node_id UNINDEXED
);
-- repopulate by iterating existing decision nodes and re-running indexDecisionContent()
```

SQLite FTS5 does not support `ALTER ADD COLUMN`; drop + recreate + repopulate is the standard pattern. Existing content is reindexed with empty `problem` / `resolution` contributions until mutations write values.

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

Cortex has no explicit migration runner — schema is defined in `src/graph/schema.ts` and applied at `GraphStore` constructor via `migrate()` (which runs `CREATE_TABLES` + `CREATE_INDEXES` + `CREATE_FTS`). This spec adds no new tables; the only physical schema change is the FTS5 virtual table definition.

Steps at `GraphStore` startup:

1. **FTS5 recreation (first startup after upgrade only):** detect whether `decisions_fts` has the old column set; if so, `DROP TABLE decisions_fts` and recreate via the new `CREATE_FTS` constant. Then iterate existing `nodes WHERE kind='decision'` and call `indexDecisionContent()` for each to repopulate. Detection query: `PRAGMA table_info(decisions_fts)` — if `problem` column is absent, recreate.
2. **No `nodes` / `edges` schema changes** — new `kind` and `relation` values are just new string literals; the existing tables accept them.
3. **JSON data shape** is not enforced at the DB layer; service-layer code writes the new fields, and readers treat absent fields as null.

**Idempotency:** after the one-shot FTS recreate, `CREATE_FTS` uses `IF NOT EXISTS` — subsequent startups are noops. Matches the existing `IF NOT EXISTS` convention on all CREATE statements.

**Rollback:** not supported (the existing schema system does not support rollback; this spec does not change that). The FTS recreate is non-destructive — repopulation reads from the base `nodes` table, so data cannot be lost by this migration.

**Backwards compat assertion:** existing decisions (written before upgrade) remain readable via `get_decision` with `problem = null` and `resolution = null`. Existing `search_decisions` queries keep matching as before; FTS hits on the new columns are additive. No data loss, no behavior change for decisions that existed before migration.

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
3. **Frame label stability under rename.** If a directory renames, existing `(frame_id, node_name)` entries in a PR node's inline `data.touches` array orphan. **Accepted for v1:** the scenario runner and any native PR creation happens in a short time window; real mirror adapters will need resolution logic. Flagged for Spec C / future GitHub adapter.
4. **Empty-alternatives canonical form.** Existing `decisions.alternatives` uses JSON; new tools preserve that. `propose_decision` with no alternatives stores `[]`, not null.

## Follow-on work (not this spec)

- **Spec B — 2D viewer port.** Reads the new schema, renders drawer + marginalia + floating PR/decision dots + merge animation.
- **Spec C — Presence & multiplayer-test.** Scenario DSL composes the new MCP tools; presence layer adds T1+T2 event capture (MCP tool calls + CC plugin hooks).
- **Spec D — Reconciliation engine.** Derives `status='stale'` from governed-code drift; requires no schema change beyond what this spec ships (string-match against governed files' content hashes).
- **Review / diff surface.** Separate entity family (reviews, comments, threaded replies) on top of the PR entity. No schema change to this spec's tables.
- **GitHub mirror adapter.** Composes `open_pr` / `add_pr_touch` / `merge_pr` on webhook events. Populates `source='mirror'` + `external_*`.

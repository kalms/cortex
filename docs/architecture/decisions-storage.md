# Decisions Storage Architecture

> One-pager. Audience: anyone touching `src/decisions/`, `src/mcp-server/tools/decision-tools.ts`, `src/db/cache.ts`, or thinking about graph-DB lifecycle.

## Why a sidecar DB

Cortex's canonical graph DB (`.cortex/db` — see
[graph-storage.md](graph-storage.md)) is a **fully replaceable derived
artifact**. It can be rebuilt from source code via `index_repository`. The
indexer's cache layer treats it as such: on cache hit, `readCacheEntry`
overwrites the file in place; on cache miss with a "mode change reindex",
the pipeline `ctx_unlink`s the file before rebuilding.

User-authored decisions don't share that lifecycle. They're explicitly
created via the `create_decision` / `propose_decision` MCP tools and have
no source-of-truth other than the row in the DB. Storing them in the same
file as the derived graph guarantees data loss every time the indexer
runs. This is the Gap 10 bug.

The fix is structural: a sidecar SQLite file, separate from the derived
graph DB. It is **never** touched by cache imports, re-indexes, or any
other graph-rebuild path. The two DBs are coupled only at query time and
only by stable string keys (qualified names, file paths, PR numbers) —
never by graph node IDs, which the indexer regenerates per run.

> **Update — durable-store relocation (2026-06-08).** The sidecar originally
> lived in-repo at `<repo>/.cortex/decisions.db`. It has since been relocated
> **out of the repo** to `~/.cortex/<repoId>/decisions.db`, resolved by
> `resolveDecisionsDbPath` (`src/db/resolve-path.ts`) from the `repoId` in the
> repo's committed `cortex.json`. So every worktree/clone of a repo shares one
> decisions store, and it can't be lost to a `git clean` of `.cortex/`.
> `$CORTEX_DECISIONS_DB` overrides the path; `$CORTEX_HOME` relocates the base.
> The in-repo `.cortex/decisions.db` is now only (a) the not-a-git-repo fallback
> and (b) a one-time legacy migration source, read once. The sidecar-vs-graph
> separation argument here is unchanged by the move — only the path changed. See
> [graph-storage.md](graph-storage.md) for the full resolution chain.

## Schema

```sql
-- decisions: the rows users author
CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,         -- UUID
  title         TEXT NOT NULL,
  description   TEXT,
  rationale     TEXT,
  problem       TEXT,                     -- optional narrative
  resolution    TEXT,                     -- optional narrative
  alternatives  TEXT,                     -- JSON array as text
  tier          TEXT NOT NULL DEFAULT 'personal',
  status        TEXT NOT NULL DEFAULT 'active', -- active | proposed | superseded | deprecated
  superseded_by TEXT,                     -- decision id, NULL if not superseded
  author        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- decision_links: typed edges. Targets keyed by stable string, not graph node id.
CREATE TABLE decision_links (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,              -- 'qn' | 'path' | 'decision' | 'pr'
  target_ref  TEXT NOT NULL,              -- qualified name | path | decision id | PR number
  relation    TEXT NOT NULL,              -- GOVERNS|REFERENCES|SUPERSEDES|...
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_decision_links_decision ON decision_links(decision_id);
CREATE INDEX idx_decision_links_target   ON decision_links(target_kind, target_ref);

-- FTS5 over decision content
CREATE VIRTUAL TABLE decisions_fts USING fts5(
  title, description, rationale, problem, resolution,
  content='decisions', content_rowid='rowid'
);

-- Schema metadata (currently: migrated_from_graph_db = "true"|absent)
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

The schema is set up idempotently via `IF NOT EXISTS` on every
`openDecisionsDb(path)` call. WAL mode + `foreign_keys = ON` are pragma'd
on every open.

## `target_kind` taxonomy

| kind       | target_ref                              | example                                |
|------------|-----------------------------------------|----------------------------------------|
| `qn`       | qualified name (with `::` member)       | `src/foo.ts::processBatch`             |
| `path`     | file or directory path                  | `src/payments` or `src/payments/api.ts` |
| `decision` | another decision's `id`                 | UUID                                   |
| `pr`       | PR number as string                     | `"42"`                                 |

The kind is chosen by `classifyTarget(target)` (in `service.ts`):
"path" if the string contains `/`, else "qn". Callers can also set it
explicitly when they know the kind (e.g. PR linking always uses `"pr"`).

## Migration

`migrateDecisionsFromGraphDb(decDb, graphDbPath)` runs once per repo, both
at MCP server startup AND defensively at the top of `index_repository`.
It:
1. Checks `schema_meta.migrated_from_graph_db`. If `"true"`, returns
   `{ decisions: 0, links: 0 }` immediately. Idempotent.
2. If the graph DB doesn't exist, marks migrated and returns. Idempotent.
3. Reads `nodes WHERE kind = 'decision'` from the (read-only) graph DB,
   parses the JSON `data` blob, writes a `DecisionRecord` to the sidecar
   via `DecisionsRepository`.
4. For each outgoing edge, resolves `target_kind` by inspecting the
   target node's `kind` column (path → "path", decision → "decision",
   other → "qn") and `target_ref` (file_path, qualified_name, decision id,
   or PR number from PR-node data). Inserts via `DecisionLinksRepository`.
5. Wraps everything (including the `markMigrated` write) in a single
   `decDb.transaction()` so partial failure leaves no half-state.

## Governance resolution (`why_was_this_built`)

`DecisionSearch.findGoverning(target)` (in `search.ts`) walks four
fallback steps:

1. Exact qn match — `links.findByTarget("qn", target, "GOVERNS")`
2. Exact path match — `links.findByTarget("path", target, "GOVERNS")`
3. Strip trailing `::member` from a qn, try the file portion as a path
4. Walk up directories via `dirname` until a hit, until `.`, or until no
   progress

This is what makes the qn/path-string design work: graph node IDs would
turn this into a fragile cross-DB resolution, but a string walk is
straightforward and resilient to indexer-regenerated IDs.

## What graph.db NO LONGER holds

- No `decisions_fts` virtual table (was dropped in Task 11 of the
  2026-05-14 sidecar plan)
- No `kind='decision'` node rows (legacy rows are read once by migration
  and never again)
- No GOVERNS / REFERENCES / SUPERSEDES / PR_*_DECISION edges from
  decisions

`GraphStore.indexDecisionContent`, `updateDecisionContent`, and
`removeDecisionContent` are gone. The `search` method on `GraphStore`
no longer joins against `decisions_fts`.

## Cache lifecycle is safe

`src/db/cache.ts` operates only on the graph DB path. It does not know
about the decisions sidecar and never will. The cache key
(`computeCacheKey`) hashes the indexer version + grammar pack + git tree
hash — none of which change when a user adds a decision, so cache hits
remain valid AND decisions are unaffected by the import.

The regression is pinned by `tests/decisions/cache-survival.test.ts`:
create a decision, overwrite the graph DB with garbage bytes
(simulating any cache-import or pipeline-reindex), re-open the decisions
sidecar, confirm the decision is still there.

## Cold-start seeding (machine-proposed decisions)

A freshly-indexed repo has no decisions, which makes `why_was_this_built`
inert on day one. The cold-start seeding flow bootstraps the durable store
from existing repo state without compromising its trust contract:

1. **Detection** — `hooks/check-index.sh` probes `cortex decision count` and,
   when zero, emits a one-time prompt inviting the agent to run the
   `seed-decisions` skill.
2. **Candidate framing** — The `decision_candidates` MCP tool (read-only)
   walks `docs/` for ADR-shaped files, clusters recent conventional commits
   by scope, and returns a compact manifest with **machine-derived
   provenance** (commit SHAs / doc paths). The skill never reads raw `git log`
   itself; the manifest is the trust anchor.
3. **Authoring** — The skill calls `propose_decision` with `author:
   "cortex:seed"` and a `provenance` payload carrying the source SHAs/doc
   path + confidence tier (`high` for ADRs, `medium` for prose, `low` for
   commit clusters).
4. **Ratification** — The user reviews the proposed batch; approved entries
   become `active` via `update_decision`, the rest are deleted.

### Provenance column

Seeded decisions carry their source on a nullable `provenance TEXT` column
holding a JSON `ProvenanceMeta` (`{ source, doc_path?, commit_shas?,
confidence }`). The column is added via an idempotent `ALTER TABLE ADD
COLUMN provenance TEXT` guarded by a `PRAGMA table_info(decisions)` probe in
`openDecisionsDb`, so pre-existing DBs upgrade in place without an FTS
rebuild. The column is intentionally NOT indexed by `decisions_fts` —
provenance is reviewer-verifiable metadata, not searchable prose.

`DecisionUpdate` excludes `provenance` so the field is write-once: machine-
derived provenance cannot be silently overwritten by a later update.

### Conventions

- Machine-seeded decisions carry `author: "cortex:seed"`. This makes them
  identifiable in audit + review without parsing the provenance blob.
- The candidate-framing module lives in `src/decisions/seed/` (doc discovery
  + commit clustering + manifest aggregator). It is pure aside from
  filesystem + `git` I/O; the same logic backs both the MCP tool and the
  `cortex decision candidates` CLI command (the CLI is the human/debug path).

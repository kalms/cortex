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
created via the `decision` MCP tool (`action:"create"` / `action:"propose"`) and have
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
  id            TEXT PRIMARY KEY,         -- canonical id, D-<token> (see ID scheme)
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

### ID scheme

IDs are `D-<token>` (decisions) and `T-<token>` (TODOs), **not** UUIDs. Each
row carries two identifiers, minted at a shared `src/ids/` chokepoint:

- **canonical** — the PK. `<prefix>-<token>` where `token` is a 4-char
  lowercase Crockford base32 string that **always contains ≥1 letter**. Random,
  durable, and cross-repo: it survives `decision rehome` unchanged.
- **`seq`** — a per-repo monotonic integer, rendered `D-12` for display. It is
  presentation-only and **reassigned** on rehome.

Two ids on purpose: a seq-based PK would collide with the destination repo's own
`D-12` when a decision is rehomed, so the durable handle must be the random
canonical. Tools accept **either** form — an all-digit token resolves as `seq`,
otherwise as canonical — unambiguous precisely because canonical tokens always
carry a letter. PRs are the exception: they stay keyed on the real GitHub PR
number (no canonical, no seq).

### Ref resolution — resolve before use

The repositories are **canonical-only**: `DecisionsRepository.get`,
`DecisionLinksRepository.findByDecision`, and `recordReconciliation` all key on
the PK. Any code holding a caller-supplied ref must resolve it through the
service layer first — `DecisionService.getWithRefs()` / `resolveId()`,
`TodoService.getWithRefs()` — and key every subsequent repository and links call
on the resolved canonical id.

Passing a raw ref to `findByDecision` does **not** throw. It returns an empty
result, which surfaces as a decision with no governs, no references, and no
reconciliation state — a silent, plausible-looking wrong answer. That was a real
bug in `get_decision`, `record_reconciliation`, `changes_since`, and the
`/api/decisions/:id` route; `tests/mcp-server/decision-ref-parity.test.ts` now
pins the invariant by asserting byte-identical output for both ref forms.

The write path was already correct: `linkGoverns` / `linkRelatedTo` /
`linkDependsOn` resolve both owner and target before inserting, so
`decision_links` never stores a seq-form ref.

### Reconciliation

Reconciliation splits into two orthogonal axes:

- **`status`** (stored) — human intent: `active` / `proposed` / `superseded` /
  `deprecated`.
- **`reconciliation`** (derived) — a verdict of `match` / `partial` / `drift` /
  `unknown` computed against the current source.

`"stale"` is never stored — it is projected by `displayState`: an `active`
decision whose verdict is `drift` renders as "stale". The invalidation trigger
is a `governed_source_hash` computed over the **working tree**, not HEAD (reusing
the indexer's `grammarPackHash`, at file-level granularity). That working-tree
basis is the defining property: it surfaces in-session, pre-commit drift and
decouples the verdict from index freshness — a HEAD-based hash would hide drift
until the next commit. Judgment is **agent-delegated** (no server-side LLM);
recording a verdict recomputes the hash server-side so the verdict binds to the
source the server actually sees. Zero-`GOVERNS` decisions are declarative and
never reconcilable. The whole flow is gated by `CORTEX_RECONCILE`.

## `target_kind` taxonomy

| kind       | target_ref                              | example                                |
|------------|-----------------------------------------|----------------------------------------|
| `qn`       | qualified name (with `::` member)       | `src/foo.ts::processBatch`             |
| `path`     | file or directory path                  | `src/payments` or `src/payments/api.ts` |
| `decision` | another decision's `id`                 | `D-4h2k`                               |
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

## Governance resolution (`decision({action:"why"})`)

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

## Storage garbage collection: empty dirs and archived orphans

`resolveDecisionsDbPath` (`src/db/resolve-path.ts`) creates `~/.cortex/<repoId>/`
and opens `decisions.db` in it (via `ensureRepoId` + `openDecisionsDb`) on the
**first touch of the repo**, not on the first authored decision — any
`decision`/`todo` read, an MCP `RepoContext` construction, or eval/corpus
indexing of a throwaway clone all mint the dir and its (empty) schema. Before
this GC layer, that dir lived forever: migration (above) is deliberately
non-destructive, so nothing ever swept it, and eval/corpus runs in particular
minted one `repoId` dir per ephemeral clone with zero decisions in it. That's
the leak this closes:

- **Empty dirs are reaped, not archived.** `isEmptyDecisionDir(repoIdDir)`
  (`src/db/store-gc.ts`) opens the dir's `decisions.db` read-only and checks
  `COUNT(*) FROM decisions`. Any open/query failure counts as **not** empty —
  an uninspectable store is never treated as safe to remove. `cortex doctor
  --fix` (via `auditStores`/`fixStores` in `src/db/store-gc-audit.ts`)
  `rmSync`s these dirs outright: zero decisions means zero user data, so
  there's nothing to preserve.
- **Content-bearing orphans are archived, never deleted.** A dir with ≥1
  decision row whose `repoId` is no longer in the registry's live set (the
  repo was renamed, moved, or deleted, and never re-indexed under that id) is
  a genuine "what do I do with this" case — the decisions are real,
  user-authored data, but there's no live repo left to attribute them to.
  `archiveDecisionDir(repoId)` moves (never deletes) the whole dir to
  `~/.cortex/_archive/<repoId>/` (`archiveRoot()` in `src/db/store-paths.ts`),
  de-duplicating with a `-1`/`-2`/… suffix if the destination already exists.
  The data stays on disk, inspectable, and restorable — just out of the path
  `auditStores` scans on the next run.
- **Eval/corpus isolation stops the leak at the source.** Rather than relying
  solely on cleanup after the fact, `evals/src/target.ts` now indexes corpus
  targets under a scratch `CTX_CACHE_DIR`/`CORTEX_HOME` (`evalIndexerEnv` in
  `src/cli/commands/eval.ts`), so ephemeral eval clones never mint a
  `repoId` dir under the real `~/.cortex` in the first place. The
  `cortex doctor` audit remains the backstop for anything that still slips
  through (a manually-cloned throwaway repo, an interrupted run, etc.).

See [graph-storage.md](graph-storage.md#garbage-collection) for the sibling
GC passes over the graph-side stores (slug caches, staging files) — this
section covers only the decisions-sidecar side of the same `CORTEX_GC`-gated
system.

### TODO entity

TODOs are the third user-authored primitive (after decisions and PRs), and they
live in the **same** primitives DB (`~/.cortex/<repoId>/decisions.db`) — not a
separate `todos.db`. Sharing the file lets TODOs reuse the existing machinery:
the shared `id_sequences` mint (`T-` prefix + per-repo `seq`), FTS-via-triggers,
and the links pattern (string qn/path refs, **never** graph node ids). A
separate DB would duplicate all of that and split `id_sequences` across two
files. Links carry a TODO-specific relation set — `governs` / `blockedBy` /
`relatedTo` / `spawnsFrom` / `resolvedBy` (`blocks` is derived, never stored).
State is a **service-enforced** machine — `open → in_progress → blocked →
done`/`cancelled`, with `done`/`cancelled` terminal — never a direct column
mutation. (The 17→3 action-dispatched MCP tool consolidation that introduced the
`todo` tool is documented in [../mcp-tools.md](../mcp-tools.md).)

### Schema migrations

The primitives DB uses a **forward-only, name-keyed** migration runner
(`runMigrations` in `src/db/migrate.ts`) — **not** `PRAGMA user_version`.
Applied migrations are recorded by name in a ledger table
`_cortex_migrations(migration_set, name, applied_at)`; name-keying (rather than a
monotonic integer) is safe across parallel branches and gap-fills cleanly when
branches merge out of order. It is **baseline-at-current**: today's declarative
`ensureX`/FTS schema is the baseline, and the runner records/runs only named
data + forward migrations layered on top.

Migrations run at a **single chokepoint** — `openDecisionsDb` — so every opener
(the CLI `openService`, the MCP repo-context, and tests) converges by
construction. (This chokepoint fixed a real bug where the CLI opened the store
but skipped data migrations.) A **too-new guard** hard-refuses (exit 4) a store
carrying migration names this binary doesn't recognize. Before a batch runs, a
pre-migration file snapshot (`db.backup` / `VACUUM INTO`, last 3 retained) makes
the batch **all-or-nothing at file granularity** — covering the "migration N+1
fails after N already committed" gap that per-step transactions cannot.

Scope is the primitives DB **only**. The graph and events DBs are regenerable, so
`CREATE TABLE IF NOT EXISTS` suffices for them. `migrateDecisionsFromGraphDb`
stays **outside** this chokepoint because it needs the graph-DB path, and it
deliberately runs from **two call sites** (idempotent at both):
`repo-context.ts` (per-repo context construction — the normal path) and
defensively at the top of the `index_repository` handler in `code-tools.ts`
(so a fresh index on a repo with a legacy graph-DB store imports before any
write). The viewer HTTP layer gets it transitively via repo-context, not a
call of its own.

## Cold-start seeding (machine-proposed decisions)

A freshly-indexed repo has no decisions, which makes `decision({action:"why"})`
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
3. **Authoring** — The skill calls `decision({action:"propose"})` with `author:
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

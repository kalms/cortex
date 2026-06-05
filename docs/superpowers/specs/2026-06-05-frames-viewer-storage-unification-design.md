# Frames / Viewer Storage Unification — Design

**Date:** 2026-06-05
**Status:** Approved (design)
**Branch:** `refactor/frames/viewer-store-resolution`
**Supersedes the storage half of:** the Priority-2 section of `HANDOFF.md` (2026-06-05)

## Problem

Three writers disagree on where a project's graph lives, and readers disagree
with writers:

- **MCP `index_repository`** writes `<repo>/.cortex/db`.
- **CLI `cortex index`** writes the shared cache `~/.cache/cortex-indexer/<slug>.db`
  (and leaves an un-checkpointed WAL).
- The viewer's `openProjectStore` (`src/graph/code-queries.ts`) reads the
  **cache** for any non-active project.
- The MCP read path (`resolveGraphDbForRead`, `src/db/resolve-path.ts`) prefers
  **`.cortex/db`**.

Consequence: "reindex via MCP, then view" shows stale cache labels, because the
reindex lands in `.cortex/db` while the viewer reads the cache. This is the
mechanism behind the temp `cp .cortex/db → cache` hack used this session. The
divergence must be removed before the frames pipeline can be relied on for
Mesh.

A second, structural coupling makes this worse: **the cache directory doubles
as the master registry.** `RepoContextResolver.listKnownRepos` and
`listProjectsUnified` enumerate repos by scanning `~/.cache/cortex-indexer/`
and reading each `<slug>.db`'s `ctx_projects.root_path` (the slug filename is
lossy — flattened slashes — so the row is needed to recover the real path).
Any plan that retires the cache as a graph store must first give enumeration a
new home.

## Goal

One canonical graph store per repo, with reads and writes that can never
diverge again, and project enumeration decoupled from graph storage.

Non-goals: branch-keyed graph caching (see Future extensions — seam preserved,
not built); deleting existing cache `.db` files (left in place, unused).

## Design

### 1. Canonical graph store

`<repo>/.cortex/db` is authoritative for graph data, always. The
`~/.cache/cortex-indexer/<slug>.db` graph files are retired as a *graph* store
(they remain readable only as a migration source and as a last-resort read
fallback for un-migrated repos).

`.cortex/decisions.db` (durable) and `.cortex/db` (derived graph) already
co-locate per repo; this makes that the consistent convention.

### 2. Registry component — `src/db/registry.ts`

A small SQLite store, separate from any graph DB, that is the *only* answer to
"what repos exist and where."

- **Location:** `~/.cache/cortex-indexer/_registry.db` (the `_`-prefix already
  excluded by existing cache scanners, so it is never mistaken for a project
  `.db`).
- **Schema:** `repos(name TEXT PRIMARY KEY, root_path TEXT UNIQUE NOT NULL,
  indexed_at TEXT NOT NULL)`.
- **API:**
  - `register(name, root_path)` — idempotent upsert
    (`INSERT … ON CONFLICT(name) DO UPDATE …`), atomic under SQLite's writer
    lock. `busy_timeout` set so a concurrent MCP+CLI registration serialises
    rather than races (no lost-update / torn-write window that a JSON file
    would have).
  - `list(): RegistryRepo[]` — all known repos.
  - `remove(name)` — used by `delete_project`.
- **`.tmp/` guard:** `register` rejects any `root_path` containing a `.tmp/`
  path segment, so eval-corpus clones under `cortex/.tmp/frame-extraction-corpus/*`
  can never re-pollute enumeration (folds in a standing loose end).

SQLite chosen over a JSON file because `better-sqlite3` is already a core
dependency, `.cortex/db` + `decisions.db` are already SQLite (consistent
pattern, zero new deps), and it removes the cross-process lost-update and
crash-torn-write failure modes for free.

### 3. Write path

Both `index_repository` (`src/mcp-server/tools/code-tools.ts`) and CLI
`cortex index` (`src/cli/commands/index.ts`):

1. Resolve the graph DB path via `resolveCortexDbPath(repoPath)` →
   `<repo>/.cortex/db` (the CLI changes from cache to this).
2. Index + run frame extraction into that DB (unchanged orchestration).
3. **Checkpoint the WAL** after frame injection: `PRAGMA wal_checkpoint(TRUNCATE)`
   so a reader opening the DB immediately sees a complete state (fixes the
   "un-checkpointed WAL" footgun).
4. `registry.register(name, root_path)`.

Frame extraction continues to recluster on every index (frames are a global
property), unchanged.

### 4. Read path

- **`resolveGraphDbForRead(repoPath)`** — unchanged priority order
  (`.cortex/db` → `.cortex/graph.db` → cache), so a repo already indexed into
  the cache still reads until it is re-indexed into `.cortex/db`. This is the
  migration safety net.
- **`openProjectStore(boundStore, boundProject, requestedProject)`** — stops
  hardcoding the cache path. For a non-bound project: look up `root_path` from
  the registry, then open `resolveGraphDbForRead(root_path)` read-only. Returns
  `null` (→ empty graph response) when the project is unknown or has no store.
  Bound-project behaviour unchanged (returns the bound store, `owned:false`).
- **`listKnownRepos` / `listProjectsUnified`** — enumerate from the registry
  instead of scanning the cache dir. The in-memory pool (resolved-this-session
  repos) still merges in and wins on conflict, so freshly-indexed repos appear
  even before a registry write completes.

### 5. Migration (one-shot, idempotent)

At MCP server startup (and defensively at the top of `index_repository`,
mirroring the decisions-migration pattern):

- For each `<slug>.db` in `~/.cache/cortex-indexer/` with a `ctx_projects`
  row: `registry.register(name, root_path)`.
- Skips `_`/`tmp-` prefixed files and any `root_path` under `.tmp/`.
- Does **not** copy graph data — repos re-index into `.cortex/db` naturally,
  and `resolveGraphDbForRead`'s cache fallback (§4) serves reads until they do.
- Idempotent: re-running registers the same rows with no duplication.

Old cache `.db` files are left in place but unused. A later, separate cleanup
task may delete them once every active repo has re-indexed.

### 6. Components & boundaries

| Unit | Purpose | Depends on |
|---|---|---|
| `src/db/registry.ts` | what repos exist + where (the registry) | better-sqlite3 |
| `src/db/resolve-path.ts` | the **single chokepoint** mapping repo → graph DB path | fs |
| write path (CLI + MCP) | index → `.cortex/db`, checkpoint, register | registry, resolve-path |
| read path (`openProjectStore`, enumerators) | resolve via registry + resolve-path | registry, resolve-path |
| migration | seed registry from legacy cache | registry |

Invariant: **nothing outside `resolve-path.ts` hardcodes `.cortex/db`.** This
keeps the graph-path mapping a one-place change (see Future extensions).

### 7. Error handling

- Registry open/IO failure is best-effort and non-fatal: enumeration falls back
  to the in-memory pool; a registration failure logs and does not fail the
  index (mirrors the never-throw frame-extraction contract).
- `openProjectStore` returns `null` on any resolution/open failure → the API
  returns an empty graph, never a 500.
- WAL checkpoint failure logs and is non-fatal (the DB is still valid; the next
  reader may briefly see WAL-pending state).

### 8. Testing

**Unit**
- `registry`: register/list/remove; idempotent upsert; `.tmp/` rejection;
  concurrent-ish double register lands both rows (serialised, no loss).
- `openProjectStore`: with both `.cortex/db` and cache present for a registered
  project, opens `.cortex/db` (the exact reported bug); unknown project → null;
  bound project → bound store, `owned:false`.
- migration: seeds registry from a fixture cache dir; idempotent on re-run;
  skips `_`/`tmp-`/`.tmp/`.

**Integration**
- CLI `cortex index` of a fixture repo → registry row present + `.cortex/db`
  populated + WAL checkpointed (no `-wal` residue with pending frames).
- viewer `/api/projects` lists registry repos.
- viewer `/api/graph?project=X` reads `.cortex/db` and returns the
  freshly-injected frame labels.

**Gate 0 (visual QA)** — start `npm run dev` (port 3334, `/viewer`), switch to a
non-bound project, confirm frames render with current labels (not stale, not
`cluster:N`).

## Future extensions (not built)

**Branch-keyed graph cache.** The code graph is a pure derived function of
code-at-a-commit, so it is regenerated, never merged — branch/merge DB
semantics are the wrong model. The valuable form is a cache keyed by
branch/commit: index once per ref, switch branches → instant correct graph. If
ever built, it changes **only** `resolve-path.ts` (e.g. `.cortex/db` →
`.cortex/graph/<ref>.db` with an optional ref argument). Registry and
`decisions.db` stay branch-independent by construction — decisions are durable
cross-branch knowledge and must never be branched. Not built now (YAGNI;
incremental `detect_changes` + reindex covers branch-switch staleness for a
single dev). The single-chokepoint invariant (§6) is what keeps this a
one-place change later.

## Phasing (for the implementation plan)

1. `registry.ts` + tests (no wiring).
2. Write path: CLI → `.cortex/db`, WAL checkpoint, `register` (MCP + CLI).
3. Read path: `openProjectStore` + enumerators → registry + `resolveGraphDbForRead`.
4. Migration at startup + idempotency tests.
5. Gate-0 visual QA; (optional, later) cache `.db` cleanup task.

Each phase is independently testable and leaves the system working.

## Relationship to the cluster:N fix

Independent. The `cluster:N` labeling fix is committed on
`fix/frame-extraction/cluster-label-fallback` (`88db7c2`). This branch builds on
top of it; merge that branch first (or rebase this onto it) so the regenerated
frames carry the corrected labels.

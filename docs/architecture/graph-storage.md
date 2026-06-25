# Graph Storage & the Project Registry

> One-pager. Audience: anyone touching `src/db/` (`resolve-path.ts`, `registry.ts`,
> `registry-migration.ts`, `cache.ts`), the index write paths
> (`src/cli/commands/index.ts`, `src/mcp-server/tools/code-tools.ts`), or the
> viewer/MCP read paths (`src/graph/code-queries.ts`, `src/mcp-server/repo-context.ts`,
> `src/mcp-server/api.ts`). For the *decision* sidecar see
> [decisions-storage.md](decisions-storage.md); for the *design rationale* of this
> model see the [storage-unification spec](../superpowers/specs/2026-06-05-frames-viewer-storage-unification-design.md)
> and decision `bb2dee7e`.

## The three stores

| Store | Path | Lifecycle | Holds |
|---|---|---|---|
| **Graph** (canonical) | `<repo>/.cortex/db` | **Derived, replaceable** — recreated by `index_repository` | nodes, edges, `ctx_projects`, frames |
| **Decisions** | `~/.cortex/<repoId>/decisions.db` | **Durable** — survives every reindex; **out of the repo** | user-authored decisions + links |
| **Registry** (central) | `~/.local/share/cortex-indexer/registry.db` | Durable index of "what repos exist + where" | `repos(name, root_path, indexed_at)` |

The graph DB is **per-repo** under `<repo>/.cortex/`. The decisions DB lives
**out of the repo** at `~/.cortex/<repoId>/decisions.db` (resolved by
`resolveDecisionsDbPath` from the `repoId` in the repo's committed `cortex.json`,
so every worktree/clone shares one store; `$CORTEX_DECISIONS_DB` overrides,
`$CORTEX_HOME` relocates the base — the in-repo `.cortex/decisions.db` is only a
not-a-git-repo fallback and a one-time legacy migration source). The registry is
a **single machine-wide** SQLite file. Keeping these three concerns separate is
deliberate: the graph is a throwaway derivative of code-at-a-commit, decisions
are durable knowledge, and the registry answers "where are the repos"
independently of either.

**Why `~/.local/share`, not `~/.cache`:** the registry is *durable* metadata —
losing it blanks `list_projects`/the switcher for every repo not re-indexed
since. `~/.cache` (XDG_CACHE_HOME) means "regenerable, safe to delete," so
durable state belongs under the XDG **data** home instead. This matches the
indexer binary's own XDG discipline: `~/.config/cortex-indexer/` for config,
`~/.cache/cortex-indexer/` for cache, and now `~/.local/share/cortex-indexer/`
for durable data (the registry, and the binary's `_config.db` key-value store).
Genuinely-regenerable artifacts stay in `~/.cache`: the content-hash build cache
(`~/.cache/cortex/`), the legacy per-project graph cache
(`~/.cache/cortex-indexer/<slug>.db`), and the frame-extraction Python venv.

## Canonical store vs. the legacy names

`<repo>/.cortex/db` is the **one** graph store. Two other paths exist only for
backward compatibility and are *read fallbacks*, never write targets:

- `<repo>/.cortex/graph.db` — the **old** graph filename. Some older docs/code
  still say "graph.db"; treat that as a synonym for the legacy location.
- `~/.cache/cortex-indexer/<slug>.db` — the standalone indexer's old per-project
  cache. **Retired as a graph store.** Still read as a last resort and used as
  the migration source (below).

> **Two unrelated "caches" share a prefix — do not confuse them:**
> `~/.cache/**cortex**/<hash>.db` is the content-hash **build cache**
> (`src/db/cache.ts`) that lets `index_repository` skip re-parsing an unchanged
> tree. `~/.cache/**cortex-indexer**/<slug>.db` is the legacy per-project graph
> cache. Only the latter is part of this storage model.

## The registry — why it exists

Before this model, the cache directory *was* the project registry: enumeration
(`list_projects`, the viewer's project switcher) scanned `~/.cache/cortex-indexer/`
and opened every `<slug>.db` to recover its `root_path` (the slug filename is
lossy — slashes are flattened). That coupled "what repos exist" to "where graphs
are stored." Making `.cortex/db` canonical meant enumeration needed a new home.

`src/db/registry.ts` (`class Registry`) is that home: a tiny SQLite table
`repos(name TEXT PRIMARY KEY, root_path TEXT UNIQUE, indexed_at TEXT)` with
`register` / `list` / `findByName` / `remove`. SQLite (not a JSON file) because
`better-sqlite3` is already a dependency and its `INSERT … ON CONFLICT` gives
atomic upserts — no lost-update/torn-write race when the CLI and an MCP server
register concurrently.

- **Location:** `<XDG_DATA_HOME>/cortex-indexer/registry.db`, i.e.
  `~/.local/share/cortex-indexer/registry.db` by default; honors `$XDG_DATA_HOME`.
- **Override:** `CORTEX_REGISTRY_DB` relocates it (tests set this to a temp path
  so they never pollute the real registry — mirrors `CORTEX_DB` /
  `CORTEX_DECISIONS_DB`).
- **`.tmp` guard:** `register()` rejects any `root_path` containing a `.tmp/`
  segment, so eval-corpus clones under `cortex/.tmp/…` can never enter
  enumeration.

## Write path: staging build + transactional publish

Both `cortex index` (CLI, `src/cli/commands/index.ts`) and the `index_repository`
MCP tool (`src/mcp-server/tools/code-tools.ts`) build into a **private staging
DB** and then publish into the canonical store through a single libsqlite3
transaction. The canonical `<repo>/.cortex/db` is **never written out-of-band**
while a reader holds it open.

1. **Build into staging.** `stagingDbPath(repoPath)` →
   `<repo>/.cortex/db.stage-<pid>` (a sibling no long-lived handle holds open).
   The native indexer binary writes it (`CORTEX_DB=<stage>`); on a cache hit the
   cache entry is imported *into staging* (never copied onto the live db); frame
   + contract passes run against staging. Stale staging is cleaned at entry and
   after publish.
2. **Publish.** `publishStagedDb({ stagePath, liveDbPath })`
   (`src/db/swap-graph-db.ts`) opens the live db on a short-lived handle,
   `ATTACH`es staging, and inside one `BEGIN IMMEDIATE … COMMIT` replaces every
   staging-present table (`DELETE` + `INSERT…SELECT`, FK off for the
   edges↔nodes cascade). Because every byte reaching the live file goes through
   libsqlite3 in WAL mode, the server's open handle sees the new committed
   snapshot with **no reopen**, and a crash before COMMIT leaves the old state
   intact. Live-only tables (`edge_annotations`, `cortex_index_meta`) are left
   untouched; contentless FTS5 virtual tables (`ctx_nodes_fts`) are recreated +
   repopulated from `nodes` (see [known-limitations](known-limitations.md)). The
   C indexer (`sqlite_writer.c`) is **unchanged** — it just writes the staging
   path. This **supersedes** the in-place/inode-preserving truncate (`04c848f0`),
   whose out-of-band `fopen("wb")` under an open WAL handle corrupted index
   b-trees.
3. **Serialize.** The whole build+publish runs under `withIndexLock(repoPath, …)`
   (`src/db/index-lock.ts`) — a per-repo `BEGIN EXCLUSIVE` on
   `.cortex/index.lock.db` (auto-released on process death) plus an in-process
   promise queue — so a CLI `cortex index` and an MCP `index_repository` of the
   same repo can't race.
4. **Freshness baseline + register.** `captureIndexMeta(dbPath, repoPath)` writes
   the baseline on the *canonical* path after publish;
   `registry.register(deriveProjectName(repoPath), repoPath)` is best-effort.

## Read path (everything resolves through one chokepoint)

`resolveGraphDbForRead(repoPath)` in `src/db/resolve-path.ts` is the **single
chokepoint** mapping a repo → its graph DB. The canonical `.cortex/db` wins
**unconditionally whenever it is an openable SQLite file** — populated,
valid-empty, or a 0-byte drift; an empty canonical store surfaces as `empty`
(→ reindex) rather than being shadowed by a stale sibling. Only when `.cortex/db`
is *absent or non-SQLite garbage* does it fall back to a populated
`.cortex/graph.db` → cache slug (the migration safety net for repos indexed only
into the old cache). This replaced the earlier "first populated candidate" order,
which let a stale `.cortex/graph.db` shadow a fresh `.cortex/db` (the 2026-06-09
viewer stale-map bug; decision `f1950d3`).

- **MCP reads** thread `RepoContext.graphDbPath` (from `resolveGraphDbForRead`)
  into every tool.
- **Viewer reads** (`openProjectStore`, `src/graph/code-queries.ts`) resolve the
  requested project's `root_path` from the registry, then call
  `resolveGraphDbForRead`. (Falls back to the legacy cache path only when the
  project is unknown to the registry.)
- **Enumeration** (`listKnownRepos` in `repo-context.ts`, `listProjectsUnified`
  in `code-queries.ts`) reads `registry.list()` — no more cache-dir scan.

> **Invariant:** nothing *outside* `resolve-path.ts` hardcodes `.cortex/db`.
> The two writers use `resolveCortexDbPath`; readers use `resolveGraphDbForRead`.
> This keeps the path mapping a one-place change — e.g. a future branch-keyed
> graph cache (`.cortex/graph/<ref>.db`) would touch only the resolver, leaving
> the registry and decisions DB untouched.

## Freshness (is the read current?)

The read path above will, by design, serve a *populated fallback*
(`.cortex/graph.db` / cache slug) when `.cortex/db` is missing or 0-byte — which
returned **stale data with no signal** before this layer existed (see
[known-limitations](known-limitations.md) and the
`project-graph-db-stale-reads` history). Every indexed read now carries a
**freshness verdict** (`src/mcp-server/freshness.ts`), attached at the
`registerTool` chokepoint for the read tools.

- **Baseline.** Both index paths write `indexed_commit`, `indexed_dirty_sig`,
  and `indexed_at` into a `cortex_index_meta` key/value table in `.cortex/db`
  (`src/graph/index-meta.ts`, captured by `src/graph/capture-index-meta.ts`).
- **Per-call check** (memoized 2 s/repo). Compares the baseline to the live
  `git rev-parse HEAD` + `git status --porcelain` signature →
  `fresh | stale:commits | stale:dirty | stale:both`. `RepoContext.canonical`
  (true only when `graphDbPath === resolveCortexDbPath(...)`) plus a 0-node check
  yields **`empty`** — this is the verdict that makes the degraded *fallback*
  above **loud instead of silent**. No baseline / non-git → `unknown`.
  Storing `indexed_dirty_sig` means indexing a dirty tree reads `fresh` (the
  graph reflects that state); only *further* edits flip it to stale.
- **Surfacing.** `fresh` leaves results untouched; otherwise a
  `⚠ cortex freshness: …` note is appended to the result text and a structured
  `freshness` field is added. `cortex freshness` (CLI) prints the same verdict
  into the SessionStart banner; the banner's index detection uses `-s`
  (non-empty), so a 0-byte `.cortex/db` no longer reads as "indexed".
- **Auto-refresh** runs **only out-of-band at SessionStart** (full index for
  `empty`/`unknown`, incremental for `stale:*`) — never inside a read, because
  incremental indexing is delete+recreate, not in-place
  (see [known-limitations](known-limitations.md) + decision `bbf0fce5`).

Gates: `CORTEX_FRESHNESS=0` disables the signal; `CORTEX_AUTO_REFRESH=0` keeps
the signal but disables auto-refresh.

## Migration

Two idempotent, best-effort seeders run **once at viewer startup** — inside
`startViewerServer`, which `src/index.ts` awaits *before* `server.connect(transport)`,
so the registry is populated before any `list_projects` call:

1. **`importLegacyRegistry`** — carries rows from the pre-XDG registry
   (`~/.cache/cortex-indexer/_registry.db`) into the current
   `~/.local/share/cortex-indexer/registry.db`. Covers repos registered via
   register-on-index that have no legacy `<slug>.db` to re-seed from.
2. **`migrateCacheToRegistry`** — for each legacy
   `~/.cache/cortex-indexer/<slug>.db` with a `ctx_projects` row, `register`s its
   `root_path`. Catches repos present only in the old per-project cache.

Both are **idempotent** (`ON CONFLICT(name)` upsert + within-run dedup by
`root_path`; a partial failure recovers next startup) and **non-destructive**
(they do **not** copy graph data — repos re-index into `.cortex/db` naturally,
and `resolveGraphDbForRead`'s cache fallback serves reads until they do; old
files are left in place). New repos need no migration — register-on-index (write
path step 3) covers them.

> The indexer binary's `_config.db` key-value store (`cortex-indexer config
> get/set`) moved the same way: `ctx_resolve_data_dir()` now places it under
> `~/.local/share/cortex-indexer/`, and the `config` command renames a pre-XDG
> `~/.cache/cortex-indexer/_config.db` into the data dir on first use
> (`CTX_DATA_DIR` overrides the location, mirroring `CTX_CACHE_DIR`).

## Key files

| File | Responsibility |
|---|---|
| `src/db/registry.ts` | The registry (what/where) + `CORTEX_REGISTRY_DB` + `.tmp` guard |
| `src/db/registry-migration.ts` | One-shot idempotent cache→registry seed |
| `src/db/resolve-path.ts` | `resolveCortexDbPath` (write) + `resolveGraphDbForRead` (read) — the path chokepoint |
| `src/db/cache.ts` | The *unrelated* content-hash build cache (`~/.cache/cortex/`) |
| `src/cli/commands/index.ts` · `src/mcp-server/tools/code-tools.ts` | Write paths (CORTEX_DB + WAL + register) |
| `src/graph/code-queries.ts` · `src/mcp-server/repo-context.ts` · `src/mcp-server/api.ts` | Read + enumeration + startup migration |
| `src/graph/index-meta.ts` · `src/graph/capture-index-meta.ts` | Freshness baseline (`cortex_index_meta`): write at index, read at check |
| `src/mcp-server/freshness.ts` · `src/cli/commands/freshness.ts` | Freshness classifier + memoized resolver + `attachFreshness`; `cortex freshness` CLI |

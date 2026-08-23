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
  cache. **Retired as a graph store** for the read/write paths above — but not
  dead: the direct-indexer CLI path and eval/corpus indexing (see
  [Garbage collection](#garbage-collection) below) still write it as a
  by-product on every run, so a repo continues to accumulate a slug cache even
  though nothing reads it back as a graph store. It's read only as a last
  resort and used as the migration source (below); the GC layer is what keeps
  it from growing unbounded now that nothing else consumes it.

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

## Two axes

Root derivation splits into two independent axes — which tree on disk you're
standing in, versus which logical repo it belongs to:

| | Checkout axis | Repo-identity axis |
|---|---|---|
| Derived by | `worktreeRoot()` (`src/db/git-root.ts`) — `git rev-parse --show-toplevel` | `mainWorktreeRoot()` (`src/db/git-root.ts`) — `git --git-common-dir` |
| A linked worktree | is its own root | collapses to the main checkout |
| Carries | graph store, staging, index lock, freshness baseline, registry row, project name, **and every `hashGovernedSource` anchor** | `repoId`, the shared decisions/todos/stories store, the `worktree_of` back-pointer |

In a main checkout the two are byte-identical; only linked worktrees diverge.

**Rule of thumb:** graph paths — `resolveCortexDbPath`, `resolveGraphDbForRead`,
staging, the index lock, the freshness baseline, the registry row — resolve on
`worktreeRoot`. Decisions/todos/stories (`repoId`, the decisions sidecar)
resolve on `mainWorktreeRoot`, so every worktree of a repo still shares one
durable knowledge store. `RepoContextResolver.resolve`
(`src/mcp-server/repo-context.ts`) sets `ctx.repoPath` from the checkout axis,
which means **every** `hashGovernedSource` call (decision reconciliation
drift-hashing) anchors to the checkout the caller is actually standing in, not
the main checkout — a governed file edited only in a worktree now flips that
worktree's reconciliation state, not the main checkout's.

Both index write paths (CLI `cortex index` and the MCP `index_repository`
tool) now build and publish into the *checkout's own* `.cortex/db`, and both
write a `worktree_of` + `branch` column on the registry row so a linked
checkout can be told apart from — and grouped under — its canonical parent
(`list_projects`, `/api/projects`, the viewer's `"<name> @ <branch>"` label).
`cortex doctor`'s orphan audit (`src/db/registry-audit.ts`) carves out a
worktree row that holds a real store of its own so it survives as a
legitimate registry entry rather than being pruned as a stale collapse
target.

**Transitional and deliberate:** a checkout with no store of its own still
falls back to reading the canonical repo's graph, annotated
`servedFrom: "canonical"` on `RepoContext` — this keeps a not-yet-indexed
worktree usable rather than empty. A later stage makes reads strict and
removes both the fallback and the annotation; until then, treat
`servedFrom: "canonical"` as "this checkout hasn't been indexed on its own
yet," not as a bug.

This replaces the prior model, where every root derivation — index write
path, read resolver, registry — canonicalized through `mainWorktreeRoot`
alone (decision `D-b248`): a linked worktree had no index of its own, so
`search_code` run from inside it silently read the main checkout's graph on
the wrong branch, and a worktree's freshness verdict described the main
checkout's HEAD, never its own.

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

   > **Why `INSERT…SELECT`, not `backup()`/`VACUUM INTO`:** the publish copies
   > rows via `ATTACH` + per-table `INSERT…SELECT` **deliberately** — not
   > SQLite's backup API or `VACUUM INTO`. The C writer emits a staging DB whose
   > **page size can differ** from the live file's (e.g. 4096 vs 65536), and the
   > backup API throws `attempt to write a readonly database` across a page-size
   > mismatch (reproduced during design). `INSERT…SELECT` copies **logical rows**
   > and is page-size-agnostic. (`backup()` would also copy the whole image with
   > no diff and grow the WAL unboundedly under a pinned reader.)
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

### Per-call repo routing (RepoContext)

The MCP server has no startup-bound "home repo." Every tool call carries an
absolute `repo_path`; `RepoContextResolver.resolve(repo_path)`
(`src/mcp-server/repo-context.ts`) validates it (exists → is a git root →
indexed) and returns a pooled `RepoContext` bundling that repo's graph DB,
decisions sidecar, store, and repositories. This replaced a former
single-bind-at-startup model where every write (notably decision captures)
silently pooled into whichever repo the server process happened to start in —
the cause of one repo's decisions DB accumulating rows governed by unrelated
sibling repos. Consequently `resolveCortexDbPath`'s global `CORTEX_DB_PATH`
override (see the chokepoint invariant above) applies **only** to the implicit
(cwd) case — an explicit `repo_path` always wins, so one override can't collapse
every addressed repo onto a single path. The `repo_path` input contract, resolver
modes (default / `crossRepo` / `allowUnindexed`), and error shapes
(`MissingRepoPathError`, `RepoNotIndexedError`, `PathNotFoundError`,
`NotAGitRepoError`) are documented in [mcp-tools.md](../mcp-tools.md).

Both the index write paths and this read resolver canonicalize through
`worktreeRoot` (`src/db/git-root.ts`) — the **checkout axis** of the
[two-axis model](#two-axes) above — before any name/db/registry derivation.
A subdirectory still collapses to its enclosing checkout's root, so a subdir
passed to indexing or to a read tool never creates an orphan sub-project. A
linked worktree, however, no longer collapses onto the main checkout for
graph purposes: as of Stage 1 it resolves to itself and gets its own
registry row and store. (Decisions still canonicalize through
`mainWorktreeRoot`, the repo-identity axis, so a worktree's decisions still
land in the one shared durable store.) A path outside any git repo is not
rejected — it canonicalizes to its own realpath and is served as a
literal-path (non-git) project.

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

## Garbage collection

Migration (above) is non-destructive by design — old files are left in place
rather than deleted. That's the right default for a one-time seed, but left
unchecked it means the legacy slug cache (and other regenerable copies) grow
forever: every `cortex index` / `index_repository` run still writes
`~/.cache/cortex-indexer/<slug>.db` as a side effect of the C indexer's own
cache discipline, even though `resolveGraphDbForRead` only ever consults it as
a last-resort fallback. Storage GC is the layer that reaps what's provably
regenerable and never touches what might not be — three complementary passes,
all gated by a single `CORTEX_GC` env var (default on; `CORTEX_GC=0` disables
all three) and built on shared classification predicates in
`src/db/store-gc.ts` / path derivation in `src/db/store-paths.ts`:

1. **Reap-after-publish.** Both index write paths (`src/cli/commands/index.ts`
   and the `index_repository` MCP handler in `code-tools.ts`) call
   `reapRepoSlugCache(repoPath)` immediately after a successful publish +
   registry registration. It deletes `~/.cache/cortex-indexer/<slug>.db` (plus
   `-wal`/`-shm` sidecars) for the just-indexed repo, but only when
   `isReapableSlugCache` confirms it's safe: the repo's canonical
   `<repo>/.cortex/db` opens as SQLite with ≥1 `nodes` row (`hasValidCanonicalGraph`),
   or the repo path no longer exists at all. If neither holds — e.g. the
   publish somehow left the canonical store empty — the slug cache is the only
   copy left and is never touched. `cortex index delete <project>` reaps the
   same way before removing the registry row.
2. **SessionStart current-repo sweep.** `hooks/check-index.sh` shells out to
   `cortex index sweep` on every session start (best-effort, output
   discarded), which calls `sweepCurrentRepo(repoRoot)`. Beyond the
   reap-after-publish slug-cache check, this also clears two staging-file
   classes that can strand mid-index artifacts if a run is interrupted:
   `<repo>/.cortex/db.stage-*` siblings and `tmp-ctx_incr_*` files in the
   shared indexer cache dir, both gated by `isStaleStaging` (mtime older than
   24h by default) so an in-flight index's own staging file is never raced.
   This is deliberately scoped to the *current* repo only — cheap enough to
   run unconditionally at every session start without a machine-wide scan.
3. **`cortex doctor` all-stores audit.** The machine-wide backstop.
   `auditStores(registry)` (`src/db/store-gc-audit.ts`) walks every durable
   decision dir (`~/.cortex/<repoId>/`) and the whole shared indexer cache dir,
   dry-run classifying each entry as either **reapable** (empty decision dirs
   with zero `decisions` rows, consumed/orphaned slug caches, stale
   `tmp-ctx_incr_*`) or an **archive candidate** (a decision dir with ≥1
   decision row whose `repoId` is no longer in the registry's live set — i.e.
   its repo was renamed, moved, or deleted). `cortex doctor` prints the dry-run
   report by default; `--fix` calls `fixStores`, which deletes the reapable
   set and, for archive candidates, calls `archiveDecisionDir` to **move**
   (never delete) the dir to `~/.cortex/_archive/<repoId>/` — content-bearing
   user data is irreplaceable, so the worst case is "relocated, still on disk,"
   never "gone." See [decisions-storage.md](decisions-storage.md#storage-garbage-collection-empty-dirs-and-archived-orphans)
   for the empty-dir leak this closes.

Every reap/archive action is wrapped in a try/catch that swallows failures —
storage GC is a best-effort background convenience, and it must never fail an
index, a session start, or a `cortex doctor` invocation because of a
permissions error or a concurrent deletion.

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
| `src/db/store-paths.ts` | Cache/store path derivation (`cacheSlug`, `slugCachePath`, `archiveRoot`, `indexerCacheDir`) — shared by GC and the read resolver |
| `src/db/store-gc.ts` | GC classification predicates + actions: `isReapableSlugCache`, `isEmptyDecisionDir`, `reapRepoSlugCache`, `sweepCurrentRepo`, `archiveDecisionDir` |
| `src/db/store-gc-audit.ts` | `cortex doctor`'s all-stores dry-run audit (`auditStores`) + apply (`fixStores`) |
| `src/cli/commands/doctor.ts` · `hooks/check-index.sh` | `cortex doctor --fix` (machine-wide backstop) and the SessionStart current-repo sweep (`cortex index sweep`) |

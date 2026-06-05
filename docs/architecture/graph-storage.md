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
| **Decisions** | `<repo>/.cortex/decisions.db` | **Durable** — survives every reindex | user-authored decisions + links |
| **Registry** (central) | `~/.cache/cortex-indexer/_registry.db` | Durable index of "what repos exist + where" | `repos(name, root_path, indexed_at)` |

The graph and decisions DBs are **per-repo siblings** under `.cortex/`. The
registry is a **single machine-wide** SQLite file. Keeping these three concerns
separate is deliberate: the graph is a throwaway derivative of code-at-a-commit,
decisions are durable knowledge, and the registry answers "where are the repos"
independently of either.

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

- **Override:** `CORTEX_REGISTRY_DB` relocates it (tests set this to a temp path
  so they never pollute the real registry — mirrors `CORTEX_DB` /
  `CORTEX_DECISIONS_DB`).
- **`.tmp` guard:** `register()` rejects any `root_path` containing a `.tmp/`
  segment, so eval-corpus clones under `cortex/.tmp/…` can never enter
  enumeration.

## Write path (both writers agree)

Both `cortex index` (CLI, `src/cli/commands/index.ts`) and the `index_repository`
MCP tool (`src/mcp-server/tools/code-tools.ts`) do the same three things:

1. **Write the graph to `<repo>/.cortex/db`.** The native indexer binary chooses
   its output from the `CORTEX_DB` env var; both writers set it via
   `resolveCortexDbPath(repoPath)`. (The CLI previously let the binary fall back
   to the cache — that was the divergence this model removed.)
2. **Checkpoint the WAL** (`PRAGMA wal_checkpoint(TRUNCATE)`) after frame
   injection, so a reader opening the DB immediately sees a complete state with
   no writes stranded in the `-wal` sidecar.
3. **`registry.register(deriveProjectName(repoPath), repoPath)`** — best-effort
   (never fails the index). `deriveProjectName` is the same slug used as
   `ctx_projects.name` and as the viewer's `?project=` param, so the registry
   key matches what readers look up.

## Read path (everything resolves through one chokepoint)

`resolveGraphDbForRead(repoPath)` in `src/db/resolve-path.ts` is the **single
chokepoint** mapping a repo → its graph DB. It returns the first *populated*
candidate in priority order: `.cortex/db` → `.cortex/graph.db` → cache slug.
This is the migration safety net: a repo indexed only into the old cache still
reads until it is re-indexed into `.cortex/db`.

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

## Migration (legacy cache → registry)

`migrateCacheToRegistry` (`src/db/registry-migration.ts`) runs **once at viewer
startup** — inside `startViewerServer`, which `src/index.ts` awaits *before*
`server.connect(transport)`, so the registry is seeded before any
`list_projects` call. For each legacy `~/.cache/cortex-indexer/<slug>.db` with a
`ctx_projects` row, it `register`s the `root_path`. It is:

- **Idempotent** — `ON CONFLICT(name)` upsert + within-run dedup by `root_path`;
  a partial failure recovers on the next startup.
- **Non-destructive** — it does **not** copy graph data. Repos re-index into
  `.cortex/db` naturally, and the `resolveGraphDbForRead` cache fallback serves
  reads until they do. Old cache `<slug>.db` files are left in place but unused.

New repos don't need migration: register-on-index (write path step 3) covers
them going forward.

## Key files

| File | Responsibility |
|---|---|
| `src/db/registry.ts` | The registry (what/where) + `CORTEX_REGISTRY_DB` + `.tmp` guard |
| `src/db/registry-migration.ts` | One-shot idempotent cache→registry seed |
| `src/db/resolve-path.ts` | `resolveCortexDbPath` (write) + `resolveGraphDbForRead` (read) — the path chokepoint |
| `src/db/cache.ts` | The *unrelated* content-hash build cache (`~/.cache/cortex/`) |
| `src/cli/commands/index.ts` · `src/mcp-server/tools/code-tools.ts` | Write paths (CORTEX_DB + WAL + register) |
| `src/graph/code-queries.ts` · `src/mcp-server/repo-context.ts` · `src/mcp-server/api.ts` | Read + enumeration + startup migration |

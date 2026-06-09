# Graph DB transactional-swap publish — design

_Design date: 2026-06-09. Supersedes the in-place / inode-preserving incremental
index approach (referenced in CLAUDE.md as decision `04c848f0`)._

**Status:** approved, pre-implementation.

## Problem

The canonical graph store `<repo>/.cortex/db` is written by a **hand-rolled C
SQLite page-format writer** — `ctx_write_db()` in
[`internal/indexer/extract/sqlite_writer.c`](../../../internal/indexer/extract/sqlite_writer.c)
(~line 1773) opens the path with `fopen(path, "wb")` and **truncate-rewrites the
whole file directly**, bypassing SQLite's locking/WAL protocol.

Meanwhile the long-lived MCP server holds **two long-lived read-write libsqlite3
handles** on that same file for its entire lifetime — a `GraphStore` in WAL mode
plus a raw `better-sqlite3` handle — pooled per repo in
[`src/mcp-server/repo-context.ts`](../../../src/mcp-server/repo-context.ts#L276-L280);
`GraphStore` sets `journal_mode=WAL` ([`store.ts:50`](../../../src/graph/store.ts#L50)).

When an index runs while the server is up, the out-of-band truncate-rewrite
happens **underneath those open WAL connections**. Their page caches and
`-wal`/`-shm` sidecars become incoherent with the rewritten file, and the next
libsqlite3 write — the TS frame pass `UPDATE`-ing `nodes.data`
([`inject-frames.ts:416`](../../../src/frame-extraction/inject-frames.ts#L416)),
the TS contract pass `INSERT`-ing anchor nodes + `BINDS_KEY` edges
([`inject.ts:12`](../../../src/contracts/inject.ts#L12)), or any decision write —
corrupts the index B-trees. Observed: `row N missing from index` on
`idx_nodes_kind` / `idx_nodes_kind_file` / `idx_nodes_kind_project`, which made
every contract-extraction step fail with `database disk image is malformed`, and
served stale/partial frame data.

A single-process libsqlite3 write on a freshly C-written file does **not**
corrupt; the **concurrent open handle + out-of-band truncate** is essential to
the failure.

The in-place approach (`04c848f0`) chose truncate-rewrite-don't-unlink
specifically so the server's open handle would *see the refresh* — but rewriting
a file in place under an open WAL handle is precisely the corruption vector. It
traded stale reads for corruption.

### A second, equivalent vector: the cache-import path

The MCP `index_repository` cache-hit branch
([`code-tools.ts`](../../../src/mcp-server/tools/code-tools.ts#L455-L463)) calls
`readCacheEntry(cacheKey, dbPath)` →
[`cache.ts:81-83`](../../../src/db/cache.ts#L81-L83) `copyFileSync(cachePath,
destDbPath)` — another **out-of-band overwrite of the live file**, followed by
`unlinkSync` of the `-wal`/`-shm` sidecars. Same corruption class. Any fix that
only redirects the C writer misses this path.

## Goals / constraints

1. **Corruption-impossible.** No sequence of *(index while the server holds open
   RW WAL handles)* may corrupt the graph DB. `integrity_check` stays `ok`.
2. **Crash-consistent.** A `kill -9` / power loss at any instant leaves readers
   seeing a *complete* DB — the old state or the new state, never a half-written
   one.
3. **Cross-platform, incl. Windows.** Windows cannot rename-over or delete a file
   another process holds open, and symlinks are unreliable there. The design must
   not depend on either.
4. **Freshness (strong preference).** After an index, the server's already-open
   handle should see the new data **without a process restart** — ideally with no
   reopen at all.
5. **Minimal moving parts.** Prefer SQLite's native mechanisms over hand-rolled
   filesystem coordination (pointers, GC, lockfiles).

## Design — staging build + atomic SQL publish

Each index builds a **private staging DB** that no long-lived handle holds, then
**publishes** it into the live `.cortex/db` through a single SQLite write
transaction. Every byte that reaches the live file goes through libsqlite3's WAL
writer — the safe single-writer / N-reader case SQLite guarantees — so the
server's pooled handles see the new committed snapshot on their next read with
**no reopen, no pointer, no GC, single canonical file**, and the C writer is
**unchanged** (no indexer rebuild).

### Index operation (both the CLI and MCP orchestrators)

1. **Acquire the per-repo index lock** (see Concurrency) before any build work.
2. Compute a staging path `<repo>/.cortex/db.stage-<pid>`. Best-effort unlink any
   stale staging file first (guarded by the lock).
3. Run the C indexer with `CORTEX_DB=<stage>` (or, on a cache hit, copy the cache
   entry **into** `<stage>` rather than onto the live file).
4. Run `runFrameExtraction` and `runContractExtraction` against **`<stage>`**, so
   the graph is *fully built* (nodes + `frame_id` annotations + contract anchors +
   `BINDS_KEY` edges) before cutover.
5. **Publish** `<stage>` → live `.cortex/db` (single transaction, below).
6. Best-effort delete `<stage>` (+ its `-wal`/`-shm`). On Windows EBUSY this is
   retried at the next index start; a leftover staging file is inert.
7. Release the lock; register in the machine registry on the canonical path.

### `publishStagedDb({ stagePath, liveDbPath })`

A new chokepoint module `src/db/swap-graph-db.ts`:

1. Open the live DB on a **short-lived** handle (not a pooled handle), WAL,
   `busy_timeout` set. Run `migrate()` (CREATE TABLE IF NOT EXISTS) so the live
   schema is current before the copy.
2. `PRAGMA foreign_keys = OFF` for the duration of the bulk replace. `edges.source_id`
   and `edges.target_id` both `REFERENCES nodes(id) ON DELETE CASCADE`
   ([`schema.ts:19-20`](../../../src/graph/schema.ts#L19-L20)), so with FK
   enforcement on, a per-table `DELETE FROM nodes` would cascade-wipe `edges`
   and impose a delete/insert ordering. Disabling FKs lets each table be
   replaced independently; the staging data is internally consistent by
   construction.
3. `ATTACH '<stagePath>' AS stage`.
4. `BEGIN IMMEDIATE`.
5. **Dynamic table list:** `SELECT name FROM stage.sqlite_master WHERE
   type='table' AND name NOT LIKE 'sqlite_%'`. For each: `DELETE FROM main.<t>`
   then `INSERT INTO main.<t> (<cols>) SELECT <cols> FROM stage.<t>`, where
   `<cols>` is `stage.<t>`'s column list (authoritative new schema; tolerates the
   live table having extra/legacy columns).
6. Fold `captureIndexMeta` / index-meta writes **inside this transaction** so the
   metadata cutover is atomic with the data.
7. `COMMIT`. `DETACH stage`. `PRAGMA wal_checkpoint(PASSIVE)`.

**Live-only tables are left intact by construction.** Because the swap copies
only the tables present *in staging* (the C-writer's set), any table that exists
only on the live side — e.g. the lazily-migrated `edge_annotations`, or a legacy
`decisions_fts` — is never touched. No snapshot/restore code is required; the
omission *is* the preservation. This makes the swap a strict, schema-stable
content replacement, not a schema reset.

`edge_annotations` itself is **dormant and arguably misplaced**: it's a TS-only
table (schema.ts) with no application writer — only `tests/graph/store.test.ts`
exercises its CRUD — so it holds zero rows in practice and isn't even
materialized in the current `.cortex/db`. Its apparent intent (annotating
edges/nodes with agent traversal / live activity) is **ephemeral presence state
that belongs in the streaming/event layer** (`events.db` + the WebSocket
pipeline), not in a persistent graph store that is wholesale-replaced every
reindex. It needs no handling here. **Follow-up (out of scope):** remove
`edge_annotations` from the graph schema (`schema.ts`, `store.ts`, its test)
once the event-layer home is confirmed; decisions↔code links already use stable
string keys (qualified-names / paths) per CLAUDE.md, not edge ids.

### Read resolution — unchanged

`resolveGraphDbForRead` continues to resolve the single canonical `.cortex/db`
(the openable-`.cortex/db`-wins logic landed earlier this session). No pointer,
no fallback demotion. The legacy `.cortex/graph.db` / cache fallbacks remain only
for un-migrated repos.

## Why this is corruption-impossible and crash-consistent

- **Corruption:** the live file is mutated *only* through libsqlite3 WAL
  transactions on a short-lived writer while readers hold WAL read snapshots —
  the exact case SQLite is designed for. The C writer's raw truncate only ever
  touches the private staging file, which no other process opens.
- **Crash:** the publish is one `BEGIN IMMEDIATE … COMMIT`. A crash before COMMIT
  rolls back to the complete old state; after COMMIT the new state is durable.
  Building frames/contracts into staging *before* the swap makes the single
  COMMIT the atomic cutover of the fully-built graph — closing the
  "new-graph-without-contracts" window that today's post-write separate
  frame/contract transactions leave.

## Concurrency

A per-repo **OS-advisory index lock**: `BEGIN EXCLUSIVE` on a tiny
`<repo>/.cortex/index.lock.db`, acquired at the **top** of both orchestrators
(before spawning the C indexer) and held through publish. Chosen over a `mkdir`
lock because a SQLite exclusive lock **auto-releases on process death** (the OS
closes the fd on `kill -9`), is dependency-free, and is cross-platform. It
serializes the expensive build across simultaneous CLI + MCP indexes and makes
the stale-staging sweep predicate sound.

Independently, `PRAGMA busy_timeout = 5000` is set on **every** graph-DB
connection (the swap handle, `GraphStore`, the raw pooled handle, inject-frames,
inject, index-meta), so a losing writer **waits** instead of throwing
`SQLITE_BUSY` — converting a latent data-loss into a bounded stall.

## Windows correctness

The live `.cortex/db` is **never** renamed-over or unlinked while the server
holds it open — it is mutated in place via SQL. Only the private staging file is
created/deleted, and no other process opens it, so there is no sharing-violation.

**Non-local Windows filesystems** (OneDrive / network shares / Docker bind
mounts) do not reliably support WAL `-shm` shared memory, so
freshness-without-reopen is not guaranteed there. Corruption-safety is
unaffected (`BEGIN IMMEDIATE` still serializes the single writer). Mitigation:
detect `SQLITE_IOERR_SHMOPEN` / a non-local fs and fall back to a
**reopen-on-change** path (Phase 6), which is explicitly allowed by goal 4.

## Empirical validation (design-panel prototypes)

- Freshness-without-reopen: a long-lived RW WAL handle saw the new rows
  immediately after the swap COMMIT with no reopen.
- `integrity_check` stayed `ok` before / after / on a cold reopen, with a live RW
  handle open across the swap.
- Scale: 100k nodes / 300k edges / 82.5 MB → swap transaction **418 ms**, WAL
  peaked at ~1× DB size (not the 3× the red-team projected).
- `wal_checkpoint(TRUNCATE)` reclaimed the WAL to 0 bytes even with a reader
  present.
- An uncommitted (kill-9-equivalent) swap left the **old** state intact,
  `integrity_check ok`.
- `ATTACH + INSERT…SELECT` works across the 4096↔65536 page-size mismatch,
  whereas the SQLite **backup API throws `attempt to write a readonly
  database`** across that same mismatch — disqualifying the backup-API
  alternative.

## Alternatives rejected

- **Versioned files + `.cortex/current` pointer + GC.** Fails crash-consistency
  (pointer can name a generation whose pages never `fsync`'d — the C writer
  issues no fsync, and macOS `fsync` ≠ `F_FULLFSYNC`) and Windows (cannot delete
  the open old generation, cannot delete the mmap'd `-shm` at all →
  unbounded `.cortex/` leakage). Freshness fundamentally requires a reopen (new
  data is in a different file). Demotes `.cortex/db` to a fallback, reviving the
  stale-`graph.db` shadow bug and breaking the `isCanonicalGraphDbPath`
  invariant. 4–5 new coordination mechanisms — the opposite of "minimal moving
  parts."
- **SQLite backup API / `VACUUM INTO`.** Disqualified by the reproduced fatal
  page-size-mismatch failure above; also copies the whole image every index (no
  diff), grows the WAL unboundedly under a pinned reader, still needs a reopen,
  and leaves the cache-import vector unfixed.

## Testing

- **Unit (`swap-graph-db`):** build a staging DB; open a live RW WAL reader;
  publish; assert the reader sees new data **without reopen**, `integrity_check
  ok`, a **live-only table absent from staging is left intact** (seed a row in a
  live-only table, confirm it survives the swap — the schema-stability
  invariant), and an aborted (uncommitted) swap leaves the old state intact.
- **Regression (the reported bug):** open a long-lived RW WAL handle, run a full
  index through the new publish path, assert `integrity_check` stays `ok` and
  contracts succeed. (Reproduces today's failure on the old path.)
- **Cache twin:** warm-cache `index_repository` with the server handle open →
  no corruption.
- **Concurrency:** simultaneous CLI + MCP index of one repo serialize cleanly; a
  `kill -9` mid-index does not strand the lock.
- **Schema-evolution guard:** assert the staged table set equals the C writer's
  table set minus `sqlite_*`.

## Implementation phases (each independently shippable + testable)

1. **`busy_timeout` everywhere.** Add `PRAGMA busy_timeout=5000` to every
   graph-DB open site. Hardens the current code against `SQLITE_BUSY` data-loss;
   independently testable. Low risk, high leverage.
2. **The swap chokepoint.** `src/db/swap-graph-db.ts::publishStagedDb` + its unit
   tests, in isolation (no live server needed).
3. **Wire the CLI path.** `src/cli/commands/index.ts`: build into staging, publish
   to canonical. End-to-end verifiable via `cortex index` while the dev server
   holds the repo open (the exact reported repro).
4. **Wire the MCP path incl. the cache twin.** `code-tools.ts`: redirect
   `callIndexer` + `withFrames` to staging then publish; re-route the cache-hit
   branch to copy the cache entry into staging then publish; update
   `cache.ts::writeCacheEntry` to snapshot **from staging** (never a raw read of a
   live WAL DB).
5. **Concurrency lock.** Per-repo `BEGIN EXCLUSIVE` index lock + stale-staging
   sweep at index start.
6. **Optional freshness hardening + docs.** A `PRAGMA user_version` bump inside
   the swap txn + a refcount-safe reopen-on-change fallback in `repo-context.ts`
   used **only** when WAL visibility is unavailable (non-local Windows fs). Update
   `docs/architecture/graph-storage.md` + CLAUDE.md; capture a decision (governs
   `src/db/swap-graph-db.ts`) recording why backup() / versioned-files were
   rejected.

## Remaining risks

- **Schema-evolution coupling:** a future C-writer table missed by the dynamic
  list would keep stale data on the live side. Mitigated by the runtime
  `sqlite_master` derivation + the schema-evolution guard test.
- **WAL reclamation under a continuously-busy server:** a reader pinning a
  snapshot at the checkpoint instant can make `TRUNCATE` no-op, leaving the WAL
  ~1× DB size until a quiescent moment. Bounded by PASSIVE checkpoint +
  `journal_size_limit` + autocheckpoint; not corrupting.
- **Non-local Windows fs `-shm` coherence:** freshness (not safety) falls back to
  reopen-on-change (Phase 6).
- **Index-lock liveness after kill-9 on Windows:** verify the exclusive lock
  releases promptly on abnormal termination on a Windows runner.

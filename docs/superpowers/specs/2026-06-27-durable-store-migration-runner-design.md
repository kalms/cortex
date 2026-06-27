# Versioned migration runner for the primitives DB — design

> Status: approved 2026-06-27. Implements decision **D-b0kp** / TODO **T-21**.
> Introduces a single migration runner for the durable, user-authored
> primitives DB (decisions + todos), replacing flag-gated self-heal logic
> scattered across application open-paths. Tracking follows the
> [simonw/sqlite-migrate](https://github.com/simonw/sqlite-migrate) pattern: an
> applied-migrations table keyed by name, not a version integer.

## Problem

Cortex has no real DB migration strategy. Schema/data changes to the durable
primitives DB are handled by idempotent self-heal functions invoked at
application open-paths, gated by ad-hoc `schema_meta` flags or `PRAGMA
table_info` probing. [`openDecisionsDb`](../../../src/decisions/db.ts) alone
mixes ~5 styles (`CREATE TABLE IF NOT EXISTS`; `table_info`+`ALTER` for the
`provenance`/`seq`/reconciliation columns; an `fts_version` schema_meta flag →
FTS rebuild; the legacy relocation), and the two heaviest **data** migrations —
`migrateDecisionIdsToShortForm` and `migrateDecisionsFromGraphDb` — live only at
the MCP entry points ([`repo-context.ts`](../../../src/mcp-server/repo-context.ts),
[`src/index.ts`](../../../src/index.ts)), not in the shared opener.

The fault-line (per D-b0kp): there is **no migration ledger**, **no
version-too-new guard**, **no ordering** across the independent migrations, and
correctness depends on **every store-opener remembering to replay every
migration**. The `cortex` CLI proved the last point this session — its
`openService` opened the durable store but ran none of the data migrations, so a
CLI-first store could be left un-migrated. For a plugin shipped to users who pull
updates across breaking changes, the gaps are real: an old binary can silently
open a newer store and misread it; a new opener can miss a step.

## Goals

1. A single forward-only **migration runner** with an applied-migrations
   ledger, applied at one chokepoint every opener routes through.
2. A **too-new guard** that hard-refuses rather than operating on a store
   written by a newer binary.
3. A **pre-migration snapshot + restore** so a migrating open of user-authored
   data is recoverable (batch-atomic, plus manual rollback).
4. Fold the primitives-DB-only data migration (`migrateDecisionIdsToShortForm`)
   into the runner so all openers — CLI and MCP — converge by construction.

## Non-goals / scope

- **In scope:** the primitives DB (`~/.cortex/<repoId>/decisions.db` —
  decisions, todos, their links, FTS, `id_sequences`, `schema_meta`).
- **Out of scope, by design:**
  - The **graph DB** and **events DB** — derived/operational, regenerable by
    reindex; `CREATE TABLE IF NOT EXISTS` suffices, no migrations needed.
  - The **registry DB** (`repos` table) — durable but trivial and rarely
    changing. The runner is built DB-agnostic (and carries a `migration_set`
    column) so the registry can adopt it later in ~3 lines; it is **not** wired
    in this effort.
  - **PRs** — there is no PR store; PR↔decision links live in `decision_links`
    (`target_kind='pr'`). Nothing to migrate.
  - **`migrateDecisionsFromGraphDb`** — see "Migration boundary" below; stays at
    the entry points (cross-DB dependency).

## Decisions (settled during brainstorming)

| # | Decision |
|---|---|
| D1 | **Baseline-at-current + forward.** Today's declarative schema is the baseline (the `ensureX` layer); the runner records/runs only named data + forward migrations on top of it. No replay-from-zero. |
| D2 | **Scope = primitives DB now;** runner is DB-agnostic and reusable for the registry later. |
| D3 | **Too-new → hard refuse** all operations with an upgrade message (exit 4). No best-effort reads. |
| D4 | **Pre-migration snapshot + restore**, taken only when migrations will actually run against a non-empty store; retain the last 3. |
| D5 | **Ledger = a `_cortex_migrations` applied-names table** (`migration_set`, `name`, `applied_at`; unique on `(migration_set, name)`), adopted from simonw/sqlite-migrate — **not** `PRAGMA user_version`. Name-keyed (no shared integer counter → safe across parallel branches), per-migration applied-ness (gap-fills naturally), and auditable via `applied_at`. |

## Architecture

### The runner — `src/db/migrate.ts` (new, DB-agnostic)

```ts
export type Migration = { name: string; up: (db: Database) => void };

export function runMigrations(
  db: Database,
  migrations: Migration[],
  opts: { set: string },   // migration_set, e.g. "primitives"
): void;
```

Behavior:
1. Validate the list at load: **names are unique** and **append-only** is the
   authoring discipline (a name, once shipped, is never removed or reordered
   ahead of an earlier one). Duplicate names throw a programmer error.
2. Ensure the ledger table exists:
   ```sql
   CREATE TABLE IF NOT EXISTS _cortex_migrations (
     migration_set TEXT NOT NULL,
     name          TEXT NOT NULL,
     applied_at    TEXT NOT NULL,
     PRIMARY KEY (migration_set, name)
   );
   ```
3. `applied = SELECT name FROM _cortex_migrations WHERE migration_set = ?` (a set).
4. **Too-new guard:** if `applied` contains any name **not** present in this
   binary's `migrations` list → the store was migrated by a newer Cortex. Throw
   `MigrationError(store-too-new)` carrying `{ unknown: string[], set }`.
   (Name-based, so it survives any future renumbering scheme.)
5. Apply every migration whose `name` is **not** in `applied`, in list order.
   **Each migration owns its own atomicity** (most wrap their work in
   `db.transaction`); `runMigrations` records the `(set, name, applied_at)` row
   immediately after `up()` returns. An outer wrapping transaction is
   deliberately avoided — it would neutralise migrations like id-short-form that
   must toggle `PRAGMA foreign_keys` (a no-op inside a transaction). Because
   migrations are idempotent, a crash between `up()` and the ledger write is
   harmless: the migration re-runs (no-op / safe re-apply) on the next open.
   Cross-migration batch atomicity is provided by the file snapshot
   (§ Snapshot), not by a wrapping transaction.
6. A migration that throws aborts the run with its own changes rolled back (its
   internal transaction) and no ledger row written; the exception propagates to
   the chokepoint, which restores the file snapshot.

The runner is pure with respect to the filesystem: it takes a handle and never
touches files. Snapshot/restore is the chokepoint's job (it owns the path).

### Chokepoint integration — `openDecisionsDb`

The opener becomes the single convergence point. New order:

1. open handle, set WAL + `foreign_keys`;
2. **ensure baseline schema** — the existing `BASE_SCHEMA` + `ensureProvenanceColumn`/
   `ensureSeqColumn`/`ensureReconciliationColumns` + FTS handling, unchanged.
   These adopt pre-runner stores (bring their *schema* current idempotently);
3. **relocate legacy** (`relocateLegacyDecisions`) — unchanged, runs before the
   runner so relocated UUID decisions are visible to the id-short-form migration;
4. determine whether any migration is **pending** (ledger missing a name); if so
   **and the store is non-empty**, take a **pre-migration snapshot** (§ Snapshot);
5. `runMigrations(db, PRIMITIVES_MIGRATIONS, { set: "primitives" })` — inside a
   try that, on any throw, **restores from the snapshot** and rethrows;
6. return.

Because the CLI's `openService`, the MCP `repo-context`, and tests all call
`openDecisionsDb`, every opener converges. The redundant
`migrateDecisionIdsToShortForm` calls in `repo-context.ts` and `src/index.ts`
are **removed** (the runner now owns it); the `migrateDecisionsFromGraphDb`
calls **stay** (see boundary).

### Applied-names lifecycle

The names table makes adoption fall out of one rule — **"run every migration
whose name isn't recorded, idempotently, then record it"** — so there is no
separate "stamp baseline" step:

- **Fresh store:** baseline schema created empty → no rows in `_cortex_migrations`
  → every migration is pending → each runs (a no-op on empty data, e.g.
  id-short-form finds zero rows) → each recorded. The store ends with the full
  set recorded.
- **Existing wild store** (no `_cortex_migrations` table, populated): the runner
  creates the table and runs every migration (none recorded yet). Each is
  idempotent: id-short-form no-ops if the store is already short (its old
  `decision_ids_shortform` flag short-circuits) and **converts UUIDs if a
  CLI-only store missed it** — the exact gap, fixed as the default path. Then
  recorded.
- **At-current store:** all names recorded → nothing pending → no snapshot, no
  work; the cost is one `SELECT` from the ledger.
- **Relocation** runs *before* the runner, so UUID decisions copied in from a
  legacy store are present and get converted by id-short-form on that first open.

Because every migration is **idempotent**, "run-all-unrecorded" is safe for both
fresh and adopted stores — we never need to mark a migration applied without
running it. (Append-only authoring keeps it that way: a future schema migration
runs on an empty fresh store harmlessly and on a wild store exactly once.)

### Migration boundary — what the runner owns

- **In (first migration, `"id-short-form"`): `migrateDecisionIdsToShortForm`.**
  Needs only the primitives DB; it is exactly the step the CLI was missing. Its
  internal `decision_ids_shortform` `schema_meta` flag is kept as a redundant
  guard through the transition (belt-and-suspenders; harmless).
- **Out: `migrateDecisionsFromGraphDb`.** It requires the **graph DB path**,
  which the primitives-DB chokepoint does not have, and it is deeply historical
  (the old graph→sidecar import, already converged on every real store; even
  `src/index.ts` runs it only conditionally). It stays at the MCP/index entry
  points that have graph access. **The runner owns primitives-DB-only
  migrations; cross-DB imports are explicitly not its job.**

  **Deliberate post-import forced conversion (repo-context.ts).** Because
  `openDecisionsDb` (the runner chokepoint) runs before `migrateDecisionsFromGraphDb`
  in `repo-context.ts`, the runner records `id-short-form` as done on an **empty**
  store — then the graph import inserts UUID-keyed rows after. The converter's
  normal `schema_meta` flag would short-circuit on the next call and leave those
  UUID ids unconverted. The fix: `repo-context.ts` inspects the import return
  count (`imported.decisions > 0`) and calls
  `migrateDecisionIdsToShortForm(decisionsDb, { force: true })` immediately after
  the import to rewrite the freshly inserted UUID rows. The `{ force }` option skips
  the flag check but still applies the `WHERE id NOT LIKE 'D-%'` guard, so it is
  idempotent over already-converted rows. This is a deliberate, documented
  exception to the single-chokepoint rule: the graph import is kept outside the
  runner precisely because it needs the graph DB path, so its ordering
  (import-then-force-convert) lives at the call site. `src/index.ts` has the same
  graph-import call but it runs before `openDecisionsDb` returns (in the original
  pre-runner code `migrateDecisionIdsToShortForm` followed it) — that path was
  removed when the runner took ownership; the ordering issue is specific to
  `repo-context.ts` where `openDecisionsDb` runs first.
- **Going forward:** new columns/tables are added as **named migrations**, not
  new `ensureX` helpers. The existing `ensureX`/FTS logic remains as the
  baseline-adoption layer for pre-runner stores.

Initial list: `PRIMITIVES_MIGRATIONS = [{ name: "id-short-form", up: migrateDecisionIdsToShortForm }]`.

### Snapshot + restore

- **When:** only when a migration is **pending** (the ledger is missing a name)
  **and** the store has data (a brand-new empty store has nothing to protect).
  Normal at-current opens pay nothing.
- **How:** a consistent single-file snapshot via `db.backup(dest)` (better-sqlite3)
  or `VACUUM INTO` — WAL-correct, unlike a raw copy. Destination:
  `<storeDir>/backups/decisions.db.bak.<ISO-timestamp>`.
- **Restore-on-failure:** the chokepoint wraps `ensure → relocate →
  runMigrations`; on any throw it closes the handle, restores the file from the
  snapshot, and rethrows as `MigrationError(migration-failed)` ("migration
  failed; store restored from snapshot"). This makes the whole batch
  **all-or-nothing at file granularity**, covering the "migration N+1 fails after
  migration N committed" gap that per-step transactions cannot.
- **Retention:** keep the last **3** pre-migration snapshots per store, pruned by
  count, so a fault discovered *after* a successful migration still has a manual
  rollback path. Bounded growth (store is KB-scale).

### Too-new guard

`runMigrations` throws `MigrationError(store-too-new)` when the ledger records a
migration name this binary doesn't know. The chokepoint surfaces it as an
`EnvironmentError` (CLI exit 4) with: `this <set> store has migration(s) <names>
this Cortex doesn't recognize — it was written by a newer version; upgrade the
plugin (git pull / npm i -g) to use it.` Identical path in CLI and MCP (both
flow through `openDecisionsDb`). No reads, no writes.

## Safety: the rehome / test-fixture invariant

`decision-rehome` and several tests insert **raw-UUID** ids directly via
`openDecisionsDb` + `repo.insert`, and assert the UUID survives. The lifecycle
preserves this: a fixture opens an empty store (→ id-short-form runs on zero rows
and is **recorded**), *then* inserts UUIDs; subsequent opens find id-short-form
already recorded, so it never runs on them and the UUIDs are untouched. Real
UUIDs that *do* need converting come from legacy relocation, which runs *before*
the runner on the first open of a not-yet-recorded store — so those get
converted. The two cases are cleanly separated by ordering.

## Error handling

- `MigrationError` is a new typed error (kind: `store-too-new` | `migration-failed`).
- Chokepoint maps it to `EnvironmentError` for the CLI exit-code path; MCP tools
  surface it through the normal error response.
- A migration body that throws → its transaction rolls back (no ledger row) →
  file restored from snapshot → `migration-failed` rethrown. The store is never
  left half-migrated.
- The unique-names check throws at module load (a developer error, caught in CI
  by any test that imports the list).

## Components / files

- **Create** `src/db/migrate.ts` — `Migration`, `runMigrations`, `MigrationError`,
  ledger-table management, unique-names validation, the too-new check.
- **Create** `src/db/snapshot.ts` — `snapshotDb(db, dest)` + `restoreDb(path, src)`
  + `pruneSnapshots(dir, keep)` (small, file-level, unit-testable).
- **Modify** `src/decisions/db.ts` — define `PRIMITIVES_MIGRATIONS`; wire the
  snapshot-guarded `runMigrations` into `openDecisionsDb` after relocate.
- **Modify** `src/mcp-server/repo-context.ts`, `src/index.ts` — remove the now
  redundant `migrateDecisionIdsToShortForm` calls (keep `migrateDecisionsFromGraphDb`).
- **Tests**: `tests/db/migrate.test.ts` (runs unrecorded migrations in order;
  skips recorded ones; idempotent re-open; too-new refusal on an unknown
  recorded name; resume after a partial run; per-migration transaction rollback
  leaves no ledger row; unique-names guard), `tests/db/snapshot.test.ts`
  (consistent copy, restore round-trip, prune-to-3), and integration in
  `tests/decisions/` (a virgin store opened via `openDecisionsDb` ends with the
  set recorded; a CLI-opened store gets short ids; rehome UUID fixtures still
  survive; snapshot created on a populated upgrade and absent on a fresh /
  at-current open).

## Future (not this effort)

- Registry adoption of `runMigrations` (a `{ set: "registry" }` call when it next
  changes).
- Eventual unification of `migrateDecisionsFromGraphDb` if/when a richer opener
  carries the graph path — low priority, historical.

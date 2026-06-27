# Versioned migration runner for the primitives DB — design

> Status: approved 2026-06-27. Implements decision **D-b0kp** / TODO **T-21**.
> Introduces a single versioned migration runner for the durable, user-authored
> primitives DB (decisions + todos), replacing flag-gated self-heal logic
> scattered across application open-paths.

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

The fault-line (per D-b0kp): there is **no `schema_version` ledger**, **no
version-too-new guard**, **no ordering** across the independent migrations, and
correctness depends on **every store-opener remembering to replay every
migration**. The `cortex` CLI proved the last point this session — its
`openService` opened the durable store but ran none of the data migrations, so a
CLI-first store could be left un-migrated. For a plugin shipped to users who pull
updates across breaking changes, the gaps are real: an old binary can silently
open a newer store and misread it; a new opener can miss a step.

## Goals

1. A single forward-only **migration runner** with a `user_version` ledger,
   applied at one chokepoint every opener routes through.
2. A **version-too-new guard** that hard-refuses rather than operating on a
   store written by a newer binary.
3. A **pre-migration snapshot + restore** so a version-advancing upgrade of
   user-authored data is recoverable (batch-atomic, plus manual rollback).
4. Fold the primitives-DB-only data migration (`migrateDecisionIdsToShortForm`)
   into the runner so all openers — CLI and MCP — converge by construction.

## Non-goals / scope

- **In scope:** the primitives DB (`~/.cortex/<repoId>/decisions.db` —
  decisions, todos, their links, FTS, `id_sequences`, `schema_meta`).
- **Out of scope, by design:**
  - The **graph DB** and **events DB** — derived/operational, regenerable by
    reindex; `CREATE TABLE IF NOT EXISTS` suffices, no migrations needed.
  - The **registry DB** (`repos` table) — durable but trivial and rarely
    changing. The runner is built DB-agnostic so the registry can adopt it
    later in ~3 lines; it is **not** wired in this effort.
  - **PRs** — there is no PR store; PR↔decision links live in `decision_links`
    (`target_kind='pr'`). Nothing to migrate.
  - **`migrateDecisionsFromGraphDb`** — see "Migration boundary" below; stays at
    the entry points (cross-DB dependency).

## Decisions (settled during brainstorming)

| # | Decision |
|---|---|
| D1 | **Baseline-at-current + forward.** Today's declarative schema is the baseline; the runner stamps existing/fresh stores at the baseline and runs only numbered migrations going forward. No replay-from-zero. |
| D2 | **Scope = primitives DB now;** runner is DB-agnostic and reusable for the registry later. |
| D3 | **Version-too-new → hard refuse** all operations with an upgrade message (exit 4). No best-effort reads. |
| D4 | **Pre-migration snapshot + restore**, taken only on a real version-advancing upgrade of a non-empty store; retain the last 3. |
| D5 | **Ledger = `PRAGMA user_version`** (native SQLite integer), not a `schema_meta` key. |

## Architecture

### The runner — `src/db/migrate.ts` (new, DB-agnostic)

```ts
export type Migration = { version: number; name: string; up: (db: Database) => void };

export function runMigrations(
  db: Database,
  migrations: Migration[],
  opts: { label: string },   // label used in error/log messages, e.g. "decisions"
): void;
```

Behavior:
1. `HEAD = max(version)` over `migrations` (0 if empty). Validate the list is a
   contiguous, ascending, gap-free `1..HEAD` at load (throws a programmer error
   otherwise — a guard against a mis-authored list).
2. `current = db.pragma("user_version", { simple: true })`.
3. **Too-new guard:** if `current > HEAD` → throw `MigrationError`
   (`store-too-new`) carrying `{ current, head, label }`.
4. Apply every migration with `version > current`, ascending. **Each migration
   runs in its own transaction**; on success set `user_version = version` inside
   the same transaction, so a crash leaves the store at the last fully-applied
   version (resume-safe).
5. A migration that throws rolls back its transaction and aborts the run (the
   exception propagates to the chokepoint, which handles file-level restore).

The runner is pure with respect to the file: it takes a handle and never touches
the filesystem. Snapshot/restore is the chokepoint's job (it owns the path).

### Chokepoint integration — `openDecisionsDb`

The opener becomes the single convergence point. New order:

1. open handle, set WAL + `foreign_keys`;
2. **ensure baseline schema** — the existing `BASE_SCHEMA` + `ensureProvenanceColumn`/
   `ensureSeqColumn`/`ensureReconciliationColumns` + FTS handling, unchanged.
   These adopt pre-runner stores (bring their *schema* current idempotently);
3. **relocate legacy** (`relocateLegacyDecisions`) — unchanged, runs before the
   runner so relocated UUID decisions are visible to migration #1;
4. read `user_version`; if an upgrade will run (`user_version < HEAD` **and** the
   store is non-empty) take a **pre-migration snapshot** (§ Snapshot);
5. `runMigrations(db, PRIMITIVES_MIGRATIONS, { label: "decisions" })` — inside a
   try that, on any throw, **restores from the snapshot** and rethrows;
6. return.

Because the CLI's `openService`, the MCP `repo-context`, and tests all call
`openDecisionsDb`, every opener converges. The redundant `migrateDecisionIdsToShortForm`
calls in `repo-context.ts` and `src/index.ts` are **removed** (the runner now
owns it); the `migrateDecisionsFromGraphDb` calls **stay** (see boundary).

### `user_version` lifecycle

- **Fresh store:** baseline schema created empty → `user_version = 0 < HEAD` but
  store empty → **skip snapshot** → run migrations (no-ops on empty data) →
  stamp `HEAD`. Fresh stores **start at HEAD**.
- **Existing wild store** (`user_version = 0`, populated): baseline-ensure has
  already made its schema current; the runner runs the data migrations (each
  idempotent / a no-op when its old `schema_meta` flag is set) → stamp `HEAD`.
  This **adopts** in-the-wild DBs without replaying history. (One-time snapshot
  on this first upgrade, even if the migrations no-op — acceptable; the store is
  KB-scale and it never recurs once stamped.)
- **At-HEAD store:** `user_version == HEAD` → no snapshot, no migrations; the
  cost is a single `PRAGMA` read.

### Migration boundary — what the runner owns

- **In (migration #1): `migrateDecisionIdsToShortForm`.** Needs only the
  primitives DB; it is exactly the step the CLI was missing. Its internal
  `decision_ids_shortform` `schema_meta` flag is kept as a redundant guard
  through the transition (belt-and-suspenders; harmless).
- **Out: `migrateDecisionsFromGraphDb`.** It requires the **graph DB path**,
  which the primitives-DB chokepoint does not have, and it is deeply historical
  (the old graph→sidecar import, already converged on every real store; even
  `src/index.ts` runs it only conditionally). It stays at the MCP/index entry
  points that have graph access. **The runner owns primitives-DB-only
  migrations; cross-DB imports are explicitly not its job.**
- **Going forward:** new columns/tables are added as **numbered migrations**, not
  new `ensureX` helpers. The existing `ensureX`/FTS logic remains as the
  baseline-adoption layer for pre-runner stores.

Initial list: `PRIMITIVES_MIGRATIONS = [{ version: 1, name: "id-short-form", up: migrateDecisionIdsToShortForm }]`,
so `HEAD = 1`.

### Snapshot + restore

- **When:** only when `user_version < HEAD` **and** the store has data (a
  brand-new empty store has nothing to protect). Normal at-HEAD opens pay
  nothing.
- **How:** a consistent single-file snapshot via `db.backup(dest)` (better-sqlite3)
  or `VACUUM INTO` — WAL-correct, unlike a raw copy. Destination:
  `<storeDir>/backups/decisions.db.bak.v<from>` (timestamped suffix to avoid
  collisions across same-version retries).
- **Restore-on-failure:** the chokepoint wraps `ensure → relocate →
  runMigrations`; on any throw it closes the handle, restores the file from the
  snapshot, and rethrows as `MigrationError` ("migration failed; store restored
  to v<from>"). This makes the whole batch **all-or-nothing at file
  granularity**, covering the "step N+1 fails after step N committed" gap that
  per-step transactions cannot.
- **Retention:** keep the last **3** pre-migration snapshots per store, pruned by
  count, so a fault discovered *after* a successful migration still has a manual
  rollback path. Bounded growth (store is KB-scale).

### Version-too-new guard

`runMigrations` throws `MigrationError(store-too-new)`; the chokepoint surfaces
it as an `EnvironmentError` (CLI exit 4) with: `this <label> store is vN, but
this Cortex understands up to vM — upgrade the plugin (git pull / npm i -g) to
use it.` Identical message path in CLI and MCP (both flow through
`openDecisionsDb`). No reads, no writes.

## Safety: the rehome / test-fixture invariant

`decision-rehome` and several tests insert **raw-UUID** ids directly via
`openDecisionsDb` + `repo.insert`, and assert the UUID survives. The "fresh =
HEAD" rule preserves this: a fixture opens an empty store (→ stamped HEAD before
any rows exist), *then* inserts UUIDs; subsequent opens are already at HEAD, so
migration #1 (id-short-form) never runs on them and the UUIDs are untouched.
Real UUIDs that *do* need converting come from legacy relocation, which runs
*before* the runner on the first open of a not-yet-stamped store — so those get
converted. The two cases are cleanly separated by ordering.

## Error handling

- `MigrationError` is a new typed error (kind: `store-too-new` | `migration-failed`).
- Chokepoint maps it to `EnvironmentError` for the CLI exit-code path; MCP tools
  surface it through the normal error response.
- A migration body that throws → its transaction rolls back → file restored from
  snapshot → `migration-failed` rethrown. The store is never left half-migrated.
- The contiguity check on the migration list throws at module load (a developer
  error, caught in CI by any test that imports the list).

## Components / files

- **Create** `src/db/migrate.ts` — `Migration`, `runMigrations`, `MigrationError`,
  list-contiguity validation.
- **Create** `src/db/snapshot.ts` — `snapshotDb(db, dest)` + `restoreDb(path, src)`
  + `pruneSnapshots(dir, keep)` (small, file-level, unit-testable).
- **Modify** `src/decisions/db.ts` — define `PRIMITIVES_MIGRATIONS`; wire the
  snapshot-guarded `runMigrations` into `openDecisionsDb` after relocate.
- **Modify** `src/mcp-server/repo-context.ts`, `src/index.ts` — remove the now
  redundant `migrateDecisionIdsToShortForm` calls (keep `migrateDecisionsFromGraphDb`).
- **Tests**: `tests/db/migrate.test.ts` (forward apply; idempotent re-run;
  too-new refusal; resume from partial `user_version`; per-migration transaction
  rollback; contiguity guard), `tests/db/snapshot.test.ts` (consistent copy,
  restore round-trip, prune-to-3), and integration in
  `tests/decisions/` (a virgin store opened via `openDecisionsDb` ends at HEAD;
  a CLI-opened store gets short ids; rehome UUID fixtures still survive;
  snapshot created on a populated upgrade and absent on a fresh/at-HEAD open).

## Future (not this effort)

- Registry adoption of `runMigrations` (3-line wire-up when it next changes).
- Eventual unification of `migrateDecisionsFromGraphDb` if/when a richer opener
  carries the graph path — low priority, historical.

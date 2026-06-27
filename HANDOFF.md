# Cortex — Session Handoff

## ✅ DONE (2026-06-27 — 1.2.1: durable-store migration runner)

Shipped **1.2.1** via PR [#41](https://github.com/ruevu/cortex/pull/41) (merge
`a0a2b00`) through the design → spec → plan → subagent-driven TDD → review →
gated-release cycle. CI gate passed on the PR. Decision **`D-b0kp`**, TODO
**`T-21`** (done).

The durable primitives DB (`~/.cortex/<repoId>/decisions.db`) now converges
through a single, name-tracked **migration runner** instead of flag-gated
self-heal scattered across store-openers:

- **`src/db/migrate.ts`** — `runMigrations(db, list, {set, beforeApply})` records
  applied migrations **by name** in a `_cortex_migrations` ledger
  (simonw/sqlite-migrate pattern, **not** `PRAGMA user_version`): append-only,
  safe across parallel branches. A store carrying a migration name this binary
  doesn't recognize (written by a newer Cortex) is **hard-refused** —
  `MigrationError` → CLI **exit 4** — never silently misread. A failing
  migration is not recorded and aborts the run.
- **`src/db/snapshot.ts`** — `VACUUM INTO` pre-migration snapshots under
  `<storeDir>/backups/` (retain last 3) + restore-on-failure, so a failed
  upgrade never leaves a half-migrated store.
- **`openDecisionsDb` is the single chokepoint** — ensure schema → relocate
  legacy → snapshot-if-pending-and-non-empty → run migrations →
  restore-on-failure. The one existing data migration (legacy UUID → `D-` short
  ids) is the first ledger entry (`id-short-form`); its scattered call sites are
  removed.
- **Review-caught fix:** the legacy graph-import path
  (`migrateDecisionsFromGraphDb`) inserts UUID-keyed rows *after* the open-time
  runner records the id migration, so it now **force-re-runs the id converter
  when it imports rows** — graph-imported decisions keep `D-` ids. (This was a
  silent data-shape regression the per-task gates missed; the opus whole-branch
  review caught it.)

**Verification:** full suite **1446/1446**, `tsc --noEmit` clean, CI gate green.

> ⚠ The MCP server loads `src/` once at startup — the new runner behavior only
> takes effect after a server **restart**.

**Deferred follow-up (tracked):** **`T-9wq8`** — harden `restoreDb` with an
atomic copy-to-temp + `rename` (today's `copyFileSync` is non-atomic; a crash
mid-restore leaves a truncated store, though the snapshot survives so it's
recoverable). Low priority, non-blocking.

## ✅ DONE (2026-06-27 — 1.2.0: `cortex todo` CLI namespace)

The TODO primitive (storage + MCP `todo` tool + `/api/todos`, shipped in
1.0.0/1.1.1) became driveable from the CLI. Merged via PR #40. Detail in
[`CHANGELOG.md`](CHANGELOG.md).

## ▶ NEXT STEP

In rough priority order (full state in
[`docs/specs/progress.md`](docs/specs/progress.md)):

1. **TODO hooks + external bridge** (later slice) — `PostMergeHook`
   auto-completing `resolvedBy` TODOs on PR merge; `PostDecisionHook` linking
   `spawnsFrom`; Linear/JIRA/GitHub mirroring (bidirectional sync is v1.5).
2. **Frame-quality + Louvain `concern` axis** (larger) — the upstream fix for
   fragmented/test-mixed clusters and substrate-band core domain (`SRC·863`
   mega-frame), the ceiling the taxonomy observe phase repeatedly hit. Deferred
   in `D-8vbv`.
3. **Remaining agentic-experience items** (2026-06-12 field report): **P4**
   warm-path decision drafting, **P5** cross-repo decision search, **P7(b/c)**
   tighten tool descriptions / lazy-load the long tail, **P8** temporal
   `changes_since`. (P1/P2/P3/P6 shipped; P7(a) shipped in 1.0.0.)

**Still-open layout issue (not started):** the frames layout **reshuffles on
every reindex** — the d3-force seed is `SHA-256(frame records)`, so any frame
id/label/member-count change (and auto-reindex fires on every commit) reseeds
the chaotic sim → full relayout. Options noted earlier: warm-start/anchor
positions, reduce reindex churn, stable seed. (The earlier "viewer lean" — a
*different* problem — shipped in **1.1.3** via `D-p8bg`: viewer fit-to-content
center-of-mass framing + cloud keep-out. That thread is closed.)

**TODO viewer follow-ups (deferred from 1.1.1, non-blocking).** Standalone TODOs
with no governed frame don't render as ambient dots (no graph anchor — matches
decision behavior); and `withGovernedFramesRendered` promotes non-ambient
*decision*-governed frames but not TODO-governed ones. Both are parity gaps, not
regressions; see decision `D-kkz6`.

**Parallel, non-blocking:** the **co-change lens** (`FILE_CHANGES_WITH` minus
structural edges = hidden coupling, as a sibling row in the layers menu); the
deferred 3b test follow-ups (multi-layer promotion test, zero-score floor edge
case); **mesh** (separate repo, waiting on Figma): faithful viewer adaptation +
threads-to-top, and it must migrate off the 17 old tool names per the CHANGELOG
table.

**Housekeeping:** there's an untracked exploration doc
`docs/explorations/2026-06-27-conscience-pass.md` (a decision-reconciliation
"conscience pass" run against this repo) — commit or discard as you see fit.

---

_Prior handoff content is superseded-and-stable: the **consolidated tool surface
+ TODO entity** (1.0.0), the **TODO viewer slice** (1.1.1), the **viewer
centering** arc (1.1.2–1.1.3, `D-p8bg`), the **frame-layers taxonomy arc**
(0.8.4–0.8.23), the **search-noise line** (0.8.11–0.8.14), the **graph-DB
transactional-swap publish** (`D-47xb`), and the **freshness signal +
auto-refresh** (`bbf0fce5`) all shipped, verified, and documented in
[`CHANGELOG.md`](CHANGELOG.md), [`docs/specs/progress.md`](docs/specs/progress.md),
[`docs/architecture/graph-storage.md`](docs/architecture/graph-storage.md), and
the decision store._

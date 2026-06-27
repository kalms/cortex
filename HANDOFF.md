# Cortex — Session Handoff

## ▶ NEXT — implement the durable-store migration runner (T-21 / D-b0kp)

**Status:** brainstormed → spec ✅ → plan ✅ → **implementation NOT started.** Pick
this up in a fresh session.

**Where the work lives:**
- Worktree **`../cortex-wt-migration`**, branch **`feature/db/migration-runner`**,
  based on `main` @ **1.2.0** (the merged todo-CLI release). `node_modules` +
  `bin/cortex-indexer` are already symlinked from the main checkout.
- **Spec:** [`docs/superpowers/specs/2026-06-27-durable-store-migration-runner-design.md`](docs/superpowers/specs/2026-06-27-durable-store-migration-runner-design.md)
- **Plan:** [`docs/superpowers/plans/2026-06-27-durable-store-migration-runner.md`](docs/superpowers/plans/2026-06-27-durable-store-migration-runner.md)
  (3 TDD tasks, no placeholders — ready to execute).
- **Decision** `D-b0kp` (fault-line + direction) and **TODO `T-21`** are in the
  Cortex graph; transition T-21 to `in_progress` when you start.

**What it is (one line):** a name-tracked migration runner for the durable
primitives DB (`~/.cortex/<repoId>/decisions.db`) so every store-opener (CLI +
MCP) converges, replacing flag-gated self-heal scattered across open-paths.

**Resume by:** running the plan with **subagent-driven-development** (fresh
subagent per task + review), as the todo-CLI branch was done. Tasks: (1)
`src/db/migrate.ts` runner, (2) `src/db/snapshot.ts`, (3) wire into
`openDecisionsDb` + remove scattered `migrateDecisionIdsToShortForm` calls + map
`MigrationError`→exit 4.

**Load-bearing design points (read the spec before relitigating):**
- Ledger = **`_cortex_migrations` applied-names table** (simonw/sqlite-migrate
  pattern), **not** `PRAGMA user_version`. Name-keyed → safe across parallel
  branches; per-migration applied-ness gap-fills the CLI miss by default.
- Migrations are **idempotent** and **own their atomicity**; the runner must
  **NOT** wrap them in an outer transaction — `migrateDecisionIdsToShortForm`
  toggles `PRAGMA foreign_keys`, a no-op inside a transaction.
- **graphImport stays out** (`migrateDecisionsFromGraphDb` needs the graph DB
  path; keep it at the MCP/index entry points).
- **Rehome UUID-fixture invariant:** id-short-form runs on the empty store's
  first open and is recorded, so it never rewrites later-inserted UUID ids.
  Dedicated integration test covers this — keep it green, don't weaken the
  migration.
- Snapshot only when a migration is **pending AND the store is non-empty**;
  retain last **3** under `<storeDir>/backups/`.

**Process reminders (lessons from the todo-CLI release this session):**
- **CI runs the FULL `tests/` suite** and gates on the **"CI gate"** check; run
  `vitest run` (not a subset) + `tsc --noEmit` before pushing. (A platform-only
  test — `sh` signal vs exit code — passed locally but failed CI last time.)
- **Re-check `main` hasn't moved before the release version bump** — it had, and
  caused a version-file/CHANGELOG conflict. Merge/rebase `main` first.
- Push via `gh auth setup-git` + explicit `https://github.com/ruevu/cortex.git`
  (no SSH key). **Never merge until the user has tested it themselves.**
- Release = patch bump `1.2.0 → 1.2.1` across `package.json` + `plugin.json` +
  `.claude-plugin/marketplace.json` + `CHANGELOG.md`, via PR.

---

## ⚠ NOTE — the "frames viewer layout lean" section below is likely STALE

The viewer-centering work shipped in **1.1.3** (PR #39, merged; decision
`D-p8bg` — fit-to-content centering + cloud keep-out) and is in `main` @ 1.2.0.
The section below predates that merge and its "1.1.3 OPEN / NOT merged" claim is
no longer true. Verify against `CHANGELOG.md` / `D-p8bg` before acting on it.

## ⚠ OPEN — frames viewer layout "lean" (deferred to a new session)

**Symptom.** The frames viewer's graph looks off-center — reported as leaning
left (and it's also bottom-heavy). Most visible on projects with many
non-ambient frames (e.g. `anthill-cloud`, and the `cortex-wt-vrecenter`
project).

**What shipped this session (partial, does NOT fully fix it):**
- **1.1.2 (PR #36, merged):** deterministic **horizontal** recenter of the
  **ambient** frame cloud's bounding box, stratify path only — `layoutFrames`
  in [`src/mcp-server/frame-layout.ts`](src/mcp-server/frame-layout.ts).
- **1.1.3 (PR #37, OPEN / NOT merged, CI green):** extends that recenter to the
  **vertical** axis. Branch `fix/layout/vertical-recenter`, worktree
  `../cortex-wt-vrecenter`. Decision **`D-vmhy`** (updated for both axes).
  ⚠ This is the ambient-only bbox approach below — reconsider before merging.

**Root-cause findings (the important part):**
- The **ambient** cloud IS centered by the bbox recenter (cortex measured
  x=499.8 / y=400.3). That part works.
- The remaining lean is the **non-ambient satellite frames** — placed by a
  *separate* routine, [`placeNonAmbientFrames`](src/mcp-server/floating-placement.ts)
  (+ a margin cascade), which the ambient recenter never touches. They sprawl
  unevenly.
- Measured on the `cortex-wt-vrecenter` project (21 frames): full-scene
  **centroid x = 437** (leans left ~63px) while full-scene **bbox x = 500**.
  The bbox reads "centered" only because one satellite (`api`) is flung to the
  far bottom-right corner, masking the imbalance. Mass distribution: **left
  third 8 / mid 9 / right 4**; bottom margin 0 (jammed against the bottom).
- **Key insight:** bbox-center ≠ centroid. The eye tracks the **centroid**
  (center of mass); a lone outlier fools any bbox-based centering. Ambient-only
  recenter is the wrong level — the fix belongs to the **full composed scene**.

**Approach already rejected by the user (don't just redo this):** a post-hoc
**full-scene centroid recenter** in `buildFrameMap`. User: "not an ideal
solution." The better direction is likely in **`floating-placement.ts`** —
distribute satellites more evenly around the centered ambient cloud and avoid
the lone-corner margin-cascade placement (the `api` outlier) — rather than a
post-hoc translate. Decide there in the new session.

**Separate, still-open layout issue (different problem):** the whole layout
**reshuffles on every reindex** — the d3-force seed is `SHA-256(frame records)`,
so any frame id/label/member-count change (and auto-reindex fires on every
commit) reseeds the chaotic sim → full relayout. Options noted earlier:
warm-start/anchor positions, reduce reindex churn, stable seed. Not started.

**Artifacts:** worktree `../cortex-wt-vrecenter` (branch
`fix/layout/vertical-recenter`, PR #37 open); a stale `npm run dev` server may
still hold :3334. `cortex` project on main is the centered baseline; switch the
viewer to `anthill-cloud` / `cortex-wt-vrecenter` to see the lean.

---

## ✅ DONE (2026-06-26 — 1.1.1: TODO viewer slice + unified layers menu)

Shipped **1.1.1** via the design → plan → subagent-driven TDD → review cycle.
TODO entities now render on the frames canvas (ambient yellow dots with state
treatment, hover pills, marginalia pills, decision→TODO `spawnsFrom` leader
lines, a record drawer, and a decision-drawer "Tasks" section) — mirroring the
decision render pipeline; decision rendering is byte-for-byte unchanged. The
viewer's `layers` menu is unified into one flat toggle list (frames / decisions /
todos / layer-tint); hiding `frames` suppresses only box chrome, leaving dots,
edges, and layout intact. Folded in the **GOVERNS qn-classification fix** (shared
`src/shared/classify-ref.ts`, checks `::` before `/`). Decision `D-kkz6`; full
suite 1366/1366; consolidated end-of-branch visual QA passed. Also amended the
workflow rule to batch Gate-0 visual QA by branch, not per task. Follow-ups in
NEXT STEP. Detail in [`CHANGELOG.md`](CHANGELOG.md).

## ✅ DONE (2026-06-24 — 1.0.0: consolidated tool surface + TODO entity foundation)

Shipped **1.0.0** via PR [#27](https://github.com/ruevu/cortex/pull/27) (merge
`1b9b378`) through the full design → plan → subagent-driven TDD → review → gated
release cycle. CI gate passed on the PR; worktree removed. **First major
version** — the per-release detail and the old→new tool migration table live in
[`CHANGELOG.md`](CHANGELOG.md); the architectural choices are decisions in Cortex
(`D-v2tc`, `D-r6xg`, `D-s72s`, `D-yb1b`, `D-87zb`).

- **Consolidated MCP tool surface (17 → 3).** `decision`, `pr`, and `todo` are
  now single, `action`-dispatched tools; the 17 old names (`create_decision`,
  `why_was_this_built`, `open_pr`, …) are **removed, not aliased** (clean break).
  Handler logic was extracted verbatim into `*Action` functions the dispatchers
  call — byte-parity contract tests guard that no behavior changed. `pr touch`'s
  inner `action` field is renamed `change`. This is field-report **P7(a)**.
- **TODO entity foundation** — the third user-authored primitive (future planned
  work). Durable storage in the primitives DB (`todos`/`todo_links`/`todos_fts`,
  `T-` ids, reusing the `id_sequences` mint), `TodoService` with a table-driven
  state machine (`open → in_progress → blocked → done/cancelled`), the `todo`
  MCP tool (`propose`/`get`/`list`/`search`/`update`/`link`/`transition`), and
  full HTTP-contract parity (`AdaptedTodo` + pure `api-todos.ts` adapter +
  `GET /api/todos` + drift-guarded `docs/api/todos.schema.json`). Shared
  `validatePrimitiveFields` across decisions + todos.
- **Verification:** full suite **1342/1342** green; dev-server smoke
  (`/api/health` + `/api/todos` → 200, `version:1`); Gate-1 review clean.

> ⚠ The MCP server only exposes the new `decision`/`pr`/`todo` tools after a
> restart (it loads `src/` once at startup). Old-name calls will fail until then.

**Prior release, still current:** **0.9.0** — the versioned, Zod-enforced HTTP
contract + hardening (field-report **P6**): single-source schemas in
`api-schemas.ts`, `version` on every response, freshness via `X-Cortex-Freshness`
+ `/api/freshness` + ETag/304, `/api/health`, env-gated hardening (loopback bind,
CORS allowlist, opt-in bearer auth, traversal guard). Decision `D-tszm`;
[onboarding](docs/architecture/http-api-contract.md).

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

**TODO viewer follow-ups (deferred from 1.1.1, non-blocking).** Standalone TODOs
with no governed frame don't render as ambient dots (no graph anchor — matches
decision behavior); and `withGovernedFramesRendered` promotes non-ambient
*decision*-governed frames but not TODO-governed ones (a todo governing a file in
a non-ambient frame won't render). Both are parity gaps, not regressions; see
decision `D-kkz6`.

**Parallel, non-blocking:** the **co-change lens** (`FILE_CHANGES_WITH` minus
structural edges = hidden coupling, as a sibling row in the layers menu); the
deferred 3b test follow-ups (multi-layer promotion test, zero-score floor edge
case); **mesh** (separate repo, waiting on Figma): faithful viewer adaptation +
threads-to-top, and it must migrate off the 17 old tool names per the CHANGELOG
table.

---

_Prior handoff content is superseded-and-stable: the **frame-layers taxonomy
arc** (0.8.4–0.8.23, classify → observe → enable → layout), the **search-noise
line** (0.8.11–0.8.14, P2), the **graph-DB transactional-swap publish** (`D-47xb`),
and the **freshness signal + auto-refresh** (`bbf0fce5`) all shipped, verified,
and documented in [`CHANGELOG.md`](CHANGELOG.md),
[`docs/specs/progress.md`](docs/specs/progress.md),
[`docs/architecture/graph-storage.md`](docs/architecture/graph-storage.md), and
the decision store._

# Cortex — Session Handoff

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

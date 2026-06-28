# Cortex — Session Handoff

## ▶ NEXT — reflex layer Plan 2 (edit-time block-once backstop)

**Reflex layer Plan 1 — study-time pre-edit briefing — merged in 1.2.2 (PR #42).**
`composeBriefing` keystone → `cortex brief <target>` CLI + `attachBriefing` on
`get_code_snippet`/`trace_path` (`briefAware` registerTool flag, mirrors freshness).
Gated by `CORTEX_BRIEF`/`CORTEX_BRIEF_FANOUT`; briefs only on **active** decisions,
picks the **worst** verdict. Decision `D-qemn`; design spec
`docs/superpowers/specs/2026-06-27-cortex-reflex-layer-design.md`.

**Plan 2 (NEXT — plan written, not started):** edit-time `PreToolUse` block-once
backstop on `Edit|Write|MultiEdit` — fires only on gated code not studied this
session. SessionStart **gate-cache** + session **briefed ledger** (studying disarms
it) + `hooks/brief-edit.sh`. TODO `T-nhmz`; plan
`docs/superpowers/plans/2026-06-27-cortex-reflex-layer-edit-backstop.md`. Branch off
`main`, subagent-driven. **Plan 3:** SessionStart onboarding headline (TODO `T-rm5w`).
**Tier 2/3 roadmap:** provenance chain `todo→decision→PR→code`, static×runtime fusion
via `ingest_traces`, CI-gate-as-conscience; cross-repo queries, viewer
"show-your-work", specialist subagents, graph-as-grader.

---

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

**Housekeeping:** the exploration doc
`docs/explorations/2026-06-27-conscience-pass.md` (a decision-reconciliation
"conscience pass" run against this repo) is now committed on `main`.

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

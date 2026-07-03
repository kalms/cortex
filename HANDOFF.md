# Cortex — Session Handoff

## ▶ NEXT — reflex layer Plan 3 (SessionStart onboarding headline)

**Reflex layer Plans 1 & 2 shipped.** Plan 1 (study-time pre-edit briefing) —
1.2.2 (PR #42): `composeBriefing` keystone → `cortex brief <target>` CLI +
`attachBriefing` on `get_code_snippet`/`trace_path` (`briefAware` flag), gated by
`CORTEX_BRIEF`/`CORTEX_BRIEF_FANOUT`, briefs only on **active** decisions (worst
verdict). Plan 2 (edit-time block-once backstop) — 1.2.3: `PreToolUse` block-once
on `Edit|Write|MultiEdit` for gated code not studied this session; SessionStart
gate-cache + session briefed-ledger (studying disarms it) + `hooks/brief-edit.sh`,
gate `CORTEX_BRIEF_BLOCK`. Decision `D-qemn`; see CHANGELOG 1.2.2 / 1.2.3.

**Plan 3 (NEXT — not started):** SessionStart onboarding headline. TODO `T-rm5w`.
**Tier 2/3 roadmap:** provenance chain `todo→decision→PR→code`, static×runtime fusion
via `ingest_traces`, CI-gate-as-conscience; cross-repo queries, viewer
"show-your-work", specialist subagents, graph-as-grader.

---

## ▶ NEXT STEP

In rough priority order:

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

**Layout reshuffle on reindex** (still open) is tracked as todo `T-g2pv` —
warm-start/anchor positions or a stable seed for `seedFromFrames`.

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

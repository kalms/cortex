# Cortex — Session Handoff

## ▶ NEXT — fix plugin MCP launch for plugin-install users (T-mskp)

Cortex installed as a Claude Code plugin fails to connect in ANY repo that is
not the cortex checkout. Two bugs (both must be fixed): (1) `.mcp.json` uses
`${CLAUDE_PLUGIN_ROOT:-$PWD}`, which Claude Code does not string-substitute
(it only substitutes the bare `${CLAUDE_PLUGIN_ROOT}` token), so bash expands
it to `$PWD` and execs a nonexistent `<cwd>/bin/cortex-mcp.sh`; (2) the plugin
cache `node_modules` lacks the compiled `better-sqlite3` native binary, so
`GraphStore`'s `new Database()` throws on boot. Fixes land in `.mcp.json`,
`bin/cortex-mcp.sh`, and the release/distribution pipeline. See TODO `T-mskp`
and the "Plugin Down Gotchas" field note.

**Reflex layer — all three plans SHIPPED.** Plan 1 (study-time pre-edit
briefing) — 1.2.2 (PR #42): `composeBriefing` → `cortex brief <target>` CLI +
`attachBriefing` on `get_code_snippet`/`trace_path`, gated by
`CORTEX_BRIEF`/`CORTEX_BRIEF_FANOUT`. Plan 2 (edit-time block-once backstop) —
1.2.3: `PreToolUse` block-once on `Edit|Write|MultiEdit` for gated code not
studied this session, gate `CORTEX_BRIEF_BLOCK`. Plan 3 (SessionStart
onboarding headline) — 1.3.0 (PR #48): sentinel-gated headline in
`hooks/check-index.sh` + `cortex code arch --headline`, gate `CORTEX_ONBOARD`
(TODO `T-rm5w`, closed). Decision `D-qemn`; see CHANGELOG 1.2.2 / 1.2.3 / 1.3.0.
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

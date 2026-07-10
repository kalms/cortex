# Cortex — Session Handoff

## ✅ Recently shipped

- **v1.4.8 — plugin MCP launch fix (`T-mskp`).** Cortex installed as a Claude
  Code plugin now connects in any repo, not just the cortex checkout. `.mcp.json`
  uses the bare `${CLAUDE_PLUGIN_ROOT}` token (Claude substitutes only the exact
  token, not the `:-default` form, and doesn't export it to the child env) with a
  `$PWD` fallback for the repo's own project-scoped load; `bin/cortex-mcp.sh`
  self-locates via `BASH_SOURCE` and self-heals a missing `better-sqlite3` binding
  on boot. Decision `D-b2wf`; verified in a real plugin install. Follow-up
  `T-xnyx` (ship vendored prebuilt binaries; self-heal is the current backstop).
- **Reflex layer — all three plans shipped.** Plan 1 study-time pre-edit briefing
  (1.2.2, PR #42), Plan 2 edit-time block-once backstop (1.2.3), Plan 3
  SessionStart onboarding headline (1.3.0, PR #48). Decision `D-qemn`;
  CHANGELOG 1.2.2 / 1.2.3 / 1.3.0.

---

## ▶ NEXT — in rough priority order

1. **TODO hooks + external bridge** — `PostMergeHook` auto-completing `resolvedBy`
   TODOs on PR merge; `PostDecisionHook` linking `spawnsFrom`; Linear/JIRA/GitHub
   mirroring (bidirectional sync is v1.5).
2. **Frame-quality + Louvain `concern` axis** (larger) — the upstream fix for
   fragmented/test-mixed clusters and the substrate-band core domain (`SRC·863`
   mega-frame), the ceiling the taxonomy observe phase repeatedly hit. Deferred
   in `D-8vbv`.
3. **Remaining agentic-experience items** (2026-06-12 field report): **P4**
   warm-path decision drafting, **P5** cross-repo decision search, **P7(b/c)**
   tighten tool descriptions / lazy-load the long tail, **P8** temporal
   `changes_since`. (P1/P2/P3/P6 shipped; P7(a) shipped in 1.0.0.)

**Tier 2/3 reflex roadmap:** provenance chain `todo→decision→PR→code`,
static×runtime fusion via `ingest_traces`, CI-gate-as-conscience; cross-repo
queries, viewer "show-your-work", specialist subagents, graph-as-grader.

## Open, non-blocking

- **Layout reshuffle on reindex** — todo `T-g2pv` (warm-start/anchor positions or
  a stable seed for `seedFromFrames`).
- **TODO viewer parity gaps** (deferred from 1.1.1) — standalone TODOs with no
  governed frame don't render as ambient dots (no graph anchor — matches decision
  behavior); `withGovernedFramesRendered` promotes decision-governed but not
  TODO-governed frames. See decision `D-kkz6`.
- **Co-change lens** — `FILE_CHANGES_WITH` minus structural edges = hidden
  coupling, as a sibling row in the layers menu.
- **Deferred 3b test follow-ups** — multi-layer promotion test, zero-score floor
  edge case.
- **mesh** (separate repo, waiting on Figma) — faithful viewer adaptation +
  threads-to-top; must migrate off the 17 old tool names per the CHANGELOG table.

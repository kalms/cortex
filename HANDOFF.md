# Cortex — Session Handoff

## ✅ Recently shipped

- **v1.7.0 — `show` tool: held focus spotlight (show-your-work slice 2a).**
  MERGED + TAGGED (PR #62 → `362dfc8`, released 2026-07-24). A `focus` verb
  holds a spotlight on refs (paths/qns/`D-`/`T-` ids) in the live viewer —
  targeted frames/decisions/todos lit, everything else dimmed, caption card
  describing the held state; clears on `Esc`, a replacing call, or
  `refs: []`. Live-only, canonical-repo gated. Decision `D-aqt6` (spotlight
  is held presentation state on the existing presence transport —
  explanations can't ride decaying telemetry). New `show-your-work` skill;
  `explain-architecture` spotlights while it explains. Rode along: two
  hand-test-found infra fixes — viewer static caching (`no-cache` HTML,
  immutable hashed assets; stale cached index.html previously 404'd its
  assets after a build swap → dead page) and a non-blocking font stylesheet
  (viewer no longer render-blocks on fonts.googleapis.com when DNS is
  down). Follow-up `T-7e5b` (hardening).
- **v1.6.0 — live presence in the viewer (show-your-work slice 1).** A
  `PostToolUse` hook streams agent activity (files studied/edited, symbols
  traced, decisions consulted) to `POST /api/presence` → event bus → WS;
  sessions render as colored avatars traversing the frame map with
  session-colored heat, layers-menu toggle, 30-min backfill for late-joining
  tabs. Decision `D-zwrt`; Gate-0 9/9 with epoch-guard hardening on the
  boot-vs-backfill race. Follow-ups `T-0a2g` / `T-pyx1`.
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

1. **Show-your-work slice 2b — stories.** Durable walkthroughs (S-ids in the
   decisions.db sidecar, story-mode UI with `‹ n/m ›` paging, `advance` verb)
   building on the 2a held-focus spotlight (`D-aqt6`); spec §1/§2/§5 + §7b in
   `.superpowers/specs/2026-07-23-show-your-work-design.md` (main checkout,
   gitignored). In-scope riders: **`T-bty4`** (user ask — caption-card refs
   become clickable chips via RefPill/drawerStack; onSpotlight already passes
   id arrays), `T-7e5b` (dispatcher default + refs bounds), `T-a1kg`
   (raw-cwd indexerProject lookup → "(no projects)" dropdown from worktree
   launches), and a possible focus-replay-on-WS-hello enhancement (discussed,
   not filed). Slice 3 (network layout) follows.
2. **TODO hooks + external bridge** — `PostMergeHook` auto-completing `resolvedBy`
   TODOs on PR merge; `PostDecisionHook` linking `spawnsFrom`; Linear/JIRA/GitHub
   mirroring (bidirectional sync is v1.5).
3. **Frame-quality + Louvain `concern` axis** (larger) — the upstream fix for
   fragmented/test-mixed clusters and the substrate-band core domain (`SRC·863`
   mega-frame), the ceiling the taxonomy observe phase repeatedly hit. Deferred
   in `D-8vbv`.
4. **Remaining agentic-experience items** (2026-06-12 field report): **P4**
   warm-path decision drafting, **P5** cross-repo decision search, **P7(b/c)**
   tighten tool descriptions / lazy-load the long tail, **P8** temporal
   `changes_since`. (P1/P2/P3/P6 shipped; P7(a) shipped in 1.0.0.)

**Tier 2/3 reflex roadmap:** provenance chain `todo→decision→PR→code`,
static×runtime fusion via `ingest_traces`, CI-gate-as-conscience; cross-repo
queries, specialist subagents, graph-as-grader. Viewer "show-your-work":
slice 1 (presence) SHIPPED in 1.6.0 (`D-zwrt`); slice 2a (held focus spotlight
/ `show` tool) SHIPPED in 1.7.0 (`D-aqt6`); slice 2b (stories — durable
walkthroughs building on focus; hardening todo `T-7e5b` rides along) and
slice 3 (network layout) are NEXT-queue candidates.

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

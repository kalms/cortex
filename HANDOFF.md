# Cortex — Session Handoff

## ✅ Recently shipped

- **v1.8.1 — agentic-experience followups (field-report P4/P5/P8; P7 closed).**
  The last items from the 2026-06-12 field report, each re-judged against the
  current codebase before implementation:
  - **P5 (as planned):** `decision({action:"search", cross_repo:true})` fans
    out over the registry, grouped-per-repo hits + `skipped` (no cross-DB rank
    merge — FTS5 rank isn't comparable). `T-4sbr`.
  - **P4 (amended):** no server-side drafting (Cortex has no LLM; drafts are
    proposed-only per `D-vz80`) — instead `candidates` gained `base` (branch
    scoping: `base..HEAD` commits, diff-touched docs) and suggest-capture
    became a merge-aware drafting trigger (`candidates base:"HEAD^1"` →
    `propose author:"cortex:draft"` → user ratifies). `T-51f1`.
  - **P8 (amended down, large→medium):** lean `changes_since(since, scope?)`
    — since = ref | ISO date | decision id; returns commits + affected graph
    nodes + decisions created/reconciled/governing-changed. TS-side. `T-nq4m`.
  - **P7(b/c) closed without code:** descriptions already tight post-1.0.0;
    host-side deferred MCP schema loading (Claude Code ToolSearch) made
    server-side lazy-loading moot. `T-v9w3` cancelled with rationale.

- **v1.8.0 — durable stories (show-your-work slice 2b).** MERGED + TAGGED
  (PR #63 → `0b47b32`, released 2026-07-25). `show` gains
  `story|advance|get|list|close|delete`: stories are `S-xxxx` entities in the
  decisions.db sidecar (`stories`/`story_steps`/`story_links`, atomic create,
  1-based steps) returned with a `viewer_url`; `advance` rides the 2a
  delivery path as a **`show.advance`** event (deliberate deviation from the
  spec's `story.advance` — rides the `show.%` reap + live-only namespace).
  Viewer story mode: deep link / ⌘K stories group / live advance (never
  auto-opens on load), per-step held spotlight + camera fit + emphasis-edge
  pulses, theme-INVERTING story card (yellow/black in dark mode, dark
  translucent in light, black nav pills, clickable `esc` pill — user design),
  **user-wins pacing** (`following`/`agentStep` + "agent is on step N →"
  chip). `T-bty4` chips on both caption cards; `T-7e5b` + `T-a1kg` fixed.
  Decision `D-wn74` (links `D-aqt6`/`D-zwrt`). Demo story `S-50vj` lives in
  the sidecar — its refs resolve now that the graph is reindexed post-merge.
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

1. **Show-your-work slice 3 — network layout mode.** The last slice of the
   approved design: `organic ⇄ network` toolbar toggle, six horizontal layer
   bands (interface → orchestration → domain → data → infrastructure →
   ceremony), server-side pure `network-layout.ts` at the `buildFrameMap`
   call site (band assignment from per-frame layer + barycenter ordering,
   two deterministic sweeps), dual `pos`/`network_pos` in `/api/frames` +
   `/api/aggregates`, ~600 ms position lerp on toggle, upward-edge warning
   tint, story steps honor `layout_hint` (already stored/served by 2b; the
   viewer currently ignores it). Spec §6 in
   `.superpowers/specs/2026-07-23-show-your-work-design.md` (main checkout,
   gitignored). Known engine note from the 2b final review: `fitToFrames`
   doesn't re-fit on window resize — worth folding into the layout work.
   Open idea, still unfiled: focus/story-replay-on-WS-hello.
2. **TODO hooks + external bridge** — `PostMergeHook` auto-completing `resolvedBy`
   TODOs on PR merge; `PostDecisionHook` linking `spawnsFrom`; Linear/JIRA/GitHub
   mirroring (bidirectional sync is v1.5).
3. **Frame-quality + Louvain `concern` axis** (larger) — the upstream fix for
   fragmented/test-mixed clusters and the substrate-band core domain (`SRC·863`
   mega-frame), the ceiling the taxonomy observe phase repeatedly hit. Deferred
   in `D-8vbv`.
4. ~~Remaining agentic-experience items~~ — SHIPPED in 1.8.1 (P4/P5/P8
   implemented as amended, P7(b/c) closed; see Recently shipped). The
   2026-06-12 field-report line is now fully closed.

**Tier 2/3 reflex roadmap:** provenance chain `todo→decision→PR→code`,
static×runtime fusion via `ingest_traces`, CI-gate-as-conscience; cross-repo
queries, specialist subagents, graph-as-grader. Viewer "show-your-work":
slice 1 (presence) SHIPPED in 1.6.0 (`D-zwrt`); slice 2a (held focus
spotlight) SHIPPED in 1.7.0 (`D-aqt6`); slice 2b (stories) SHIPPED in 1.8.0
(`D-wn74`); slice 3 (network layout) is the remaining NEXT-queue candidate.

## Open, non-blocking

- **Viewer fonts blocked by CSP** — todo `T-aap4`: the v1.7.0 non-blocking
  font pattern's inline `onload` is blocked by `script-src 'self'`, so the
  served viewer always renders fallback fonts (and logs a console error on
  every load). Move the media-swap into the bundle or hash-allow it.
- **tests/api registry flake** — todo `T-zkfx`: route suites open the real
  XDG registry; parallel WAL init races throw "database is locked". Add a
  `CORTEX_REGISTRY_DB` test override.
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

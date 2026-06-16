# Cortex v0.3 — Progress Assessment

_Assessment date: 2026-06-16 — refreshed after the **frame-layers taxonomy arc
completed both enable slices (3a + 3b) and the full layout slice (parts 1 + 2)**: 0.3.4
classify+observe · 0.3.5 deterministic dots · 0.3.6 docs · **0.3.7** observe-phase
polish · **0.3.8** earnable domain · **0.3.9/0.3.10** kind-weight ranking
(default-on) · **0.3.19/0.3.20** layer-diversity (default-on) · **0.3.21/0.3.22**
layer-adjacency layout force (default-on) · **0.3.23** floating-entity placement
— all on top of the 0.3.0 cut
(native-indexer split, frame ranking Path 1, frame-coverage retune,
reconciliation engine). Derived from the live Cortex graph, the v0.3 design
corpus in [`docs/specs/cortex-v0.3/`](cortex-v0.3/), and the source tree._

Version metadata is consistent: `package.json`, `plugin.json`, and
`.claude-plugin/marketplace.json` are all `0.3.9`. **Numbering note:** the feature
line this document once labelled "0.3.5" (TODO entity, floating-entity placement,
record drawer for TODOs) was renumbered **0.3.6+**; the 0.3.6–0.3.9 releases went
to the taxonomy follow-up (docs, then the observe→enable slices) instead, so the
TODO line is now best read as **post-taxonomy** (see Future).

The shorthand: **0.3.x ships the structural / data / provenance half of v0.3 —
the decision-provenance system (storage, multi-project routing, cold-start
seeding, flag-gated reconciliation), the frame pipeline (ranker + gravity layout
+ coverage reclamation + the layer classifier, now **earnable-domain** + a
flag-gated **kind-weight** ranking effect), the 2D frames viewer (layers lens,
fully deterministic rendering), and the native-indexer split. The "multiplayer
canvas" half is descoped: the scenario DSL and the multiplayer canvas chrome
(merge animation, agent cursors) are NOT pursued; the remaining single-player
items (the TODO entity, floating-entity placement, and adopting the existing
record drawer for TODOs) are deferred to post-taxonomy.**

---

## Shipped

| Spec area | Status | Evidence |
|---|---|---|
| **Frame extraction pipeline** | ✅ Shipped | [`src/frame-extraction/`](../../src/frame-extraction/) — `cluster-tfidf-hdbscan.ts` + `python/tfidf_hdbscan.py`, `co-change.ts`, `auxiliary-detection.ts`, `path-tokenize.ts` + `structural-tokens.ts` (framework-aware tokenisation), `text-blob.ts` (two content streams), `inject-frames.ts` + `run-frames.ts` (graph integration), `eval-gate.ts`. Surfaced via `code-tools.ts::withFrames` and the CLI. |
| **Pipeline empirical comparison** | ✅ Done — 1 of 3 survived | Eval harness ([`scripts/frame-extraction/`](../../scripts/frame-extraction/): `eval-all.ts`, `corpus.json`, `baselines/`) and `types.ts` (`ClusterResult.algorithm`) anticipate `tfidf+hdbscan \| embedding+hdbscan \| leiden`. Only **tfidf+hdbscan** was built; Leiden and pinned-embedding clusterers were never implemented. The comparison resolved to one winner. |
| **PR data model + tools** | ✅ Shipped (data only) | [`src/prs/service.ts`](../../src/prs/service.ts), [`src/prs/types.ts`](../../src/prs/types.ts) (`OpenPRInput` with `introduces_frame`, `additions`, `external_ref`). MCP tools `open_pr` / `add_pr_touch` / `merge_pr` / `get_pr`. Matches spec §4 schema. **Not rendered on canvas** (spec said so explicitly). |
| **Decision proposal / supersession tools** | ✅ Shipped | `propose_decision`, `supersede_decision`, `promote_decision`, `link_decision`; [`src/decisions/promotion.ts`](../../src/decisions/promotion.ts), `cli/commands/decision.ts::cmdPropose`. |
| **2D frames viewer** | ✅ Shipped | [`src/viewer/`](../../src/viewer/) — `adapters.js` (`groupNodesIntoFrames`, `frameCoverage`), `data-fetch.js`, `viewer.js`, wired to `/api/graph` / `/api/projects` / `/api/decisions` / `/api/frames`. The temporary client-side `layout.js` grid was retired in favour of the server-computed force layout (see below). |
| **Reconciliation engine** (derived decision state) | ✅ Shipped (flag-gated) | Agent-delegated reconciliation behind `CORTEX_RECONCILE` (default off in v1). Working-tree (not HEAD) source hash in [`src/decisions/reconciliation.ts`](../../src/decisions/reconciliation.ts); `record_reconciliation` / `pending_reconciliations` tools ([`src/mcp-server/tools/reconciliation-tools.ts`](../../src/mcp-server/tools/reconciliation-tools.ts)); on-read drift block + derived `display_state` in `get_decision` / `why_was_this_built` ([`src/mcp-server/reconciliation-attach.ts`](../../src/mcp-server/reconciliation-attach.ts)); `cortex reconcile status` CLI and SessionStart banner. Design: [`docs/superpowers/specs/2026-06-08-decision-reconciliation-engine-design.md`](../superpowers/specs/2026-06-08-decision-reconciliation-engine-design.md); plan: [`docs/superpowers/plans/2026-06-08-decision-reconciliation-engine.md`](../superpowers/plans/2026-06-08-decision-reconciliation-engine.md). |
| **Frame ranking — Path 1** (taxonomy-free ranker + gravity layout) | ✅ Shipped | Deterministic budget-cut ranker (`score = nameability × structural_weight`, ambient budget `max(4,min(10,⌈n·0.7⌉))`) in [`src/frame-extraction/frame-ranker.ts`](../../src/frame-extraction/frame-ranker.ts); symbol→file→frame edge rollup [`src/mcp-server/frame-pair-rollup.ts`](../../src/mcp-server/frame-pair-rollup.ts); deterministic d3-force layout (mulberry32+SHA-256 seed, 300 iters, integer quantize, AABB collision-relaxation tail) [`src/mcp-server/frame-layout.ts`](../../src/mcp-server/frame-layout.ts); orchestrated by [`src/mcp-server/frame-map.ts`](../../src/mcp-server/frame-map.ts) behind `/api/frames`; viewer consumes it (grid retired). Decision `D-pzc8`. Design: [`docs/superpowers/specs/2026-06-08-frame-ranking-path1-design.md`](../superpowers/specs/2026-06-08-frame-ranking-path1-design.md); plan: [`docs/superpowers/plans/2026-06-09-frame-ranking-path1.md`](../superpowers/plans/2026-06-09-frame-ranking-path1.md). |
| **Frame coverage** (min_samples retune + graph reclamation) | ✅ Shipped | HDBSCAN `min_samples` exposed + defaulted to 1 (was implicitly `min_cluster_size`=5 → ~70% noise), gated by the label-quality F1 harness; pure `reclaimNoise` assigns residual noise files to their most-connected cluster via CALLS/USAGE/IMPORTS rollup, marked `reclaimed` so the ranker scores nameability on the topical core. [`src/frame-extraction/frame-reclamation.ts`](../../src/frame-extraction/frame-reclamation.ts), `cluster-tfidf-hdbscan.ts` + `python/tfidf_hdbscan.py`, `run-frames.ts`. **Measured on the Cortex graph: semantic-file coverage 29% → 88%** (noise 282 → 49). Decision `D-b0rq`. Design: [`docs/superpowers/specs/2026-06-09-frame-coverage-design.md`](../superpowers/specs/2026-06-09-frame-coverage-design.md); plan: [`docs/superpowers/plans/2026-06-09-frame-coverage.md`](../superpowers/plans/2026-06-09-frame-coverage.md). |
| **Native indexer split** (own repo + prebuilt binary) | ✅ Shipped | The C indexer was extracted to **`ruevu/cortex-indexer`** (own CI build/test/release matrix); cortex now consumes a **prebuilt binary** fetched at `postinstall` ([`scripts/fetch-indexer.mjs`](../../scripts/fetch-indexer.mjs)) from a GitHub release pinned by `CORTEX_INDEXER_VERSION` ([`src/indexer/version.ts`](../../src/indexer/version.ts)), checksum-verified + cached, with a lazy runtime version guard `ensureIndexer()` ([`src/indexer/binary.ts`](../../src/indexer/binary.ts)). `internal/indexer/` + `build-indexer.sh` removed; cortex history rewritten to sever the `codebase-memory-mcp`/CBM fork lineage. cortex is now pure TypeScript/MCP. Decision `D-chfd`. Released `cortex-indexer` **v0.3.0** (darwin-arm64, linux-x64, linux-arm64). |
| **Decision record drawer** (decisions) | ✅ Shipped | The focused-frame governance pill + decision card/marginalia in the 2D viewer ([`src/viewer/viewer.js`](../../src/viewer/viewer.js) `renderDecisionCard`, `/api/decisions/:id`) **is** the record drawer for decisions. Project-scoped per the viewer multi-project fix (`openProjectDecisions`, `D-edf7`); decision-governed frames the ranker left non-ambient are promoted so their decisions always render (`withGovernedFramesRendered`, `D-xwxj`). Adopting the same drawer for the TODO entity is deferred to 0.3.6+. |
| **Frame layers — taxonomy milestone 1** (classify + observe) | ✅ Shipped (0.3.4) | Deterministic 6-layer classifier ([`src/frame-extraction/frame-kind.ts`](../../src/frame-extraction/frame-kind.ts)): agreement-based combination of directed graph position ([`frame-flow-rollup.ts`](../../src/mcp-server/frame-flow-rollup.ts) fan-in/fan-out), curated path patterns, and content signals; `layer` rides every `/api/frames` entry; viewer `layers` toolbar menu (switch + the only legend) with a quiet per-layer tint — off (default) is pixel-identical. Internals (confidence/contributions) never serialize (negative test). Regression net: frozen cortex fixture + hand-labeled `anyOf` expectations ([`expected-layers.test.ts`](../../tests/frame-extraction/expected-layers.test.ts)) — caught two classifier bugs pre-merge. **Ranking and layout deliberately untouched** (classify → observe → enable). Decisions `D-qn7z`, `D-24p0`, `D-b1gd`; [design spec](../superpowers/specs/2026-06-12-frame-layers-taxonomy-design.md). |
| **Deterministic viewer rendering** | ✅ Shipped (0.3.5) | Dot placement moved from `Math.random` to a jitter-bounded grid (cell from member index, jitter seeded from file path via fnv1a + mulberry32); decision anchor dots seeded the same way. No two dots can render coincident (which faked "duplicate edges" to one target), and the same graph renders byte-identical screenshots across reloads — the last `Math.random` is out of the render data path. |
| **Frame layers — observe-phase polish** | ✅ Shipped (0.3.7) | Handler-suffix orchestration signal (Nitro/h3 `api/routes/*.{get,post,…}.ts` → orchestration, `W_HANDLER`=`W_PATH`, route-dir-scoped, case-insensitive); ceremony tint separated from infrastructure (warm taupe — the cool grays were indistinguishable at lens alphas); legend swatches single-sourced from `LAYER_RGB`; internal `fallback` flag distinguishing pure-fallback domain from within-pair ties in the eval report; regression fixture regenerated to the 17-frame graph + a coverage guard (every named frame must have a hand label). Decision `D-gbqj`. |
| **Frame layers — earnable domain** | ✅ Shipped (0.3.8) | `domain` was only ever reached by fallback; now runtime code in the silent middle sink band *earns* it via an **earned-fallback** residual (`W_DOMAIN_RUNTIME`=0.5, ~80% runtime bar), applied only when no layer-specific source clears `MIN_SIGNAL` so any real signal still wins. Corpus-validated ([`scripts/frame-extraction/eval-layers.ts`](../../scripts/frame-extraction/eval-layers.ts), 11 repos): earns domain on 8/11 (TS/Vue/React/Nuxt/Python/Django); cortex earns none (its clusters co-locate tests with subjects → the frame-quality ceiling, not a defect). Decision `D-8vbv`; [design](../superpowers/specs/2026-06-13-earnable-domain-signal-design.md). |
| **Search ranking — `search_graph` (field report P2)** | ✅ Shipped (0.3.11–0.3.12) | Pure ranker [`src/graph/node-ranker.ts`](../../src/graph/node-ranker.ts) (`KIND_WEIGHT × nameMatchQuality`, exact>prefix>substring, deterministic tie-break → stable pagination); doc/plan `section` nodes excluded from name/qn results by default (opt in via new `kinds` param), `limit`/`offset` pagination, `showing A–B of N · K section nodes suppressed` header. Pure render/clamp [`search-format.ts`](../../src/mcp-server/tools/search-format.ts) + `countSuppressedSections`. 0.3.12 scoped the suppression note to the default filter and documented the match syntax in [`docs/mcp-tools.md`](../mcp-tools.md). Decision `D-fq9g`; [design](../superpowers/specs/2026-06-14-search-graph-ranking-design.md). |
| **Shared code_search engine — `cortex code search`/`find`** | ✅ Shipped (0.3.12–0.3.13) | `cortex code find` brought to parity with `search_graph` (ranked, section-excluded, `--kind`/`--limit`/`--offset`). `cortex code search` re-pointed off the indexer binary's capped/doc-biased `search_code` onto a shared ripgrep engine [`src/graph/code-search.ts`](../../src/graph/code-search.ts) (`runCodeSearch` + `rankSearchHits`) that the MCP `search_code` tool also wraps (**output byte-identical**); CLI ranks **code-first** so markdown hits no longer dominate (the "only .md" report). `clampLimit`/`clampOffset` moved to [`search-params.ts`](../../src/graph/search-params.ts) to keep the CLI off the mcp-server layer. Decision `D-qfz9`; [design](../superpowers/specs/2026-06-14-shared-code-search-engine-design.md). |
| **`prefer-cortex` hook over-match fix** | ✅ Shipped (0.3.14) | The Bash branch strips quoted string literals before probing for a command-position search tool, so `git commit -m "…grep…"` / `echo "rg …"` are no longer denied as code searches; real code searches keep the tool word unquoted and still redirect, and scope detection still runs against the original command. +4 tests. (Distinct from field-report **P3**, the cross-repo target-aware hook, which remains open.) |
| **Frame layers — kind-weight ranking (enable slice 3a)** | ✅ Shipped (0.3.9) | `score ×= kind_weight` (earned domain 1.00 / interface 0.90 / orchestration 0.85 / data 0.75 / infra 0.55 / **fallback-domain 0.50** / ceremony 0.20), behind `CORTEX_KIND_WEIGHT` **default off (inert — ranking byte-identical when off, enforced by test)**. The ranker stays pure: `kind_weight` is a plain number on `FrameRecord` (omitted ≡ 1); the table (`KIND_WEIGHT`/`kindWeight` in [`frame-kind.ts`](../../src/frame-extraction/frame-kind.ts)) + flag live at the call site, where [`frame-map.ts`](../../src/mcp-server/frame-map.ts) now classifies before ranking and reads `fallback` only to pick the weight (never serialized). Corpus observe: evicts ceremony/config noise, tilts ambient to narrative layers, fallback-domain demotion works, no junk leapfrogging. Decision `D-g4qb`; [design](../superpowers/specs/2026-06-13-kind-weight-enable-slice-design.md). |

---

## Deferred to post-taxonomy (the single-player line — renumbered out of 0.3.5)

The remaining single-player items, sequenced **after the taxonomy arc**
(enable-3b → layout → frame-quality; see Future below), which build directly
on the shipped layer foundation:

| Spec area | Status | Notes |
|---|---|---|
| **TODO entity** | ⏭ post-taxonomy | [`todo-entity.md`](cortex-v0.3/todo-entity.md): schema, state machine, tools, and external bridge. No code yet. The headline feature of this line. |
| **Floating-entity placement** (non-ambient frames + aggregates) | ✅ Shipped (0.3.23) — layout slice part 2 | A pure server-side **gravity-centroid** pass ([`floating-placement.ts`](../../src/mcp-server/floating-placement.ts)) runs after the (byte-identical) ambient force-sim: non-ambient frames settle at the pair-weighted centroid of the ambient frames they connect to; auxiliary aggregates via an **edge→path→margin** tie cascade ([`aggregate-ties.ts`](../../src/mcp-server/aggregate-ties.ts)); one-directional frame-repulsion keeps satellites out of unrelated frames. Positions ship via `/api/frames` + `/api/aggregates`; the viewer renders satellites de-emphasized and **both fixed strips are removed**. Governance selection stays client-side, position comes from the server — **supersedes the `D-xwxj` stopgap**. Pass depends only on (ambient positions + ties) → future network layout mode composes on top (seam documented). Gate 0: satellites + aggregates placed near related frames, 0 console errors. [Design](../superpowers/specs/2026-06-16-floating-entity-placement-design.md). |
| **Record drawer — adopt for TODO** | ⏭ post-taxonomy | The record drawer already ships for decisions (see Shipped). Reuses the same drawer for the TODO entity once TODOs exist. |

## Removed from scope

The "multiplayer canvas" half of the v0.3 design corpus is **not being pursued**:

| Spec area | Status | Notes |
|---|---|---|
| **Multiplayer-test mode / scenario DSL** | ✖ Removed | Spec §9.3 TS scenario runner. Dropped — not pursuing a multiplayer test harness. |
| **Multiplayer canvas chrome** (merge animation, agent cursors) | ✖ Removed | Live in `cortex-frames-prototype-v5.html` only. The shipped viewer is the single-player frames/decisions canvas; the realtime multi-agent surface is not pursued. |

## Taxonomy follow-up — classify → observe → enable (arc nearly complete)

| Spec area | Status | Notes |
|---|---|---|
| **Layer classifier + lens (milestone 1)** | ✅ Shipped (0.3.4) | The `FrameKind` classifier + viewer lens, zero ranking/layout effect. |
| **Observe phase** | ✅ Done (0.3.7–0.3.8) | Validated on cortex + anthill, then corpus-wide (11 repos via `eval-layers.ts`). Findings drove three fixes that shipped: handler-orchestration signal, ceremony/infra palette separation, and the **earnable-domain** resolution to the contested `domain` fallback (`D-8vbv`). The watch-list frames are settled; `frame-extraction` fragmentation + `contracts`-via-fallback are recorded as the upstream **frame-quality** ceiling. |
| **Enable slice 3a — kind-weight** | ✅ Shipped (0.3.9) + **default-on (0.3.10)** | `score ×= kind_weight` (default off in 0.3.9, **flipped ON in 0.3.10** after the positive observe verdict — `CORTEX_KIND_WEIGHT` is now an opt-out, `"0"` restores pre-slice ranking). The `domain`-is-both-fallback-and-top-weight trap (`D-qn7z`) is resolved by the earned/fallback split (1.00 / **0.50**). Corpus-validated; Gate 0 confirmed clean render on default-on. Decision `D-g4qb`. |
| **Enable slice 3b — layer-diversity** | ✅ Shipped (0.3.19) + **default-on (0.3.20)** | The `× diversity` term as a new pure module [`frame-diversity.ts`](../../src/frame-extraction/frame-diversity.ts) (`selectAmbientByDiversity`) consumed in `buildFrameMap` — the ranker stays layer-free. Two-phase greedy: Phase 1 fills the budget by effective score `score × 0.6^k` (geometric repeat-decay) with a ceremony cap (≤1, relaxed only to avoid an empty canvas); Phase 2 **bounded coverage repair** guarantees ≥1 of domain/interface/data when present by promoting the missing layer's best frame over the weakest safely-displaceable one, but only above a `0.5 ×` floor (the `D-qn7z` junk-leapfrogging guard). Stateful (depends on what's already selected), so it's a selection step, not a static factor. **Observe verdict POSITIVE** (corpus `eval-layers` diversity off-vs-on): collapses redundant interface and surfaces domain/data on interface-heavy repos (vueuse interface 7→4 / data 1→3, nuxt/ui 2 layers → 5, saleor interface 7→3 +data, rubygems re-surfaces a domain frame), ceremony cap held everywhere, no junk promoted on coverage alone, neutral on already-diverse/tiny repos. **Flipped ON in 0.3.20** — `CORTEX_LAYER_DIVERSITY` is now an opt-out (`"0"` restores the kind-weighted-only ambient set); Gate 0 confirmed a clean default-on render. Decision `D-wvsz`; [design](../superpowers/specs/2026-06-15-layer-diversity-enable-slice-design.md). |
| **Layout slice — layer-adjacency force** (part 1) | ✅ Shipped (0.3.21) + **default-on (0.3.22)** | A vertical `forceY(yTarget(sink))` in [`frame-layout.ts`](../../src/mcp-server/frame-layout.ts) stratifies ambient frames surface→substrate on the proven d3-force base (pair-link clustering / charge / collide-AABB tail unchanged). Position is **measured** — `yTarget = lerp(top, bottom, sink)` from each frame's `fanIn/(fanIn+fanOut)` (per-layer `NOMINAL_SINK` fallback for flowless frames) — not categorical bands. Layout stays layer-agnostic (sink is a plain number); `frame-map.ts` reads `CORTEX_LAYER_LAYOUT` (**now an opt-out, default on**; `"0"` restores pre-slice layout) + computes effective sink; `forceCenter`→horizontal-only `forceX` only when stratifying. Byte-identical when off (golden-tested); deterministic. **Observe (0.3.22): positive corpus-wide** — Spearman(y, sink) mean ≈ 0.77, median ≈ 0.74, range 0.51–0.95, no negative/near-zero on any archetype (metric under-states the true effect via flowless-frame dilution). Gate 0 re-confirmed default-on: spread y 118→593 over an 800-tall stage, ceremony at substrate, 0 console errors. Decision `D-marq`; [design](../superpowers/specs/2026-06-16-layer-adjacency-layout-force-design.md). **Part 2 (floating-entity placement) shipped 0.3.23.** |
| **Cross-cutting concern axis** (graph communities) | ◑ Candidate / deferred | The reserved `FrameKind.concern` axis. Also the only signal that would rescue **substrate-band core domain** (heavily-imported product cores that read topologically as substrate — anthill's `dsl/compiler` at sink 0.83, cortex's 23-member `frame-extraction`), which the earnable-domain middle-band signal deliberately can't reach. Measured 2026-06-12: import-graph communities confirm the shipped clustering's cores and surface cross-cutting subsystems (e.g. a 13-file freshness community across 5 frames). `ctx_louvain` exists in cortex-indexer but is dead code (test-only, single-level); wiring it would need a Leiden-grade upgrade. Explicitly deferred in `D-8vbv` ("walk before run"). |

---

## Decision schema vs. spec §3

[`src/decisions/db.ts`](../../src/decisions/db.ts) persists
`problem` / `resolution` / `rationale` / `alternatives` / `author` / `provenance`
plus a generic `decision_links` table (handles `governs` / `supersedes` /
`relatedTo` / PR refs as typed links).

**Gaps:**
- No `validatedBy` / `observedImpact` (evidence) fields.
- `status` is stored, but a **derived `display_state`** now layers on top of it:
  the reconciliation engine detects working-tree source-hash drift and the agent
  judges whether the decision's prose still matches the code, projecting
  `match`/`partial`/`drift` into `active` / `active · drifting` / `stale`
  (shipped flag-gated behind `CORTEX_RECONCILE`).

---

## Known issues

- ~~**Viewer DB resolution can serve a stale map (`graph.db` shadows `.cortex/db`).**~~
  **RESOLVED 2026-06-10:** `resolveGraphDbForRead` now prefers an openable
  `.cortex/db` over a stale legacy `graph.db` (`f1950d3`, part of the
  transactional-swap merge, decision `D-47xb`).
- ~~**`contracts` index step fails (`database disk image is malformed`).**~~
  **RESOLVED 2026-06-10:** root cause was the out-of-band `fopen("wb")`
  truncate-rewrite under the server's open WAL handle; fixed by the
  staging-build + transactional-publish write path (`publishStagedDb`,
  decision `D-47xb`).
- **Dev reload (still live):** the MCP server (`cortex-local`, `directory`
  source → the repo, so it runs **live `src/`**) loads modules once at startup —
  it does **not** hot-reload. After merging changes, restart the MCP server /
  Claude Code before reindexing or before expecting new read-time behavior
  (e.g. the `layer` field on `/api/frames` only appears after a restart).
  Bit again 2026-06-12: the plugin server on :3333 served pre-layers code all
  day; `npm run dev` (:3334) was used for Gate-0 QA instead.

## Recommended next step

The taxonomy follow-up is essentially complete — classify + observe + enable-3a
(incl. **default-on**, 0.3.10) + **enable-3b** (layer-diversity, 0.3.19, **flipped
default-on in 0.3.20**) + the **full layout slice**: part 1 (layer-adjacency force,
0.3.21, **default-on in 0.3.22**, Spearman(y, sink) mean ≈ 0.77) and part 2
(**floating-entity placement, 0.3.23** — gravity-centroid for non-ambient frames +
aggregates, both fixed strips removed, `D-xwxj` superseded) are all shipped:

1. **Frame-quality + Louvain `concern` axis** (now the headline build item, larger):
   the upstream fix for fragmented/test-mixed clusters and substrate-band core
   domain — the ceiling the observe phase repeatedly hit (`SRC·863` mega-frame).
2. Optional **layout observe pass** for centroid quality + a future **network /
   layered layout mode** (the placement seam is ready: a base layout strategy
   behind the position contract, with floating placement composing on top).
3. Then the **post-taxonomy line**: TODO entity (schema → tools → drawer
   adoption) as the headline, record-drawer adoption for TODOs.

Smaller deferred 3b test follow-ups still stand (non-blocking, measure-zero under
geometric decay): a multi-layer simultaneous-promotion test and a zero-score
floor edge case.

Parallel candidates that don't block the arc: the **co-change lens**
(`FILE_CHANGES_WITH` minus structural edges = hidden coupling, rendered as a
sibling row in the layers menu — measured 2026-06-12), and the remaining
**agentic-experience P1–P8 plan** from the
[2026-06-12 field report](../field%20reports/field-report-2026-06-12-mesh-m1-platform-consumer.md).
**P2 (search ranking) shipped** (0.3.11–0.3.13, decisions `D-fq9g`/`D-qfz9`);
still open: **P3 target-repo-aware grep hook** (the cross-repo blind spot —
distinct from the 0.3.14 quoted-word over-match fix), `context_pack` (P1), and
the versioned HTTP contract + freshness header (P6 — gates Mesh's
viewer-adaptation milestone).

**Housekeeping:** `vercel/commerce` silently fails the Python clustering step
(exit 1) and drops out of every corpus eval — worth a standalone look.

_See [HANDOFF.md](../../HANDOFF.md) for the session-level handoff._

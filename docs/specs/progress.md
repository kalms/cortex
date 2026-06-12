# Cortex v0.3 — Progress Assessment

_Assessment date: 2026-06-13 — refreshed after **frame layers taxonomy
milestone 1** (0.3.4: classify + observe) and the **deterministic dot
placement** fix (0.3.5) landed on top of the 0.3.0 cut (native-indexer split,
frame ranking Path 1, frame-coverage retune, reconciliation engine). Derived
from the live Cortex graph, the v0.3 design corpus in
[`docs/specs/cortex-v0.3/`](cortex-v0.3/), and the source tree._

Version metadata is consistent: `package.json`, `plugin.json`, and
`.claude-plugin/marketplace.json` are all `0.3.5`. **Numbering note:** `0.3.5`
was consumed by a viewer patch release; the feature line this document
previously labelled "0.3.5" (TODO entity, floating-entity placement, record
drawer for TODOs) is renumbered **0.3.6+** below.

The shorthand: **0.3.x ships the structural / data / provenance half of v0.3 —
the decision-provenance system (storage, multi-project routing, cold-start
seeding, flag-gated reconciliation), the frame pipeline (ranker + gravity layout
+ coverage reclamation + the milestone-1 layer classifier), the 2D frames viewer
(now with the layers lens, fully deterministic rendering), and the
native-indexer split. The "multiplayer canvas" half is descoped: the scenario
DSL and the multiplayer canvas chrome (merge animation, agent cursors) are NOT
pursued; the remaining single-player items (the TODO entity, floating-entity
placement, and adopting the existing record drawer for TODOs) are deferred to
0.3.6+.**

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

---

## Deferred to 0.3.6+ (formerly the "0.3.5" line — renumbered)

The remaining single-player items, now sequenced **after the layer
enable/layout slices** (see Future below), which build directly on the
shipped milestone-1 foundation:

| Spec area | Status | Notes |
|---|---|---|
| **TODO entity** | ⏭ 0.3.6+ | [`todo-entity.md`](cortex-v0.3/todo-entity.md): schema, state machine, tools, and external bridge. No code yet. The headline feature of this line. |
| **Floating-entity placement** (bare nodes + aggregates) | ⏭ 0.3.6+ | `frame-ranking.md`/`frame-layout.md` call for placing the genuinely-peripheral residual (post-reclamation ~49 files on Cortex) + auxiliary aggregates near connected frames via a gravity-centroid, instead of the fixed bottom strip. Reclamation shrank this set; placing what remains is the next slice. (Related: the 0.3.0 stopgap promotes decision-governed non-ambient frames — `D-xwxj` — which this should subsume. Previewed and approved as an end-state direction in the 2026-06-12 layers brainstorm.) |
| **Record drawer — adopt for TODO** | ⏭ 0.3.6+ | The record drawer already ships for decisions (see Shipped). Reuses the same drawer for the TODO entity once TODOs exist. |

## Removed from scope

The "multiplayer canvas" half of the v0.3 design corpus is **not being pursued**:

| Spec area | Status | Notes |
|---|---|---|
| **Multiplayer-test mode / scenario DSL** | ✖ Removed | Spec §9.3 TS scenario runner. Dropped — not pursuing a multiplayer test harness. |
| **Multiplayer canvas chrome** (merge animation, agent cursors) | ✖ Removed | Live in `cortex-frames-prototype-v5.html` only. The shipped viewer is the single-player frames/decisions canvas; the realtime multi-agent surface is not pursued. |

## Taxonomy follow-up — in progress (classify → observe → enable)

| Spec area | Status | Notes |
|---|---|---|
| **Layer classifier + lens (milestone 1)** | ✅ Shipped (0.3.4) | See Shipped. The `FrameKind` classifier exists and is observable in the viewer with zero ranking/layout effect. |
| **Observe phase** | ▶ Current | Visually validate layer assignments on real repos (cortex + anthill-cloud). Watch list from the regression fixture: `frame-extraction` (splits into a domain frame + a tooling frame on the live graph), `contracts` (domain via fallback at MIN_SIGNAL 0.4), `mcp`. Tuning loop: edit constants in `frame-kind.ts` → `npm test` (the fixture prints the agreement report) → look. Regenerate the fixture (`scripts/frame-extraction/dump-frame-kind-inputs.ts`) against the current 17-frame graph when starting. |
| **Enable slice** (kind-weight + layer-diversity) | ⏭ Next after observe | Flag-gated (`CORTEX_KIND_WEIGHT=1`) change to `rankFrames`: kind weights per `frame-ranking.md` (domain 1.00 … ceremony 0.20) + the layer-diversity term. Gated on the observation verdict; mind that `domain` is both the fallback layer AND the highest weight — low-signal frames must not be over-ranked. |
| **Layout slice** (layer-adjacency force) | ⏭ After enable | Use *measured* adjacency from `rollupFrameFlows` (which cross-layer flows actually exist), not categorical adjacency. Subsumes floating-entity placement per the approved end-state preview. |
| **Cross-cutting concern axis** (graph communities) | ◑ Candidate | Measured 2026-06-12: import-graph communities (Louvain/Leiden) confirm the shipped clustering's cores and find cross-cutting subsystems lexical signals can't see (e.g. a 13-file freshness community scattered across 5 frames). Candidate inputs to `FrameKind.concern: 'cross-cutting'` and to frame-boundary refinement. Note: `ctx_louvain` exists in cortex-indexer but is dead code (test-only, single-level); wiring it as a frame-extraction signal would need a Leiden-grade upgrade. Measurement scripts preserved in the 2026-06-12 session record. |

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

The taxonomy follow-up is mid-arc — finish it before opening the 0.3.6+ line:

1. **Observe phase** (current): restart the MCP server, validate the layers
   lens on cortex + anthill-cloud, settle the contested frames, tune
   `frame-kind.ts` constants against the regression fixture.
2. **Enable slice**: kind-weight + layer-diversity behind `CORTEX_KIND_WEIGHT`,
   gated on the observation verdict.
3. **Layout slice**: layer-adjacency force from measured `rollupFrameFlows`
   adjacency; subsumes floating-entity placement.
4. Then the **0.3.6+ line**: TODO entity (schema → tools → drawer adoption) as
   the headline, record-drawer adoption for TODOs.

Parallel candidates that don't block the arc: the **co-change lens**
(`FILE_CHANGES_WITH` minus structural edges = hidden coupling, rendered as a
sibling row in the layers menu — measured 2026-06-12), and the
**agentic-experience P1–P8 plan** from the
[2026-06-12 field report](../field%20reports/field-report-2026-06-12-mesh-m1-platform-consumer.md)
(quick wins first: target-repo-aware grep hook, search ranking; `context_pack`;
versioned HTTP contract + freshness header — the latter gates Mesh's
viewer-adaptation milestone)._See [HANDOFF.md](../../HANDOFF.md) for the
session-level handoff._

# Cortex v0.3 — Progress Assessment

_Assessment date: 2026-06-10 — **0.3.0 release cut.** Refreshed after the native
indexer was split into its own repo (`cortex-indexer`, consumed as a prebuilt
binary) and the viewer decisions fixes landed, on top of the frame ranking
**Path 1**, **frame-coverage** retune, and reconciliation engine. Derived from
the live Cortex graph, the v0.3 design corpus in
[`docs/specs/cortex-v0.3/`](cortex-v0.3/), and the source tree._

Version metadata is consistent: `package.json`, `plugin.json`, and
`.claude-plugin/marketplace.json` are all `0.3.0` (tagged `v0.3.0`).

The shorthand: **0.3.0 ships the structural / data / provenance half of v0.3 —
the decision-provenance system (storage, multi-project routing, cold-start
seeding, flag-gated reconciliation), the frame pipeline (ranker + gravity layout
+ coverage reclamation), the 2D frames viewer, and the native-indexer split. The
"multiplayer canvas" half is descoped: the scenario DSL and the multiplayer
canvas chrome (merge animation, agent cursors) are NOT pursued; the remaining
single-player items (the TODO entity, floating-entity placement, and adopting
the existing record drawer for TODOs) are deferred to 0.3.5.**

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
| **Decision record drawer** (decisions) | ✅ Shipped | The focused-frame governance pill + decision card/marginalia in the 2D viewer ([`src/viewer/viewer.js`](../../src/viewer/viewer.js) `renderDecisionCard`, `/api/decisions/:id`) **is** the record drawer for decisions. Project-scoped per the viewer multi-project fix (`openProjectDecisions`, `D-edf7`); decision-governed frames the ranker left non-ambient are promoted so their decisions always render (`withGovernedFramesRendered`, `D-xwxj`). Adopting the same drawer for the TODO entity is deferred to 0.3.5. |

---

## Deferred to 0.3.5

The remaining single-player items, sequenced after 0.3.0:

| Spec area | Status | Notes |
|---|---|---|
| **TODO entity** | ⏭ 0.3.5 | [`todo-entity.md`](cortex-v0.3/todo-entity.md): schema, state machine, tools, and external bridge. No code yet. The headline 0.3.5 feature. |
| **Floating-entity placement** (bare nodes + aggregates) | ⏭ 0.3.5 | `frame-ranking.md`/`frame-layout.md` call for placing the genuinely-peripheral residual (post-reclamation ~49 files on Cortex) + auxiliary aggregates near connected frames via a gravity-centroid, instead of the fixed bottom strip. Reclamation shrank this set; placing what remains is the next slice. (Related: the 0.3.0 stopgap promotes decision-governed non-ambient frames — `D-xwxj` — which this should subsume.) |
| **Record drawer — adopt for TODO** | ⏭ 0.3.5 | The record drawer already ships for decisions (see Shipped). 0.3.5 reuses the same drawer for the TODO entity once TODOs exist. |

## Removed from scope

The "multiplayer canvas" half of the v0.3 design corpus is **not being pursued**:

| Spec area | Status | Notes |
|---|---|---|
| **Multiplayer-test mode / scenario DSL** | ✖ Removed | Spec §9.3 TS scenario runner. Dropped — not pursuing a multiplayer test harness. |
| **Multiplayer canvas chrome** (merge animation, agent cursors) | ✖ Removed | Live in `cortex-frames-prototype-v5.html` only. The shipped viewer is the single-player frames/decisions canvas; the realtime multi-agent surface is not pursued. |

## Future / post-0.3.5 candidate

| Spec area | Status | Notes |
|---|---|---|
| **Frame ranking — taxonomy follow-up** | ◑ Candidate | The Path 1 ranker + gravity layout shipped (see Shipped). Still designed-not-built in [`frame-ranking.md`](cortex-v0.3/frame-ranking.md): the `FrameKind` layer-first taxonomy + classifier, the layer-adjacency layout force, the kind-weight factor, and the layer-diversity term. Additive (the `FrameKind` type is pre-designed); gated on whether Path 1 + coverage leave gaps worth the classifier's cost. |

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

- **Viewer DB resolution can serve a stale map (`graph.db` shadows `.cortex/db`).**
  The canonical graph store is `.cortex/db`, but a legacy `.cortex/graph.db`
  (read-only fallback) can still exist and win the default `/api/frames` /
  `/api/graph` resolution path, so the viewer renders an *old* frame set even
  after a fresh reindex wrote the new one to `.cortex/db`. Observed 2026-06-09:
  after the frame-coverage reindex, `.cortex/db` held 25 frames / 296 framed
  files while the viewer's default (no `project` param) read `.cortex/graph.db`
  (8 frames). Passing an explicit `?project=` resolved to `.cortex/db` correctly.
  **Workaround:** retire/remove the legacy `.cortex/graph.db`. **Fix:** make
  `resolveGraphDbForRead` (and the viewer's default project path) prefer
  `.cortex/db` unconditionally and ignore a stale sibling `graph.db`. Tracked in
  memory (`viewer-stale-graph-db-override`, `graph-db-stale-reads`).
- **Dev reload:** the MCP server (`cortex-local`, `directory` source →
  the repo, so it runs **live `src/`**) loads modules once at startup — it does
  **not** hot-reload. After merging changes, restart the MCP server / Claude Code
  before reindexing, or the old in-memory pipeline runs (e.g. a post-merge reindex
  still produced the pre-merge `9 clusters / 140` until the server was current).
- **`contracts` index step fails (`database disk image is malformed`)** on every
  index run this session — a corrupted SQLite file in the contracts/decisions
  path, unrelated to frames. Not yet investigated.

## Recommended next step (→ 0.3.5)

0.3.0 is cut. The 0.3.5 line is the remaining single-player work, in order:
**TODO entity** (schema → tools → drawer adoption) as the headline, then
**floating-entity placement** (which should subsume the 0.3.0 governed-frame
promotion stopgap), then the **record-drawer adoption for TODOs**. The
**frame-ranking taxonomy follow-up** remains a post-0.3.5 candidate, gated on
whether Path 1 + coverage leave gaps worth the classifier's cost.

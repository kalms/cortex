# Cortex v0.3 — Progress Assessment

_Assessment date: 2026-06-09 (refreshed after frame ranking **Path 1** —
budget-cut ranker + force-directed layout — and the **frame-coverage** retune +
graph reclamation merged to `main`). Derived from the live Cortex graph, the v0.3
design corpus in [`docs/specs/cortex-v0.3/`](cortex-v0.3/), and the source tree._

Version metadata is consistent: `package.json`, `plugin.json`, and
`.claude-plugin/marketplace.json` are all `0.3.0`.

The shorthand: **the structural / data half of v0.3 shipped — including the
reconciliation engine (flag-gated), the taxonomy-free frame ranker + gravity
layout, and the frame-coverage retune/reclamation; the "multiplayer canvas" half
is still design.**

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

---

## Spec-only (designed, not built)

| Spec area | Status | Evidence |
|---|---|---|
| **Frame ranking — taxonomy follow-up** | ◑ Partial — Path 1 shipped, taxonomy pending | The Path 1 ranker + gravity layout shipped (see Shipped table). Still missing from [`frame-ranking.md`](cortex-v0.3/frame-ranking.md): the `FrameKind` layer-first taxonomy and the classifier it needs — and therefore the layer-adjacency layout force, the ranker's kind-weight factor, and the layer-diversity term. These are additive (the `FrameKind` type is pre-designed); gated on whether Path 1 + coverage leave gaps worth the classifier's cost. |
| **Floating-entity placement** (bare nodes + aggregates) | ❌ Not built | `frame-ranking.md`/`frame-layout.md` call for placing the genuinely-peripheral residual (post-reclamation ~49 files on Cortex) + auxiliary aggregates near connected frames via a gravity-centroid, instead of the fixed bottom strip. Reclamation shrank this set; placing what remains is the next slice. |
| **TODO entity** | ❌ Missing | `%odo%` matches only [`todo-entity.md`](cortex-v0.3/todo-entity.md). No schema, state machine, drawer, tools, or external bridge. |
| **Multiplayer-test mode / scenario DSL** | ❌ Missing | `%cenario%` matches only spec §9.3. No TS DSL scenario runner. |
| **Record drawer, merge animation, agent cursors, floating-entity grammar** | ❌ Prototype-only | `drawer` returns no code matches. These live in `cortex-frames-prototype-v5.html`; the live viewer renders frames, not the full multiplayer canvas. |

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

## Recommended next step

The **reconciliation engine** and **frame ranking Path 1 + coverage** — the
previously highest-leverage gaps — are now **shipped**. Next-highest remaining
gaps: the **frame-ranking taxonomy follow-up** (`FrameKind` classifier → layer
force + kind-weight), **floating-entity placement** of the post-reclamation
residual, and the **TODO entity**. The viewer stale-`graph.db` resolution fix
above is a small, high-value cleanup that unblocks reliably seeing new frames.

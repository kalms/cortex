# Cortex v0.3 — Progress Assessment

_Assessment date: 2026-06-24 — refreshed after the **first major release, `1.0.0`**:
the MCP primitive tool surface consolidated from 17 granular tools into 3
action-dispatched tools (`decision` / `pr` / `todo`, a clean break) and the
**TODO entity foundation** landed (storage + tools + full HTTP-contract parity).
This sits on top of `0.9.0` (the **versioned, Zod-enforced HTTP contract +
hardening**, field-report P6) and the completed **frame-layers taxonomy arc**:
0.8.4 classify+observe · 0.8.5 deterministic dots · 0.8.6 docs · **0.8.7**
observe-phase polish · **0.8.8** earnable domain · **0.8.9/0.8.10** kind-weight
ranking (default-on) · **0.8.19/0.8.20** layer-diversity (default-on) ·
**0.8.21/0.8.22** layer-adjacency layout force (default-on) · **0.8.23**
floating-entity placement — all on top of the 0.8.0 cut (native-indexer split,
frame ranking Path 1, frame-coverage retune, reconciliation engine). Derived
from the live Cortex graph, the v0.3 design corpus in
[`docs/specs/cortex-v0.3/`](cortex-v0.3/), and the source tree._

Version metadata is consistent: `package.json`, `plugin.json`, and
`.claude-plugin/marketplace.json` are all `1.0.0` (PR [#27](https://github.com/ruevu/cortex/pull/27),
merge `1b9b378`, 2026-06-24). **1.0.0 is a breaking release** — the 17 old MCP
tool names are removed (clean break); external consumers (e.g. mesh) migrate per
the Migration table in [`CHANGELOG.md`](../../CHANGELOG.md). **Numbering note:**
the feature line this document once labelled "0.8.5" (TODO entity, floating-entity
placement, record drawer for TODOs) was renumbered out; floating-entity placement
shipped 0.8.23, and the **TODO entity foundation now ships in 1.0.0** (only its
viewer rendering + the record-drawer adoption remain deferred — see below).

The shorthand: **0.8.x → 1.0.0 ships the structural / data / provenance half of
v0.3 — the decision-provenance system (storage, multi-project routing, cold-start
seeding, flag-gated reconciliation), the frame pipeline (ranker + gravity layout
+ coverage reclamation + the layer classifier, now **earnable-domain** + a
default-on **kind-weight** + **layer-diversity** ranking and **layer-adjacency +
floating-entity** layout), the 2D frames viewer (layers lens, fully deterministic
rendering), the native-indexer split, the **versioned HTTP contract** (0.9.0), and
the **consolidated tool surface + TODO entity foundation** (1.0.0). The
"multiplayer canvas" half is descoped: the scenario DSL and the multiplayer canvas
chrome (merge animation, agent cursors) are NOT pursued. Of the single-player
line, the TODO entity (storage + tools + HTTP contract) and floating-entity
placement have now shipped; only the TODO **viewer rendering** and the
record-drawer adoption for TODOs remain deferred.**

---

## Shipped

| Spec area | Status | Evidence |
|---|---|---|
| **Frame extraction pipeline** | ✅ Shipped | [`src/frame-extraction/`](../../src/frame-extraction/) — `cluster-tfidf-hdbscan.ts` + `python/tfidf_hdbscan.py`, `co-change.ts`, `auxiliary-detection.ts`, `path-tokenize.ts` + `structural-tokens.ts` (framework-aware tokenisation), `text-blob.ts` (two content streams), `inject-frames.ts` + `run-frames.ts` (graph integration), `eval-gate.ts`. Surfaced via `code-tools.ts::withFrames` and the CLI. |
| **Pipeline empirical comparison** | ✅ Done — 1 of 3 survived | Eval harness ([`scripts/frame-extraction/`](../../scripts/frame-extraction/): `eval-all.ts`, `corpus.json`, `baselines/`) and `types.ts` (`ClusterResult.algorithm`) anticipate `tfidf+hdbscan \| embedding+hdbscan \| leiden`. Only **tfidf+hdbscan** was built; Leiden and pinned-embedding clusterers were never implemented. The comparison resolved to one winner. |
| **PR data model + tools** | ✅ Shipped (data only) | [`src/prs/service.ts`](../../src/prs/service.ts), [`src/prs/types.ts`](../../src/prs/types.ts) (`OpenPRInput` with `introduces_frame`, `additions`, `external_ref`). Exposed via the consolidated `pr` tool — `pr({action:"open"\|"touch"\|"merge"\|"get"})` (was `open_pr`/`add_pr_touch`/`merge_pr`/`get_pr`; `touch`'s inner `action` field renamed `change`). Matches spec §4 schema. **Not rendered on canvas** (spec said so explicitly). |
| **Decision proposal / supersession tools** | ✅ Shipped | `decision({action:"propose"\|"supersede"\|"promote"\|"link"})` (was the `*_decision` tools); [`src/decisions/promotion.ts`](../../src/decisions/promotion.ts), `cli/commands/decision.ts::cmdPropose`. |
| **2D frames viewer** | ✅ Shipped | [`src/viewer/`](../../src/viewer/) — `adapters.js` (`groupNodesIntoFrames`, `frameCoverage`), `data-fetch.js`, `viewer.js`, wired to `/api/graph` / `/api/projects` / `/api/decisions` / `/api/frames`. The temporary client-side `layout.js` grid was retired in favour of the server-computed force layout (see below). |
| **Reconciliation engine** (derived decision state) | ✅ Shipped (flag-gated) | Agent-delegated reconciliation behind `CORTEX_RECONCILE` (default off in v1). Working-tree (not HEAD) source hash in [`src/decisions/reconciliation.ts`](../../src/decisions/reconciliation.ts); `decision({action:"reconcile"\|"pending"})` (was `record_reconciliation` / `pending_reconciliations`; logic in [`src/mcp-server/tools/reconciliation-tools.ts`](../../src/mcp-server/tools/reconciliation-tools.ts)); on-read drift block + derived `display_state` in `decision({action:"get"\|"why"})` ([`src/mcp-server/reconciliation-attach.ts`](../../src/mcp-server/reconciliation-attach.ts)); `cortex reconcile status` CLI and SessionStart banner. Design: [`docs/superpowers/specs/2026-06-08-decision-reconciliation-engine-design.md`](../superpowers/specs/2026-06-08-decision-reconciliation-engine-design.md); plan: [`docs/superpowers/plans/2026-06-08-decision-reconciliation-engine.md`](../superpowers/plans/2026-06-08-decision-reconciliation-engine.md). |
| **Frame ranking — Path 1** (taxonomy-free ranker + gravity layout) | ✅ Shipped | Deterministic budget-cut ranker (`score = nameability × structural_weight`, ambient budget `max(4,min(10,⌈n·0.7⌉))`) in [`src/frame-extraction/frame-ranker.ts`](../../src/frame-extraction/frame-ranker.ts); symbol→file→frame edge rollup [`src/mcp-server/frame-pair-rollup.ts`](../../src/mcp-server/frame-pair-rollup.ts); deterministic d3-force layout (mulberry32+SHA-256 seed, 300 iters, integer quantize, AABB collision-relaxation tail) [`src/mcp-server/frame-layout.ts`](../../src/mcp-server/frame-layout.ts); orchestrated by [`src/mcp-server/frame-map.ts`](../../src/mcp-server/frame-map.ts) behind `/api/frames`; viewer consumes it (grid retired). Decision `D-pzc8`. Design: [`docs/superpowers/specs/2026-06-08-frame-ranking-path1-design.md`](../superpowers/specs/2026-06-08-frame-ranking-path1-design.md); plan: [`docs/superpowers/plans/2026-06-09-frame-ranking-path1.md`](../superpowers/plans/2026-06-09-frame-ranking-path1.md). |
| **Frame coverage** (min_samples retune + graph reclamation) | ✅ Shipped | HDBSCAN `min_samples` exposed + defaulted to 1 (was implicitly `min_cluster_size`=5 → ~70% noise), gated by the label-quality F1 harness; pure `reclaimNoise` assigns residual noise files to their most-connected cluster via CALLS/USAGE/IMPORTS rollup, marked `reclaimed` so the ranker scores nameability on the topical core. [`src/frame-extraction/frame-reclamation.ts`](../../src/frame-extraction/frame-reclamation.ts), `cluster-tfidf-hdbscan.ts` + `python/tfidf_hdbscan.py`, `run-frames.ts`. **Measured on the Cortex graph: semantic-file coverage 29% → 88%** (noise 282 → 49). Decision `D-b0rq`. Design: [`docs/superpowers/specs/2026-06-09-frame-coverage-design.md`](../superpowers/specs/2026-06-09-frame-coverage-design.md); plan: [`docs/superpowers/plans/2026-06-09-frame-coverage.md`](../superpowers/plans/2026-06-09-frame-coverage.md). |
| **Native indexer split** (own repo + prebuilt binary) | ✅ Shipped | The C indexer was extracted to **`ruevu/cortex-indexer`** (own CI build/test/release matrix); cortex now consumes a **prebuilt binary** fetched at `postinstall` ([`scripts/fetch-indexer.mjs`](../../scripts/fetch-indexer.mjs)) from a GitHub release pinned by `CORTEX_INDEXER_VERSION` ([`src/indexer/version.ts`](../../src/indexer/version.ts)), checksum-verified + cached, with a lazy runtime version guard `ensureIndexer()` ([`src/indexer/binary.ts`](../../src/indexer/binary.ts)). `internal/indexer/` + `build-indexer.sh` removed; cortex history rewritten to sever the `codebase-memory-mcp`/CBM fork lineage. cortex is now pure TypeScript/MCP. Decision `D-chfd`. Released `cortex-indexer` **v0.3.0** (darwin-arm64, linux-x64, linux-arm64). |
| **Decision record drawer** (decisions) | ✅ Shipped | The focused-frame governance pill + decision card/marginalia in the 2D viewer ([`src/viewer/viewer.js`](../../src/viewer/viewer.js) `renderDecisionCard`, `/api/decisions/:id`) **is** the record drawer for decisions. Project-scoped per the viewer multi-project fix (`openProjectDecisions`, `D-edf7`); decision-governed frames the ranker left non-ambient are promoted so their decisions always render (`withGovernedFramesRendered`, `D-xwxj`). Adopting the same drawer for the TODO entity is deferred to 0.8.6+. |
| **Frame layers — taxonomy milestone 1** (classify + observe) | ✅ Shipped (0.8.4) | Deterministic 6-layer classifier ([`src/frame-extraction/frame-kind.ts`](../../src/frame-extraction/frame-kind.ts)): agreement-based combination of directed graph position ([`frame-flow-rollup.ts`](../../src/mcp-server/frame-flow-rollup.ts) fan-in/fan-out), curated path patterns, and content signals; `layer` rides every `/api/frames` entry; viewer `layers` toolbar menu (switch + the only legend) with a quiet per-layer tint — off (default) is pixel-identical. Internals (confidence/contributions) never serialize (negative test). Regression net: frozen cortex fixture + hand-labeled `anyOf` expectations ([`expected-layers.test.ts`](../../tests/frame-extraction/expected-layers.test.ts)) — caught two classifier bugs pre-merge. **Ranking and layout deliberately untouched** (classify → observe → enable). Decisions `D-qn7z`, `D-24p0`, `D-b1gd`; [design spec](../superpowers/specs/2026-06-12-frame-layers-taxonomy-design.md). |
| **Deterministic viewer rendering** | ✅ Shipped (0.8.5) | Dot placement moved from `Math.random` to a jitter-bounded grid (cell from member index, jitter seeded from file path via fnv1a + mulberry32); decision anchor dots seeded the same way. No two dots can render coincident (which faked "duplicate edges" to one target), and the same graph renders byte-identical screenshots across reloads — the last `Math.random` is out of the render data path. |
| **Frame layers — observe-phase polish** | ✅ Shipped (0.8.7) | Handler-suffix orchestration signal (Nitro/h3 `api/routes/*.{get,post,…}.ts` → orchestration, `W_HANDLER`=`W_PATH`, route-dir-scoped, case-insensitive); ceremony tint separated from infrastructure (warm taupe — the cool grays were indistinguishable at lens alphas); legend swatches single-sourced from `LAYER_RGB`; internal `fallback` flag distinguishing pure-fallback domain from within-pair ties in the eval report; regression fixture regenerated to the 17-frame graph + a coverage guard (every named frame must have a hand label). Decision `D-gbqj`. |
| **Frame layers — earnable domain** | ✅ Shipped (0.8.8) | `domain` was only ever reached by fallback; now runtime code in the silent middle sink band *earns* it via an **earned-fallback** residual (`W_DOMAIN_RUNTIME`=0.5, ~80% runtime bar), applied only when no layer-specific source clears `MIN_SIGNAL` so any real signal still wins. Corpus-validated ([`scripts/frame-extraction/eval-layers.ts`](../../scripts/frame-extraction/eval-layers.ts), 11 repos): earns domain on 8/11 (TS/Vue/React/Nuxt/Python/Django); cortex earns none (its clusters co-locate tests with subjects → the frame-quality ceiling, not a defect). Decision `D-8vbv`; [design](../superpowers/specs/2026-06-13-earnable-domain-signal-design.md). |
| **Search ranking — `search_graph` (field report P2)** | ✅ Shipped (0.8.11–0.8.12) | Pure ranker [`src/graph/node-ranker.ts`](../../src/graph/node-ranker.ts) (`KIND_WEIGHT × nameMatchQuality`, exact>prefix>substring, deterministic tie-break → stable pagination); doc/plan `section` nodes excluded from name/qn results by default (opt in via new `kinds` param), `limit`/`offset` pagination, `showing A–B of N · K section nodes suppressed` header. Pure render/clamp [`search-format.ts`](../../src/mcp-server/tools/search-format.ts) + `countSuppressedSections`. 0.8.12 scoped the suppression note to the default filter and documented the match syntax in [`docs/mcp-tools.md`](../mcp-tools.md). Decision `D-fq9g`; [design](../superpowers/specs/2026-06-14-search-graph-ranking-design.md). |
| **Shared code_search engine — `cortex code search`/`find`** | ✅ Shipped (0.8.12–0.8.13) | `cortex code find` brought to parity with `search_graph` (ranked, section-excluded, `--kind`/`--limit`/`--offset`). `cortex code search` re-pointed off the indexer binary's capped/doc-biased `search_code` onto a shared ripgrep engine [`src/graph/code-search.ts`](../../src/graph/code-search.ts) (`runCodeSearch` + `rankSearchHits`) that the MCP `search_code` tool also wraps (**output byte-identical**); CLI ranks **code-first** so markdown hits no longer dominate (the "only .md" report). `clampLimit`/`clampOffset` moved to [`search-params.ts`](../../src/graph/search-params.ts) to keep the CLI off the mcp-server layer. Decision `D-qfz9`; [design](../superpowers/specs/2026-06-14-shared-code-search-engine-design.md). |
| **`prefer-cortex` hook over-match fix** | ✅ Shipped (0.8.14) | The Bash branch strips quoted string literals before probing for a command-position search tool, so `git commit -m "…grep…"` / `echo "rg …"` are no longer denied as code searches; real code searches keep the tool word unquoted and still redirect, and scope detection still runs against the original command. +4 tests. (Distinct from field-report **P3**, the cross-repo target-aware hook, which remains open.) |
| **Frame layers — kind-weight ranking (enable slice 3a)** | ✅ Shipped (0.8.9) | `score ×= kind_weight` (earned domain 1.00 / interface 0.90 / orchestration 0.85 / data 0.75 / infra 0.55 / **fallback-domain 0.50** / ceremony 0.20), behind `CORTEX_KIND_WEIGHT` **default off (inert — ranking byte-identical when off, enforced by test)**. The ranker stays pure: `kind_weight` is a plain number on `FrameRecord` (omitted ≡ 1); the table (`KIND_WEIGHT`/`kindWeight` in [`frame-kind.ts`](../../src/frame-extraction/frame-kind.ts)) + flag live at the call site, where [`frame-map.ts`](../../src/mcp-server/frame-map.ts) now classifies before ranking and reads `fallback` only to pick the weight (never serialized). Corpus observe: evicts ceremony/config noise, tilts ambient to narrative layers, fallback-domain demotion works, no junk leapfrogging. Decision `D-g4qb`; [design](../superpowers/specs/2026-06-13-kind-weight-enable-slice-design.md). |
| **Versioned HTTP contract + hardening** (field-report P6) | ✅ Shipped (0.9.0) | Zod single-source-of-truth schemas ([`api-schemas.ts`](../../src/mcp-server/api-schemas.ts)) → runtime validation + `z.infer` types + drift-guarded generated `docs/api/*.schema.json`; `version` on every response; freshness via `X-Cortex-Freshness` header + `/api/freshness` + ETag/304; `/api/health`; env-gated hardening (loopback bind, CORS allowlist, opt-in bearer auth, traversal guard, security headers). Decision `D-tszm`; [onboarding](../architecture/http-api-contract.md). |
| **Consolidated MCP tool surface + TODO entity foundation** | ✅ Shipped (**1.0.0**) | 17 granular decision/PR tools → **3 action-dispatched tools** `decision`/`pr`/`todo` (clean break, old names removed; byte-parity contract tests are the guard). **TODO entity** as the third user-authored primitive: durable storage in the primitives DB (`todos`/`todo_links`/`todos_fts`, `T-` ids), `TodoService` + state machine, `todo` MCP tool, and full HTTP-contract parity (`AdaptedTodo` + `/api/todos`). Shared `validatePrimitiveFields`. Decisions `D-v2tc`/`D-r6xg`/`D-s72s`/`D-yb1b`/`D-87zb`; spec [2026-06-23-todo-entity-consolidated-tools-design.md](../superpowers/specs/2026-06-23-todo-entity-consolidated-tools-design.md). Deferred to later slices: TODO **viewer rendering**, `EventBus` emission, hooks, external bridge, `AgentRef`. |

---

## Deferred (the remaining single-player items)

The TODO entity **foundation** (storage + tools + HTTP contract) and
floating-entity placement have shipped (see Shipped); what remains builds on
them:

| Spec area | Status | Notes |
|---|---|---|
| **TODO viewer rendering + record-drawer adoption** | ⏭ deferred slice | Yellow TODO dots, the drawer surface, marginalia pills, decision→TODO leader lines, and the decision-drawer "Tasks" section. The record drawer already ships for decisions; the `/api/todos` contract that feeds it shipped in 1.0.0 — only the pixels remain. [`todo-entity.md`](cortex-v0.3/todo-entity.md). |
| **TODO hooks + external bridge** | ⏭ deferred slice | `PostMergeHook` auto-completing `resolvedBy` TODOs on PR merge; `PostDecisionHook` linking `spawnsFrom`; Linear/JIRA/GitHub mirroring (bidirectional sync is v1.5). |

## Removed from scope

The "multiplayer canvas" half of the v0.3 design corpus is **not being pursued**:

| Spec area | Status | Notes |
|---|---|---|
| **Multiplayer-test mode / scenario DSL** | ✖ Removed | Spec §9.3 TS scenario runner. Dropped — not pursuing a multiplayer test harness. |
| **Multiplayer canvas chrome** (merge animation, agent cursors) | ✖ Removed | Live in `cortex-frames-prototype-v5.html` only. The shipped viewer is the single-player frames/decisions canvas; the realtime multi-agent surface is not pursued. |

## Taxonomy follow-up — classify → observe → enable (arc complete)

The full arc shipped and is default-on (per-release detail in
[`CHANGELOG.md`](../../CHANGELOG.md)): the layer classifier + lens (0.8.4), the
observe phase (0.8.7–0.8.8, → earnable-domain `D-8vbv`), enable-3a kind-weight
(0.8.9, default-on 0.8.10, `D-g4qb`), enable-3b layer-diversity (0.8.19,
default-on 0.8.20, `D-wvsz`), and the layout slice — layer-adjacency force
(0.8.21, default-on 0.8.22, `D-marq`) + floating-entity placement (0.8.23,
supersedes the `D-xwxj` stopgap). One axis remains open:

| Spec area | Status | Notes |
|---|---|---|
| **Cross-cutting concern axis** (graph communities) | ◑ Candidate / deferred | The reserved `FrameKind.concern` axis. The only signal that would rescue **substrate-band core domain** (heavily-imported product cores that read topologically as substrate — anthill's `dsl/compiler`, cortex's 23-member `frame-extraction`), which the earnable-domain middle-band signal deliberately can't reach. `ctx_louvain` exists in cortex-indexer but is dead code (test-only, single-level); wiring it would need a Leiden-grade upgrade. Explicitly deferred in `D-8vbv` ("walk before run"). |

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
- **GOVERNS qualified-name classification (pre-existing, low-severity).**
  `classifyTarget` in **both** [`src/decisions/service.ts`](../../src/decisions/service.ts)
  and [`src/todos/service.ts`](../../src/todos/service.ts) uses
  `includes("/") ? "path" : "qn"`, so a real qualified name (`dir/file.ts::sym`,
  always contains `/`) is classified `"path"` and then fails `resolveGovernsRef`
  (it looks the whole string up in `nodesByPath`), silently dropping the governs
  ref from the HTTP API. The TODO code mirrors decisions exactly, so it is **not
  a 1.0.0 regression** — a cross-primitive fix (check `::` first) is worth doing
  before the TODO viewer-rendering slice relies on it.
- **Dev reload (still live):** the MCP server (`cortex-local`, `directory`
  source → the repo, so it runs **live `src/`**) loads modules once at startup —
  it does **not** hot-reload. After merging changes, restart the MCP server /
  Claude Code before expecting new read-time behavior (e.g. the consolidated
  `decision`/`pr`/`todo` tools only replaced the 17 old names after a restart;
  the `layer` field on `/api/frames` likewise needs one). Use `npm run dev`
  (:3334) for Gate-0 QA when the plugin server on :3333 is serving stale code.

## Recommended next step

With 1.0.0 out (consolidated tools + TODO foundation) and the taxonomy arc
complete, the open work, roughly in order:

1. **TODO viewer slice** — render the now-durable TODO data: dots, drawer,
   marginalia, decision→TODO leader lines, the decision-drawer "Tasks" section.
   The `/api/todos` contract already feeds it; only the pixels remain. (Fold in
   the GOVERNS qn-classification fix from Known issues while in `src/todos/`.)
2. **Frame-quality + Louvain `concern` axis** (larger): the upstream fix for
   fragmented/test-mixed clusters and substrate-band core domain — the ceiling
   the observe phase repeatedly hit (`SRC·863` mega-frame).
3. **Remaining agentic-experience items** from the
   [2026-06-12 field report](../field%20reports/field-report-2026-06-12-mesh-m1-platform-consumer.md):
   P4 (warm-path decision drafting), P5 (cross-repo decision search), P7(b/c)
   (tighten tool descriptions / lazy schema), P8 (temporal `changes_since`).
   P1/P2/P3/P6 and P7(a) (tool consolidation, in 1.0.0) have shipped.

Parallel, non-blocking: the **co-change lens** (`FILE_CHANGES_WITH` minus
structural edges = hidden coupling), the deferred 3b test follow-ups (multi-layer
simultaneous-promotion test, zero-score floor edge case), and **housekeeping** —
`vercel/commerce` silently fails the Python clustering step (exit 1) and drops out
of every corpus eval.

_See [HANDOFF.md](../../HANDOFF.md) for the session-level handoff._

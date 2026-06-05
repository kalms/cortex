# Import-Aware Frame Extraction — Design Spec

**Status:** Proposed
**Date:** 2026-06-04
**Author:** Claude (Opus 4.8, 1M context) + rka
**Related:**
- Field report: [field-report-2026-06-04-frame-extraction-semantic-quality.md](../../architecture/field%20reports/field-report-2026-06-04-frame-extraction-semantic-quality.md)
- Module: [`src/frame-extraction/`](../../../src/frame-extraction/)
- Eval harness: [`scripts/frame-extraction/`](../../../scripts/frame-extraction/)

---

## 1. Problem

Frame extraction clusters a repo's files into topical "frames" (co-change → TF-IDF/HDBSCAN → `injectFrames` writes `frame_id`/`frame_label` into `nodes.data`). A two-repo assessment (anthill-cloud, a Nuxt monorepo; cortex, a polyglot tool) found:

1. **Clustering is sound; labeling is the weak link.** Clusters map to real subsystems, but labels frequently misrepresent them. Concrete misses: `activator email` (a 7-file feature-page cluster named after one leaf), `orgid design` / `use store` (framework idioms leaking into labels).
2. **The labeler is defeated by framework idioms, not by poor repo organization.** anthill is *well* laid out; the path-token TF-IDF labeler is blind to Nuxt route params (`[orgId]`), Pinia conventions (`use*Store`), and (by extension) MVC layer markers. The fix belongs at **tokenization**, upstream of clustering and labeling.
3. **Some clusters are too coarse.** cortex's `cli commands` (24 files) fuses three subsystems — CLI, decisions, MCP server — because they import each other heavily. No labeling change can fix this; it is a clustering-boundary problem.
4. **Operational footgun.** Frame extraction runs only on the TS index path (`cortex index` CLI, MCP `index_repository` tool). Indexing via the raw C binary produces a frameless graph with no warning.

The existing eval corpus is **library-heavy** (peft, click, cobra, TanStack/table, trpc, vueuse, nuxt/ui, cortex) and **application-light** — it under-exercises exactly the framework-idiom and layer×feature structures that expose these failures.

## 2. Goals / Non-goals

**Goals**
- Labels that name the *domain*, not the framework idiom or a single member file.
- Clusters that can be *split* when their import structure shows distinct communities.
- An eval corpus that covers the common fullstack idiom families, so improvements generalize.
- A non-fatal warning when a project has files but no frames.

**Non-goals**
- Replacing TF-IDF/HDBSCAN as the primary clusterer (Approach B, deferred — see §10).
- A single blended affinity matrix as the whole solution (Approach C, deferred — cannot split coarse clusters).
- Merging clusters. Phase 3 is split-only.
- Cross-frame "domain rollup" views (separate future work).

## 3. Approach

One cohesive change across the pipeline, delivered as **four risk-ascending phases**, each shipped as its own implementation plan, each gated on the eval corpus. Phase 0 builds the guardrail first so every later phase is measured and cannot silently regress repos that already work.

```
Phase 0  Eval guardrail (corpus refresh + framework fixtures + acceptance metrics)
Phase 1  Convention-aware tokenization + label salience      (lowest risk)
Phase 2  Import-affinity signal (delta weight)               (cohesion / coverage)
Phase 3  TS modularity split (refine-split.ts)               (fixes coarse clusters)
+        Zero-frames warning                                 (cross-cutting)
```

## 4. Phase 0 — Eval guardrail (build first)

**Preserve the full existing corpus** (8 public repos incl. `self/cortex`) as the regression bar; refresh baselines with the current algorithm before any change lands.

**Add fixtures**, chosen for idiom-family diversity using representative *applications* (not the frameworks' own source):
- **anthill-cloud** — Nuxt monorepo. **Local-only** fixture (private repo; uses the corpus's existing `local_path` mechanism, like `self/cortex`). Evaluated when present; skipped in portable/CI runs.
- **Next.js App Router app** — `app/**/page.tsx`, `route.ts`, `layout.tsx`, `[param]`, `(group)`. Public, committed.
- **Django app** and **Rails app** — convention-over-config MVC (`app/models|controllers|views`, `models.py`/`urls.py`, migrations). Public, committed. MVC is a distinct, still-common idiom family the JS meta-frameworks don't cover.

**Acceptance metrics** (computed by the existing harness — `eval-metrics.ts` `agreementScore`/`noiseRate`/`clusterCount`, `eval-edges.ts` `collectCallsEdges`), applied **corpus-wide**:
- **`CALLS` agreementScore ≥ baseline** on every repo (no regression to clusters that work).
- **`noiseRate` ≤ baseline** on every repo.
- **Label-quality rules** (machine-checkable): no label contains a bracketed route param, a bare convention prefix (`use`), or a bare MVC layer marker (`controller`/`model`/`view`); a cluster with no ≥50%-shared token gets a path-prefix label.
- **Two targeted wins:** anthill labels resolve to domains (`activator email` → `activator`); cortex `cli commands` splits into ≥2 frames.

**Tuning method:** new weights/thresholds (Phase 2 `delta`, Phase 3 Q threshold) are chosen by a **corpus-wide sweep**, mirroring the existing gamma-sweep (`.tmp/frame-extraction/eval-sweep/cortex-g{0.0,0.3,0.5,0.7}.md`). This prevents overfitting to anthill.

**Deliverable:** a committed eval-fixture definition (corpus repo specs + per-fixture label expectations) and a baseline report, runnable as one command.

## 5. Phase 1 — Convention-aware tokenization + label salience

**Principle:** brackets, convention affixes, route-method suffixes, and MVC layer markers are all **structural, not topical**. Treat them uniformly: down-weight for clustering, ineligible for labels; prefer the *domain* token over the *layer* token.

**[path-tokenize.ts](../../../src/frame-extraction/path-tokenize.ts)** — extend tokenization to:
- Drop bracketed dynamic segments entirely: `[orgId]`, `[id]`, `[...slug]`, `(group)`.
- Normalize convention affixes: strip a leading `use` before CamelCase (`useFoundationStore` → `foundation store`); drop trailing route-method tokens (`.get`/`.post`/…).
- Down-weight MVC layer markers as label-ineligible: `controller`, `model`, `view`, `serializer`, `migration`, `schema` (configurable set). The domain noun (e.g. `users` from `users_controller.rb`, or the Django app dir) is preferred.

This feeds **both** the TF-IDF blob ([text-blob.ts](../../../src/frame-extraction/text-blob.ts) consumes tokenized paths) and the labeler, so it improves clustering noise and labels together.

**[inject-frames.ts](../../../src/frame-extraction/inject-frames.ts) `pickFrameLabel`** — add a **cross-member salience gate** to passes 1–2: a candidate token is label-eligible only if it appears in **≥50% of the cluster's `member_paths`** (computed in TS from `member_paths`, no Python change). A token salient in one file (`email`, 1/7) fails the gate and falls through to the existing path-prefix fallback (`activator`). The 4-pass structure and the path-prefix fallback (which already skips brackets/generics) are retained.

**Acceptance:** the label-quality rules in §4 hold corpus-wide; no clustering regression (tokenization down-weighting must not raise `noiseRate`).

## 6. Phase 2 — Import-affinity signal

> **SUPERSEDED — investigated, null result (2026-06-05).** A designed experiment built and swept this `delta` signal and found **no safe corpus-wide value**: the targeted framework leaves have too few/too-diffuse import edges to pull on, while the `delta` high enough to move them collapses dense monorepo import graphs (cortex → 2 clusters at δ=0.45). 0/8 named targeted files rescued; net coverage flat-to-negative. Implementation discarded (not merged); `delta` stays 0. The lead, if revisited, is **adaptive per-repo delta** or better edge extraction — not a global weight. Full write-up: [docs/research/2026-06-05-import-affinity-delta.md](../../research/2026-06-05-import-affinity-delta.md). Phase 3 below is independent and unaffected.

**Goal:** rescue import-coupled files from the noise cluster (improve coverage), using the graph edges already in the DB.

- **New collector** (sibling to [co-change.ts](../../../src/frame-extraction/co-change.ts)): read `IMPORTS`+`CALLS` edges from the graph DB, aggregate to a symmetric file→file adjacency weighted by count, emit JSONL (same shape contract as the co-change JSONL).
- **New `delta` weight** in `tfidf_hdbscan.py`, parallel to the existing `gamma` (co-change). Blends import adjacency into the precomputed HDBSCAN distance: closer for import-coupled files.
- **Default:** `delta = 0` (opt-in) until the corpus-wide sweep shows a value that **raises `CALLS` agreement without raising `noiseRate`**; then flip the default on at the swept value.

**Acceptance:** corpus-wide `CALLS` agreement strictly improves (or holds) and `noiseRate` does not worsen at the chosen `delta`.

## 7. Phase 3 — TS modularity split

> **SUPERSEDED — investigated, negative result (2026-06-05).** The split was built and swept; on cortex's `cli commands` blob it produced **incoherent** sub-clusters (each mixing `cli`/`mcp-server`/`decisions`/`tests`), all falling back to `cluster:N` labels (+3 label violations), with a small CALLS-agreement dip — because the call/import graph crosses the subsystem boundaries frames should respect, so no clean modular cut exists. Implementation discarded (not merged); split stays off. Full write-up: [docs/research/2026-06-05-modularity-split.md](../../research/2026-06-05-modularity-split.md).
>
> **Both graph-signal phases (2 + 3) are negative.** See the cross-phase conclusion at the end of this doc.

**Goal:** split clusters that fuse distinct subsystems (the `cli commands` blob).

- **New TS pass `src/frame-extraction/refine-split.ts`**, run **between** Python clustering and `injectFrames`.
- For each non-noise cluster above a size threshold (~12 files): build the induced subgraph from `IMPORTS`+`CALLS` edges among its members (queried in TS via better-sqlite3 from the same DB), run **greedy/Louvain-style modularity in TS** (no venv dependency; small per-cluster subgraphs).
- **Split-only:** if modularity `Q > ~0.3` **and** the partition yields ≥2 communities each ≥ `min_cluster_size`, replace the cluster with its communities (new `frame_id`s) and relabel each via the Phase-1 labeler. Otherwise leave the cluster intact. Never merge.

**Acceptance:** cortex `cli commands` splits into ≥2 coherent frames (CLI / decisions / MCP, edge-structure permitting); no other corpus repo's `CALLS` agreement or `noiseRate` regresses; threshold chosen by corpus-wide sweep.

## 8. Cross-cutting — zero-frames warning

`runFrameExtraction` ([run-frames.ts](../../../src/frame-extraction/run-frames.ts)) already returns a discriminated `FrameResult` status. Add detection + surfacing for **"project has file nodes but 0 `frame_id`"** (e.g. last indexed via the raw C binary):
- CLI: a non-fatal line in `renderFramesLine` ("N files, 0 frames — reindex via `cortex index`").
- Viewer: a banner on a project with file nodes and no frames.

## 9. Data flow (where each piece slots in)

```
cortex index / MCP index_repository
  └─ C indexer builds graph (cache DB)            [unchanged]
  └─ runFrameExtraction:
       co-change collect ─┐
       import-edge collect ┼─► tfidf_hdbscan.py (TF-IDF + gamma·cochange + delta·imports)  [P2]
       text-blob (conv-aware tokens) ┘                                                       [P1]
         └─► clusters
              └─► refine-split.ts (TS modularity, split-only)                                [P3]
                   └─► pickFrameLabel (conv-aware + salience gate)                            [P1]
                        └─► injectFrames → nodes.data
       └─ zero-frames check → warning                                                         [cross]
Eval: clusters ─► eval-metrics (agreement vs CALLS, noiseRate) across corpus                  [P0]
```

## 10. Risks & deferred options

- **Cross-language extraction quality.** Phases 2–3 depend on `IMPORTS`/`CALLS` edge quality, which is more mature for TS than Ruby/PHP. Rails/Django fixtures test the *labeler* strongly but may under-test the import-aware phases — and may surface separate extraction gaps. Weak Phase-2/3 numbers on those repos must be read as a possible *extraction* issue, not assumed to be a clustering failure. The plans will instrument edge-density per repo so this is visible.
- **Affinity (P2) vs split (P3) tension.** Affinity merges; modularity splits. They are complementary (P2 forms better cores / reduces noise, P3 refines coarse ones), but the corpus eval is the guard. If they fight, `delta` is tuned down or scoped to noise-rescue only.
- **Deferred — Approach B (modularity-first clustering):** replace HDBSCAN with Leiden on the import graph. Bigger swing, heavier venv (igraph/leidenalg), risks regressing working clusters and orphaning low-import files. Revisit only if Phase 3's per-cluster splitting proves insufficient.
- **Deferred — Approach C (single blended matrix):** simplest, but affinity-only can't split coarse clusters, defeating the purpose.

## 11. Decomposition into plans

Four plans, in order. Each is independently valuable and eval-gated.

1. **Plan 0 — Eval guardrail.** Corpus refresh, framework fixtures (Next/Django/Rails + anthill local), label-quality checks, baseline report, one-command runner. *Prerequisite for all others.*
2. **Plan 1 — Convention-aware tokenization + label salience.** Pure TS; lowest risk; delivers the most visible label wins.
3. **Plan 2 — Import-affinity `delta`.** New collector + Python distance blend + corpus sweep.
4. **Plan 3 — TS modularity split.** `refine-split.ts` + corpus sweep + the `cli commands` target.

The zero-frames warning is small and rides with Plan 1 (it touches the same `run-frames.ts`/CLI surface).

## 12. Open questions

- Which specific OSS apps to pin as the Next/Django/Rails fixtures (must be permissively licensed, shallow-clonable, and architecturally representative — chosen during Plan 0).
- Exact label-ineligible MVC marker set (start: controller/model/view/serializer/migration/schema; refine against Django/Rails fixtures).
- Whether the salience gate should also consider content-token document-frequency (path-presence is the v1; content DF is a Plan-1 stretch if path-presence proves insufficient).

## 13. Outcome (2026-06-05) — graph-signal phases closed negative

The arc shipped **Phase 0** (eval guardrail), **Phase 1** (convention-aware tokenization + label salience — **the win**, label violations 133→10 corpus-wide), and the **zero-frames warning** (Plan 1b). The two **graph-signal** phases were built, swept, and **discarded as negative**:

- **Phase 2 — import-affinity `delta`** ([research](../../research/2026-06-05-import-affinity-delta.md)): no safe global weight; targeted files have too few/diffuse edges, dense monorepos over-merge.
- **Phase 3 — modularity split** ([research](../../research/2026-06-05-modularity-split.md)): incoherent splits + label regression; no clean modular cut exists.

**Why both failed (one cause):** a codebase's `IMPORTS`/`CALLS` graph couples files *across* the topical/subsystem boundaries frames are meant to express (CLI→decisions→MCP, tests→everything, framework leaves→shared utils). The import graph is the wrong signal for *topical* grouping; the cleaned lexical/path signal (Phase 1) expresses it better. **Future frame-quality work should build on tokenization/labeling/auxiliary-detection, not the import graph.** The eval guardrail (Phase 0) and corpus remain the regression bar for any such work.

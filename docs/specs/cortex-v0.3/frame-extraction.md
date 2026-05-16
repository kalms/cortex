# Frame extraction — design notes

> Companion to `cortex-multiplayer-spec.md` §8. Inverts the spec's
> directory-first cascade: semantic grouping is the primary target,
> structure is the floor. Adopted direction for v1; verification is
> intrinsic-only — upfront index-stats survey on active GitHub repos
> plus mechanical-correctness and determinism checks across the
> §5 research-brief corpus. No human-evaluation phase. Promote into §8
> once Phase 2 confirms the approach runs cleanly and maintainer
> spot-checks are positive.

---

## Position

Frames are semantic groupings. The algorithm's job is to identify what
the code *is about* (domains, concerns), not where it lives. Structural
grouping by directory is a fallback for code entities that don't cluster
semantically — not the starting point.

Rationale: mixing structural frames with semantic overlays (a "lens"
mode or similar) fragments the reading model. One consistent grammar —
frames carry semantic meaning — is cleaner for engineers reading code
they wrote. Where the code is well-organised structurally (Rails,
Next.js, Cortex-the-repo itself), directory and semantic groupings
converge naturally, and the algorithm *observes* the alignment rather
than relying on framework-specific templates. Where they diverge
(domain code scattered across layer directories), semantic wins.

---

## Two content streams

Before extraction runs, the indexer splits the repo's contents into two
streams. Only one participates in semantic frame extraction.

- **Code content.** Source files containing functions, classes, methods,
  symbols indexed by CBM. Primary clustering, name-token similarity,
  co-change matrix, dominator analysis all operate here.
- **Auxiliary content.** Assets, locales, fixtures, generated code,
  snapshot tests, lockfiles, build artefacts, vendored dependencies.
  Bypassed from semantic clustering entirely.

Auxiliary content renders as **aggregate bare nodes outside frames** —
peer entities to frames, sitting in canvas space, not inside any frame
boundary. A `locales/` directory becomes "1.2k locale entries" (one
node); `tests/__snapshots__/` becomes "487 snapshot files" (one node).
Click an aggregate → drawer surface lists members for drill-in.

Detection signals for auxiliary content. A directory or file group
counts as auxiliary if **(A) any path-pattern hit OR (B) all four of
the structural criteria are met:**

| Group | Signal | What it catches |
|---|---|---|
| A | Path patterns | `locales`, `i18n`, `__snapshots__`, `fixtures`, `assets`, `static`, `public`, `vendor`, `generated`, `dist`, `build` |
| B | Content type dominance | ≥80% of files share one non-source extension (`.png`, `.ttf`, `.lock`, data-only `.json`) |
| B | Graph position | Mean outgoing-imports per entity ≈ 0; only inbound usage |
| B | Size homogeneity | CV(size) < 0.3 |
| B | Cardinality | ≥20 entities |

Group A is the fast path: if a top-level directory matches a known
auxiliary path, classify and move on. Group B catches auxiliary
collections that aren't in the path-pattern list (e.g. a generated
docs folder with a non-conventional name) by their structural shape.

The aggregate node is a new entity type in the rendering grammar:

| Node type | Represents |
|---|---|
| File | Source file (code container) |
| Function / class / method | CBM code entity |
| Aggregate | Collection of same-kind auxiliary entities, one dot with count badge |

This cleanly separates "what the codebase does" (frames over code
content) from "what the codebase ships alongside its code" (aggregates).
It also pre-empts the per-frame-density problem in spec §8: most dense
frames are auxiliary content drifting in. Pull it out before extraction
and frames stay clean by construction.

Visual-weight specifics for aggregate rendering live in
`frame-ranking.md` — that file owns rendering decisions; this one
defines the data model.

---

## Granularity: code entities, not files

Extraction operates over the CBM graph's entity nodes — functions,
classes, methods, symbols — not files. A file is a container; its
functions can belong to different semantic frames.

- A file whose exports all land in the same frame is "in" that frame.
- A file whose exports split across frames has no single frame
  membership. The file becomes a bare node; its individual functions
  are frame-assigned but the file itself is not.

The prototype's file-sized dots are a presentation choice. The
data-model level is entity-granular; display aggregates up to files
when frames are dense and readable display demands it.

---

## Intrinsic-only signals

Cortex forms its opinion purely from what's observable in the committed
code and its git history. No external control.

| Signal | Source |
|---|---|
| Path structure (directories, nesting, counts) | Filesystem |
| Filename tokens (after framework-aware stripping) | Filesystem |
| Symbol names (functions, classes, methods) | CBM |
| Import / call graph topology | CBM |
| File and entity sizes | CBM |
| Git co-change history | git log |

Explicitly rejected as extraction signals:

- **Framework templates** — hand-curated *semantic interpretation*
  (e.g. "files in `routes/` are interface-layer"); borrowed opinion;
  doesn't generalise. Distinct from the framework-aware path-token
  stripping below, which is a *noise list*, not interpretation.
- **External library attribution maps** (`passport → auth`) — curated
  table; drifts; per-ecosystem maintenance
- **Decisions' `governs` lists** — user-authored; not intrinsic.
  Decisions still govern code downstream; they just don't shape
  extraction
- **LLM classification** — non-deterministic in practice; external
  dependency; variable cost
- **User input during indexing** — breaks determinism; different
  answers across team members produce different canvases on the same
  repo. Live with low-confidence output instead.

### Path tokenization (framework-aware)

Tokenising raw file paths produces noise: `src`, `app`, `pages`,
`components` appear in nearly every project of a given framework and
carry zero domain information. Before computing name-token similarity,
strip framework-conventional segments and role suffixes. What remains
is usually the domain.

The stripping list is part of Cortex's algorithm code — versioned,
reviewed, shipped with releases. It is NOT a per-framework template
library; it's a noise list, applied uniformly:

- **Universal segments:** `src`, `lib`
- **Frontend conventions:** `app`, `pages`, `components`, `composables`,
  `layouts`, `middleware`, `plugins`, `stores`, `views`, `router`
- **Backend conventions:** `cmd`, `internal`, `pkg`, `api`,
  `controllers`, `services`, `models`, `routes`
- **Test/build conventions:** `tests`, `test`, `__tests__`, `spec`,
  `docs`, `dist`, `build`
- **Role suffixes:** `.service`, `.helper`, `.controller`,
  `.repository`, `.test`, `.spec`

Edge case: in service-oriented codebases where `OrderService`,
`BillingService` carry the domain, aggressive suffix stripping loses
signal. Mitigation: strip role suffixes only when the prefix is itself
a domain token; preserve them when the role is the unique identifier.
Tune on Phase 1 corpus.

Distinct from the generic-token *labelling penalty* (`util`, `helper`,
`common`, `core`, `misc`, `shared`, `service`, `manager`, `handler`),
which acts on the chosen frame label rather than the per-file
tokenisation. Both serve the same purpose at different stages.

### Co-change as semantic signal

Files that change together over time belong together — this captures
**logical coupling** that static import analysis misses. Two files
with no shared imports may still be a tight semantic unit if every
feature change touches both. Two files with strong import coupling
may be unrelated infrastructure that happens to be invoked together.

Co-change is the strongest signal for the fragmented-domain case (auth
across `middleware/`, `models/`, `routes/`) — these files reliably
get touched together in PRs and bugfixes regardless of folder or
naming. CodeScene's behavioural analysis product is built on this and
demonstrates the technique scales.

Computation:

- `git log --name-only --pretty=format:%H --since=180.days.ago` over the
  code-content stream (auxiliary content already excluded upstream)
- Build a co-change matrix: pairs of files counted by shared commits
- Filter big commits (≥50 files) — drops format-passes,
  bulk-renames, initial imports
- Window pinned to `HEAD.committer_date - 180 days` for determinism
- Renames detected via git's `-M` so a recently-renamed file keeps its
  history

Co-change feeds into clustering in a form appropriate to the algorithm:

- **For graph-based clustering (Leiden):** added as a third edge-weight
  component. Pairs of files with frequent co-change get a
  weight-boost, increasing the chance Leiden groups them in the same
  community. Weight formula:
  ```
  edge_weight(a, b) = α · import_coupling(a, b)
                    + β · name_token_similarity(a, b)
                    + γ · co_change_frequency(a, b)
  ```
- **For vector-based clustering (HDBSCAN over TF-IDF or embeddings):**
  combined into the distance metric alongside topical similarity.
  Pairs with frequent co-change have lower distance, pulling them into
  the same density region. Distance formula:
  ```
  distance(a, b) = β · topical_distance(a, b)         // 1 - cosine
                 + γ · co_change_distance(a, b)        // 1 - normalised co-change
  ```
  (No structural-distance term in the vector pipeline; the topical
  vector already encodes identifier overlap, which subsumes
  name-token similarity, and import information would have to be
  injected as an additional component, which is the open question
  whether to do so.)

α, β, γ tuned on Phase 2 corpus. Initial intuition: γ and β both heavy,
α (when applicable) the lightest, for modern frontend codebases where
co-change and topical similarity are most needed. Tuning is
per-pipeline — graph-based and vector-based may settle on different
weights.

**Cold start handling.** New repo, no history → γ defaults to 0; the
other signals carry the load. Same pattern as low-confidence labels:
honest degradation when the signal isn't there.

**Cost.** `git log` over 180 days on modest repos is sub-second. Large
monorepos take seconds-to-minutes. Co-change matrix is cached and
incrementally updated on new commits — full recomputation only on
window slide.

### Topical similarity (TF-IDF or pinned embedding)

Captures what files *talk about* rather than how they're connected.
Two files with no shared imports and never co-changing might still be
a tight topical unit if their content vocabulary overlaps heavily —
or vice versa.

Per file, extract: identifiers from CBM (function/class/method/symbol
names), comments (block, line, JSDoc, docstrings), path tokens after
framework-aware stripping. The result is a text blob per file.

Two candidate vectorisations, **selected empirically in Phase 2**:

- **TF-IDF over corpus vocabulary.** Standard sklearn-style TF-IDF
  with `min_df=2`, `max_df=0.8`, `ngram_range=(1,2)`. Cosine distance.
  Fully deterministic, no model dependency, sub-second per repo.
- **Pinned local sentence-transformer.** `all-MiniLM-L6-v2`
  checkpoint (80MB, version-locked, bundled with Cortex).
  Deterministic inference settings; output rounded to 8-bit
  quantisation before clustering for cross-platform reproducibility.
  384-dim vectors. Higher signal at higher cost (tens of ms per file
  on CPU, parallelisable, content-hash cached).

LLM-generated summaries are explicitly *not* a third candidate — they
introduce non-deterministic borrowed opinion exactly like LLM
classification, which we already rejected.

The two are testable head-to-head; Phase 2 picks the winner based on
co-change agreement, eyeball check, and cost.

---

## Extraction cascade

All tiers intrinsic and deterministic.

### 1. Meta-metrics pass (free)

Read from the existing CBM index. Entity count, edge density, degree
distribution skew, directory depth and breadth, language/type
heterogeneity. Compute a complexity score for observability and
reporting only — it does NOT gate any downstream step. Earlier drafts
gated "ACDC refinement" on the complexity score; both the gate and
the ACDC step were dropped on 2026-05-16 — see §Status.

### 2. Primary clustering (algorithm selected in Phase 2)

Three candidate algorithms are tested head-to-head in Phase 2. Whichever
wins on co-change agreement, eyeball check, and cost becomes the v1
primary. All three operate on the code-content stream and consume the
combined distance described in "Co-change as semantic signal."

| Algorithm | Approach | Trade-off |
|---|---|---|
| Weighted community detection (Leiden) | Community detection on CBM edges, edge weights combine imports + name-tokens + co-change | Graph-native, original spec direction, well-understood — note: this is *inspired by* ACDC's pattern-driven approach but uses Leiden rather than being a literal ACDC pattern |
| TF-IDF + HDBSCAN | Vectorise text per file, cluster by cosine distance combined with co-change | Cheap, deterministic, no model dependency |
| Pinned-embedding + HDBSCAN | Sentence-transformer per file, cluster by cosine distance combined with co-change | Stronger topical signal at higher cost |

Phase 2 selects the winner. Until then the cascade is parametric over
"primary clustering" — downstream steps don't care which algorithm
produced the clusters.

Per-algorithm noise handling: HDBSCAN naturally produces noise points
the clustering wasn't confident enough to assign. The HDBSCAN pipelines
post-process noise via nearest-cluster assignment (formerly framed as
"orphan-adoption"; now an internal step of the HDBSCAN candidates).
Leiden doesn't produce noise the same way — singletons become bare
nodes per step 4 below.

### 3. Directory grouping (floor)

Code entities no clustering algorithm claimed. Labels from directory
name. This is the genuine answer for genuinely ungrouped entities, not
a fallback for a failed cascade.

### 4. Bare-node computation

Code entities whose domain loyalty splits across clusters become bare
nodes. The split loyalty is recorded as inter-frame affinity.

---

## Labeling

A label-source pipeline runs after primary clustering. Step 1
identifies the **anchorable** member set; steps 2–4 select a label
from that set. First match wins on steps 2–4.

### 1. Anchorable filter (apply to every cluster member)

Exclude from labeling consideration:

- **Infra-node deny-list:** files whose stripped basename matches
  `index|types|errors|utils|constants|deps`, or whose name ends in
  `.test|.spec|.stories|.d`. They may belong to the cluster but should
  not name it.
- **High-degree exclusion:** files whose in-degree exceeds the cluster's
  P90 in-degree by ≥2×. Catches dispatchers / re-export hubs that the
  deny-list missed.

This subsumes the original "fan" pattern from earlier drafts.

### 2. Frequency-dominant name-token across anchorable members

Tokenise file paths and symbol names after the framework-aware
stripping pass; pick the highest-frequency token across the cluster.
Penalised for generic tokens (`util`, `helper`, `common`, `core`,
`misc`, `shared`, `service`, `manager`, `handler`).

### 3. Dominator symbol name (Phase-2 candidate)

For each cluster, identify the entity that dominates it (graph-theoretic
dominator over the CALLS/IMPORTS subgraph). Use its bare name as the
label. Phase 2 A/B-tests this against #2 via eyeball check; if it
clearly wins on multiple archetypes it replaces #2 as the primary
label source. Until then, #2 is the v1 default and dominator is the
candidate alternative.

### 4. Directory name

The cluster's modal parent directory after framework-aware stripping.
Fallback when name-token frequency produces only generic-token hits.

### 5. Markdown-section match

If the repo's README has a section heading referencing ≥2 files all in
the same frame, the heading becomes the label. Novel signal from the
research brief. Bonus when it fires; unreliable as primary.

---

## Bare nodes as gravity signal

A code entity with split domain loyalty is evidence that the frames it
bridges are related. Multiple bridging bare nodes between auth and
payments = strong auth-payments affinity.

Affinity feeds the layout engine's gravity model alongside other
signals:

- **Same layer (taxonomy)** — high gravity (from `frame-ranking.md`)
- **Bare-node bridges** — affinity gravity between specific frame pairs
- **Shared import neighbourhoods** — structural coupling gravity
- **Shared decision governance** — semantic gravity (downstream of
  extraction)

Combined into a weighted force model that positions frames
deterministically from shared state. No special visual treatment for
affinity — no explicit inter-frame edges in v1. The positioning *is*
the affinity readout.

---

## Confidence and degraded output

Determinism is the load-bearing property. Cortex extracts and labels
purely from intrinsic signals; it does not ask the user, accept
configuration, or call out to LLMs. The trade-off is that on
pathological repos (weak naming, no clear dominators, mixed
architectures), some clusters end up with low-confidence labels.

The honest behaviour: **render the imperfect label as-is.** A frame
called "the cluster around schema.ts" is uglier than "data" or
"persistence", but it accurately reflects what Cortex was able to infer
from the code. The user understands the algorithm did its best; the
label is the honest output.

What v1 does *not* do:
- Prompt the user to confirm or rename a cluster
- Accept a `.cortex/frames.yaml` or any external config to override
  cluster decisions
- Use LLMs to "polish" weak labels at runtime
- Fall back to human-curated overrides

All of these would compromise determinism (different users would see
different canvases on the same repo) or reintroduce outside control
(borrowed opinions from templates/LLMs).

What v1 *does* do:
- Surface a `confidence` value on the frame so the renderer can
  visually de-emphasise low-confidence frames (e.g. lighter border,
  italicised label)
- Log low-confidence clusters during indexing so the algorithm's
  weak spots are visible to maintainers
- Continue to evolve the intrinsic-signal pipeline as a more reliable
  path than user input

Future work may revisit this — there is likely a better way to lift
weak clusters without compromising determinism (e.g. richer intrinsic
signals, deterministic LLM with hash-cached output, structural
heuristics not yet tried). v1 accepts the constraint and ships honest
output.

---

## Verification

Intrinsic-only — no human evaluation, no expert ground-truth clustering,
no MoJoFM scoring (which requires human-authored ground truth). Three
phases, cheapest first; each gates the next.

**Phase 1 — Index-stats survey (upfront).** Before committing complexity
thresholds, pull index stats (entity count, edge density, directory
depth) across a spread of active GitHub repos — mix of new/old,
small/large, web/CLI/ML/library/monorepo. Plot distributions. Set the
complexity threshold empirically rather than by guess. Starter target
`entity_count > 300 OR edge_density > 0.05` gets calibrated against
real distributions.

Run on 2026-05-16 over an 8-repo corpus (Cortex itself + vueuse, TanStack
table, trpc, nuxt/ui, cobra, click, peft); script + corpus in
`scripts/frame-extraction/`, raw results in
[phase-1-results.md](./phase-1-results.md). Distribution observations:

| stat | min | p25 | median | p75 | max |
|---|---:|---:|---:|---:|---:|
| entity_count | 621 | 1222 | 2441 | 3701 | 9879 |
| edge_density | 1.346 | 1.448 | 1.713 | 3.005 | 4.588 |

Finding: the starter threshold (`entity_count > 300 OR edge_density >
0.05`) is two orders of magnitude below the corpus floor. Every active
project blows past it, so the gate as written would have been
effectively always-on. Combined with a cost re-check on ACDC's three
patterns (near-linear dominator, O(V) fan, O(N·K) orphan-adoption with
K small), neither the cost argument nor the data motivates a gate.

**Resolution (2026-05-16):** the complexity gate is dropped, and ACDC
refinement is dropped as a cascade step entirely — see §Extraction
cascade and §Status. The valuable bits of ACDC are absorbed:
fan-pattern becomes the anchorable-filter at §Labeling step 1;
orphan-adoption becomes internal noise-handling in the HDBSCAN
pipelines; dominator becomes a Phase-2 candidate label source A/B'd
against name-token frequency. The meta-metrics pass still runs for
observability — the complexity score is reported, just not gated on.

**Phase 2 — Algorithm selection (3-way comparison).** Build all three
candidate primary clustering algorithms (Leiden community detection,
TF-IDF + HDBSCAN, pinned-embedding + HDBSCAN). Run each over the same
input on a 5-repo test sample spanning target archetypes:

- One Nuxt app
- One React SPA without Next.js
- One Go service
- One Python ML/research repo
- One mid-size TS monorepo

For each (algorithm, repo) pair, measure:

- **Silhouette score** — internal cluster cohesion vs separation
- **Co-change agreement** — fraction of frequently-co-changing pairs
  landing in the same cluster
- **Import agreement** — fraction of strongly-importing pairs landing
  in the same cluster
- **Noise rate** — fraction of files unclassified by the primary
  clustering. Reported pre- and post- HDBSCAN's nearest-cluster
  noise-handling so both signals are visible
- **Cluster count** — should land in 4–15 range; runaway counts (>30)
  or collapse (<3) are failure signals
- **Determinism** — re-run, expect byte-identical output. All three
  should pass; this is a sanity check
- **Speed + memory** — wall-clock and footprint per repo
- **Eyeball check** — for each repo, inspect 3–5 random clusters from
  each algorithm. Do the file groupings make sense?

**Decision criteria:**
- Pinned embeddings clearly win if they produce ≥10% better co-change
  agreement on ≥3 of 5 repos AND eyeball-check agrees, with cost in
  reason
- TF-IDF wins if results are within noise of embeddings (cheaper,
  simpler, no model dependency)
- Leiden community detection wins if it materially outperforms both
  vector-based approaches on co-change agreement (graph structure
  matters more than topical similarity for these targets)
- Mixed result (different winners by archetype) motivates either
  per-archetype routing or multi-view clustering combining the best
  two

Co-change is incorporated into all three pipelines as a distance
component, so the comparison isolates the contribution of the
clustering algorithm itself, not whether co-change helps.

If no algorithm produces sensible output on multiple repos, stop and
reconsider before proceeding to Phase 3.

**Phase 3 — Full corpus run.** 25-repo corpus from research brief §5.
Full cascade + ranking + layout. Verify:
- **Mechanical correctness** — runs cleanly on every repo, every
  entity assigned (frame / bare node / aggregate)
- **Determinism** — re-running the pipeline produces byte-identical
  output (same frame IDs, members, labels, ranks, layout positions);
  cross-machine determinism within platform-float tolerances
- **Output statistics** — distribution of frame counts, label-source
  mix, low-confidence rate, aggregate-vs-frame ratio

Quality judgement is *not* part of formal verification. Maintainers
spot-check output during development; real-world use produces feedback.
The algorithm doesn't need to pass a formal evaluation before shipping.

Iterate on pattern weights, label penalties, thresholds based on the
intrinsic data plus maintainer judgement.

---

## Open questions

1. **Primary clustering algorithm.** Three candidates (Leiden
   community detection, TF-IDF + HDBSCAN, pinned-embedding + HDBSCAN)
   tested empirically in Phase 2. Decision is data-driven, not
   pre-committed.
2. **Dominator vs. token-frequency as primary label source.** Phase 2
   eyeball-check runs both per (algorithm, repo) pair and picks. If
   dominator clearly wins on multiple archetypes it replaces #2 as the
   default; otherwise token-frequency stays and dominator remains a
   candidate worth revisiting.
3. **Entity granularity on large repos.** On a 10k-entity repo,
   running primary clustering over every function may be slow.
   Candidate two-pass approach: files as initial nodes; refine to
   function-level when a cluster's internal fragmentation suggests it.
4. **Auxiliary detection thresholds.** Starter (no empirical basis):
   ≥20 entities AND ≥80% extension dominance AND CV(size) < 0.3 AND
   zero outbound imports. All four for confidence; calibrate on
   Phase-1 corpus distributions.
5. **Name-token similarity computation.** Used in the Leiden pipeline
   as an edge-weight component, after framework-aware path stripping.
   (For vector pipelines, name tokens are already part of the text
   blob, no separate similarity calculation.) Candidates for the
   Leiden case: Jaccard on stripped filename + symbol-name sets
   (deterministic, cheap), edit distance (deterministic, slower).
   Lean: Jaccard for v1.
6. **Auxiliary content not in CBM.** Images, fonts, lockfiles aren't
   parsed by CBM grammars and have no graph presence. Discovery is via
   filesystem walk, not the CBM index. The auxiliary detection layer
   needs both data sources with consistent rules between them. Not yet
   designed.
7. **α, β, γ tuning per pipeline.** Edge-weight (Leiden) and
   distance (HDBSCAN over TF-IDF or embeddings) formulas both combine
   import / topical / co-change signals at different weights. Tuning
   is per-pipeline because the components mean different things in
   each. Initial intuition: γ ≥ β > α for modern frontend codebases
   (where co-change dominates). Calibrate on Phase 2 corpus. Tuning
   may also be per-archetype (γ heavier on low-import-density
   codebases like React SPAs, lighter on import-rich Go services).
8. **Big-commit threshold for co-change.** Initial: 50 files. Drops
   format-passes, bulk-renames, initial imports. Calibrate on Phase 1.
9. **Co-change time window.** Initial: 180 days from `HEAD.committer_date`.
   Trade-off: too short and recent code has no signal; too long and
   stale architecture pollutes the matrix. Tune on Phase 1.
10. **Service-suffix stripping edge case.** In service-oriented codebases
    where the role *is* the domain (`OrderService`, `BillingService`),
    aggressive suffix stripping loses signal. Heuristic: strip suffixes
    only when the prefix is itself a domain token; preserve when the
    role IS the unique identifier. Calibrate on Phase 1.

---

## Status

Adopted as v1 direction 2026-04-24 during brainstorm pass on
`cortex-multiplayer-spec.md` §8. Reconciled 2026-04-28 to remove the
interactive confirmation flow and `FrameConfirmation` entity in favour
of strict determinism: Cortex extracts and labels purely from intrinsic
signals; low-confidence output is rendered honestly rather than
prompting the user.

Extended same day to add (a) co-change history from git log as a
fourth intrinsic signal — the strongest semantic signal for
fragmented-domain detection; (b) framework-aware path tokenisation
that strips conventional segments before computing name-token
similarity; (c) topical similarity (TF-IDF or pinned-embedding)
alongside structural and co-change signals.

Phase 2 reframed as a 3-way algorithm-selection check: Leiden
community detection vs TF-IDF + HDBSCAN vs pinned-embedding + HDBSCAN.
Decision is data-driven, not pre-committed. ACDC's three patterns
(dominator, fan, orphan-adoption) provide labelling and refinement
regardless of which primary clustering wins — these *are* original
ACDC patterns, distinct from the Leiden community-detection candidate
that's only loosely inspired by ACDC.

Upfront index-stats survey on GitHub gates the complexity threshold.
Promote into the spec once Phase 2 confirms one of the candidates
produces sensible output across the target archetypes.

2026-04-29 review pass: corrected several drift items — complexity
score gates step 3 (ACDC refinement) not step 2 (primary clustering);
"ACDC subgraph-cluster" renamed to "Leiden community detection"
(accurate; it was inspired by ACDC but isn't a literal ACDC pattern);
combined-distance formula split into per-pipeline forms (edge weights
for Leiden, distance metric for HDBSCAN); auxiliary detection logic
specified as A-or-all-of-B; aggregate visual specs moved to
`frame-ranking.md` where rendering decisions live.

2026-05-16 simplification, post-Phase-1: dropped the complexity gate
and ACDC refinement as a cascade step. Phase 1 data showed the gate
never fires on the corpus and the cost case for skipping ACDC on
small repos didn't survive a complexity re-check. The three ACDC
patterns were absorbed where they were actually load-bearing —
fan-as-anchorable-filter into the labeling step, orphan-adoption into
HDBSCAN's internal noise-handling, dominator demoted to a Phase-2
A/B candidate against token-frequency labeling. Cascade goes from 5
steps to 4. Recorded as decision
`fa6aedaf-479b-4a40-96b7-1500a1973428` (superseded; new decision links
to this entry).

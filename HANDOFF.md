# Cortex — Session Handoff (2026-06-07, label-quality verdict + label rendering)

## TL;DR (2026-06-07 session — read this first)

Adjudicated the open "is F1 specificity too harsh?" question **empirically and
cheaply** (manual inspection of the cached corpus, no new LLM harness), then
shipped two changes off the finding:

1. **Verdict: the F1 metric is sound; the LLM validator (Phase B.2) is NOT
   needed.** Reconstructed per-cluster scores offline from the cached
   `clusters/`+`blobs/` data via the real `scoreClusters` (258 clusters, median
   F1 0.468, clean bimodal). The sub-0.5 clusters are **correctly** penalised —
   their labels are genuinely vague (directory names `examples`/`demo`, the repo
   name `saleor`, tech tags `react`/`graphql`). Low F1 = a real signal about
   weak labels, not metric harshness. The only sliver of genuine harshness is
   multi-word labels where one term saturates the repo (`TableDevtools` in a
   table lib). ⇒ **Phase B.2 dropped from the critical path; the F1 gate is
   unblocked.** The lead the metric actually surfaced: improve `pickFrameLabel`
   to stop emitting repo/dir/tech-name labels.
2. **Shipped: path-ordered multi-word label rendering** (decision `11c742ec`,
   merged). `pickFrameLabel` now renders two-word labels path-like —
   `saleor/graphql`, `react-query` — ordered by directory nesting (ancestor
   first, fixing reversals like `get api`→`api/get`), `/` for hierarchy and `-`
   for same-segment compounds. Measured: 79% of two-word labels already in path
   order, ~1% reversed, 20% same-segment. Display-only, metric-safe (`splitSymbol`
   splits on `/` and `-`). New helper `formatPathOrderedLabel`, 4 tests.
3. **Shipped: viewer matches decision-governed paths to frames by membership**
   (decision `ccd1ab6c`, merged). The viewer's `path.startsWith(label + '/')`
   matcher conflated frame *labels* with real paths — fragile, and worse once
   labels contain `/`. Replaced with cluster-membership matching via new tested
   `adapters.js` helpers `buildFramePathIndex`/`frameIdForPath`. Gate-0 visual
   QA passed (labels render, decision dots/leader-lines draw, file-ref click
   resolves, zero console errors).

- **Branch:** `main`, both above merged (not yet pushed). **TS tests 719/719
  green, `tsc` clean.** Graph reindexed (110 frames).
- **Minor quirk found during QA:** at least one decision stores a *basename*
  (`frame-candidates.ts`) in `governs`, not a full file_path, so neither old nor
  new viewer matcher resolves it — pre-existing data-shape issue, not a regression.

---

## Prior session TL;DR (2026-06-06, label-quality arc)

This session delivered an **independent label-quality metric** for frame extraction
and the harness to validate it — and, in validating it, found the validator
itself can't yet answer the question. Specifically:

1. **Diagnosed the red C test-runner** as a misdiagnosis: it's stale C test
   fixtures from the Phase-4 schema fold, not "environmental store-open failure."
   (decision `589d9e3c`)
2. **Shipped the deterministic label-quality metric (Phase A)** — label scored
   as a corpus classifier (coverage × specificity → F1), breaking the circular
   `checkLabelQuality`. Wired into `eval:frames`, with a committed baseline.
3. **Shipped the LLM intruder-detection validator (Phase B)** + a label/blob
   **tokenizer-alignment fix**. The validator runs as an opt-in `--validate`
   phase of `eval:frames` with the Anthropic SDK lazy-loaded so the gate path
   never touches it; defaults to **Sonnet 4.6**.
4. **Ran the validator** and found it is **confounded by cluster coherence** — it
   measures whether the *clustering* is coherent, not whether the *label* is good,
   so it cannot yet adjudicate the open specificity-harshness question.
   (decision `8d2ced0c`) The fix is a per-candidate redesign (**Phase B.2**).

- **Branch:** `main`, all the above merged. **Pushed to `origin/main`.**
- **TS tests:** full suite green (710/710 on the last full run; build `tsc` clean).
- **Decisions captured:** `589d9e3c` (C-runner), `8d2ced0c` (validator confound).

---

## What shipped this session (all merged to `main`, pushed)

### 1. C test-runner red — root cause diagnosed (decision `589d9e3c`)
`make -f Makefile.indexer test` → 2486 pass / 194 fail. The earlier "store can't
open / environmental" framing was wrong: the store opens fine. ~191 of 194 are
**stale C fixtures from the Phase-4 schema fold** (commit `763344d`) —
`ctx_store_open_memory()` no longer creates the `nodes`/`edges` tables (delegated
to Cortex's TS `GraphStore.migrate()`), `upsert_node` lowercases `kind`, and the
tables were renamed `ctx_nodes`→`nodes`. Only ~3 failures are genuinely
independent (worker-count RAM cap, targz, simhash). **Proven** by a throwaway
probe (create the canonical `nodes` schema → `upsert_node` returns `id>0`).
Fix is deferred; the recommended shape (a `th_open_store_graph()` fixture helper)
is in the decision. No code changed for this — diagnosis only.

### 2. Label-quality metric — Phase A (merged `920447e`)
New pure module **`src/frame-extraction/label-quality.ts`**: `buildCorpusIndex`,
`scoreLabel` (coverage × specificity → F1, strict-AND multi-word), `scoreClusters`,
`aggregateLabelQuality`. Non-circular because **specificity** (precision over the
whole repo) is the axis `pickFrameLabel` never optimizes. Wired into
`scripts/frame-extraction/eval-all.ts` (each `RepoEvalRow` carries `label_f1_*`);
committed baseline at `scripts/frame-extraction/baselines/2026-06-06.json`. No
hard gate threshold yet (deferred per spec). 11 unit tests.

### 3. Label tokenizer fix (merged in the Phase B branch)
`scoreLabel` now tokenizes the label with the same `splitSymbol` used to build the
blob token sets (camelCase + `._-/` split), so compound labels like
`method_comparison` match blobs that store the parts split. (Confirmed false-zero
on `huggingface/peft`; was a 1/270-cluster effect, not the high-leverage fix the
first review hypothesized — see "what we learned" below.)

### 4. Label-quality validator — Phase B (merged `be26aa4`)
- **`scripts/frame-extraction/intruder.ts`** — pure, seedable intruder-trial
  construction (ground truth = cluster membership); candidates are **shuffled**
  (no positional bias).
- **`scripts/frame-extraction/validate-labels.ts`** — the only `@anthropic-ai/sdk`
  import; lazy-loaded.
- **`eval-all.ts`** `--validate` / `--validate-sample` / `--seed` flags + a
  corpus-wide F1↔intruder-accuracy report. Default gate path (`npm run eval:frames`)
  loads no SDK; isolation verified.
- Validator default model → **Sonnet 4.6** (merged `63f100d`); `--model
  claude-opus-4-8` to spot-check.

---

## The headline finding — the validator is confounded (decision `8d2ced0c`)

First corpus-wide `--validate` run (Sonnet 4.6, 122 trials over 11 repos):
overall intruder-detection accuracy **0.877**; F1≥0.5 band **0.919** vs F1<0.5
band **0.833** (nearly flat); point-biserial **r(F1, intruder_found) = 0.077**.

At face value: "F1 specificity is far too harsh." **That conclusion is unsafe.**
The test shows the LLM the label **and** the candidate file contents, so for a
coherent cluster it spots the planted intruder from the files regardless of label
quality. **Proof:** both trials whose label was the opaque `cluster:N` fallback
(zero label information) were solved **100%**. So the validator measures *cluster
coherence*, not *label quality*, and cannot adjudicate the specificity question.
The big "F1<0.5 but intruder found" bucket (`demo`, `examples`, `composables`…)
is confounded — **not** evidence of harshness.

The deterministic F1 metric + gate (Phase A) are unaffected; what's deferred is
the *independent validation* of that metric.

---

## Next priorities (suggested — revised 2026-06-07)

1. **Set the F1 gate threshold** in `eval-all.ts` — now **unblocked** (the
   2026-06-07 verdict established the raw F1 distribution is trustworthy). Gate
   **regression-relative** (weighted-F1-per-repo vs the committed baseline, with
   tolerance for clustering nondeterminism) plus a soft absolute floor. Do NOT
   use a hard per-cluster floor: median F1 is 0.468, so ~half the corpus sits
   below 0.5 by nature of legitimately-vague labels.
2. **Improve `pickFrameLabel` (the high-value lead the metric surfaced).**
   Stop emitting non-characterising labels — stopword the repo name (e.g.
   `saleor` on ~20 saleor clusters), structural dir names (`examples`, `demo`,
   `content`, `migrate`), and deprioritise bare framework tags (`react`,
   `graphql`). The F1 metric is now the yardstick to measure the improvement.
3. **Phase B.2 (per-candidate LLM validator) — DEMOTED to optional.** No longer
   on the critical path: the cheap inspection already adjudicated harshness. Only
   build it if independent validation of the metric is later wanted for its own
   sake. Shape still in decision `8d2ced0c` + spec "Phase B run outcome".
4. **Artifacts the inspection flagged** (each small): nuxt `composables` cluster
   scores coverage 0.00 (label token absent from member blobs — tokenization/path
   edge worth a look); duplicate `member_paths` (saleor/TanStack/trpc) inflate
   clusters; trpc fragments generated `.gen.ts` into 9 near-identical `routers`
   clusters.
5. **C test harness fixtures** — implement the deferred fix from `589d9e3c`
   (`th_open_store_graph()` fixture that creates the canonical `nodes`/`edges`
   schema; lowercase the stale capitalized-label assertions; rename `ctx_nodes`
   in `test_sqlite_writer`).
6. **Fix the `detect_changes` MCP tool** — it's a half-migrated multi-project-routing
   straggler that fails with `binary_failed: … project not found`. The MCP tool was
   migrated to per-call routing and now sends `{ repo_path }` + pins `CORTEX_DB`
   ([code-tools.ts:450](src/mcp-server/tools/code-tools.ts#L450)), but the indexer
   binary's `handle_detect_changes` still reads a `project` *name* arg and resolves
   the working tree via `get_project_root(srv, project)`
   ([handlers.c:2663-2690](internal/indexer/src/handlers/handlers.c#L2663-L2690));
   `get_project_root` returns NULL the instant `project` is null, so with no
   `project` sent it errors "project not found". (The CLI path still passes
   `project` — [index.ts:72](src/cli/commands/index.ts#L72) — so the binary matches
   the CLI contract, not the MCP one.) **Preferred fix:** make `handle_detect_changes`
   use the passed `repo_path` as the working-tree root directly (it's already pinned
   alongside `CORTEX_DB`), rather than resolving a `project` name it no longer
   receives — keeps the per-call-routing intent. Non-blocking: `index_repository`
   detects changes internally, so reindexing is unaffected; only the standalone
   "git diff → affected symbols" impact tool is broken.
7. **(Parked)** clustering nondeterminism — HDBSCAN gives run-to-run variance
   (`cobra` collapsed to 0 clusters one run; `vueuse` 2↔12 clusters); a clustering
   `--seed` would make baselines reproducible. `vercel/commerce` intermittently
   fails clustering (`Python exit 1`).

## Honest caveats

- The label-F1 baseline is **inherently approximate** because clustering is
  nondeterministic; treat per-repo numbers as indicative, not exact.
- The validator LLM run needs `ANTHROPIC_API_KEY` and is **internal-only / never
  per-user** (spec non-goal). It validates shared code once over the corpus.

## Pointers

- **Spec:** [label-quality signal design](docs/superpowers/specs/2026-06-06-label-quality-signal-design.md) (read the "Phase B run outcome" section)
- **Plan:** [label-quality implementation plan](docs/superpowers/plans/2026-06-06-label-quality-signal.md) (Phase B.2 not yet written)
- **Decisions:** `589d9e3c` (C-runner stale fixtures), `8d2ced0c` (validator confound + Phase B.2 redesign), `11c742ec` (path-ordered label rendering), `ccd1ab6c` (viewer membership matching)
- **Key code:** metric `src/frame-extraction/label-quality.ts`; label rendering `src/frame-extraction/inject-frames.ts::formatPathOrderedLabel`/`pickFrameLabel`; viewer matchers `src/viewer/adapters.js::buildFramePathIndex`/`frameIdForPath`; validator `scripts/frame-extraction/intruder.ts` · `validate-labels.ts`; harness `scripts/frame-extraction/eval-all.ts`; baseline `scripts/frame-extraction/baselines/2026-06-06.json`
- **Reproduce the 2026-06-07 verdict:** the inspection ran offline from the cached `clusters/`+`blobs/` via the real `scoreClusters` (no pipeline re-run); 258 clusters, 137 slash / 36 hyphen / 1 spaced-fallback / 81 single-word labels after the rendering change.
- **Run the validator (optional, Phase B.2 only):** `ANTHROPIC_API_KEY=… npm run eval:frames -- --validate --seed 1` (add `--model claude-opus-4-8` to spot-check judge strength)

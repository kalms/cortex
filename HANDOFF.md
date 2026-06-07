# Cortex — Session Handoff (2026-06-07, cross-language contract edges + label-quality)

## ⚑ VERIFICATION PASS (2026-06-07, latest — read this first)

Verified HANDOFF claims against reality and fixed the gap that mattered for
tool effectiveness:

- **Label-quality arc — ACCURATE.** Metric, F1 gate (`evaluateF1Gate`, wired
  into `eval:frames` by default), path-ordered rendering (`formatPathOrderedLabel`),
  viewer membership matching (`buildFramePathIndex`/`frameIdForPath`) all exist
  and match the descriptions; 78 tests cover them.
- **`index_repository` mode gap — CLOSED + merged** (decision `0155458d`):
  schema `mode` enum, threaded through `callIndexer`, folded into the cache key,
  `cortex index --mode` flag, allowlist entry removed. 766/766 TS tests, `tsc`
  clean.
- **The real problem found: the live graph tooling was serving STALE/EMPTY data.**
  `.cortex/db` (canonical, the only write target) had drifted to **0 bytes**;
  reads silently fell back to a 2-day-old `graph.db` with `project=""`, no
  frames, and no contract edges. So `check_contracts` returned **0 mismatches**
  — not because the seam was clean, but because no `BINDS_KEY` edges persisted.
  The detection logic was correct (live source-scan + regression guard always
  found the 2 mismatches); the persistence/read layer was broken.
- **FIXED by a clean reindex** (`./bin/cortex index`): `.cortex/db` now 50MB,
  all nodes keyed to the project, **118 frames / 7 clusters**, **14 anchors / 19
  BINDS_KEY edges (14 provides + 5 consumes)**. MCP `check_contracts` now
  surfaces the 2 real mismatches (`detect_changes`, `ingest_traces`) and shows
  `index_repository` matched — **end-to-end, no plugin restart needed.** The
  earlier `project=""`/0-edge state was stale DB, NOT an `inject.ts` bug.
- **Watch-for:** the canonical `.cortex/db` can drift to 0 bytes (WAL not
  checkpointed / file truncated) and reads fall back to a stale `graph.db`
  without warning. A `./bin/cortex index` (or `index_repository`) rebuilds and
  checkpoints it. See memory `project-graph-db-stale-reads`.
- **Still open (genuine):** `detect_changes` C-side fix (the one remaining real
  contract mismatch — `ingest_traces` is a parser false positive). See NEXT STEP
  below.

## TL;DR (latest — cross-language contract edges, read this first)

Shipped a new **`src/contracts/`** subsystem that makes the C↔TS RPC seam a
first-class graph fact — built to fix the "graph isn't reached for because grep
substitutes for everything it does" gap, by adding the one capability grep
*can't* do: cross-language contract impact. (Decision `ffff6d54`; spec
[2026-06-07-cross-language-contract-edges-design.md](docs/superpowers/specs/2026-06-07-cross-language-contract-edges-design.md);
plan [2026-06-07-cross-language-contract-edges.md](docs/superpowers/plans/2026-06-07-cross-language-contract-edges.md).)

- **What it does:** a TS post-index pass scans `callIndexer("tool",{keys})`
  consumers and `ctx_mcp_get_*_arg(args,"key")` providers in `handle_<tool>`,
  and writes `Anchor` nodes + `BINDS_KEY` edges (`{role,keys,symbol,line}`) into
  `.cortex/db`. Wired after `runFrameExtraction` in both CLI + MCP index paths
  (never throws into indexing; gate `CORTEX_CONTRACTS=0`). New **`check_contracts`**
  MCP tool reads the persisted edges → arg-key mismatches + coverage.
- **Verified end-to-end on the live graph:** 15 anchors / 19 `BINDS_KEY` edges;
  `check_contracts` surfaces the mismatches. Built via 8 TDD tasks, two-stage
  reviewed; **760/760 tests** green, `tsc` clean.
- **Findings the tool discovered on first run** (3 allowlisted in the regression
  guard `tests/regression/contracts-rpc-seam.test.ts`):
  1. **`detect_changes`** — the known HANDOFF #4 bug, now with a **live regression
     guard** (TS sends `repo_path`; C reads `project`/`base_branch`/`scope`/`depth`,
     never `repo_path`). Remove the allowlist entry when #4 lands → guard enforces it.
  2. **`index_repository`** — *real gap*: the C handler reads a `mode`
     (fast/moderate) arg that the MCP schema (`indexRepositoryShape`) never
     exposes, so no caller can choose index depth. Fix: add `mode` to the shape.
  3. **`ingest_traces`** — *parser limitation* (not a bug): the handler reads
     `traces` via raw `yyjson_obj_get`, not the `ctx_mcp_get_*_arg` convention the
     parser models. Don't broaden the parser to `yyjson_obj_get` (it's used
     everywhere for response-building → massive over-capture); needs a targeted approach.
- **Follow-ups (named in the spec):** event/config-key anchors on the same model;
  the typed-manifest approach (C) for the RPC layer; refine the parser for
  raw-yyjson handlers.

## ✅ DONE (2026-06-07) — `index_repository` `mode` gap closed (decision `0155458d`, merged)

The contract checker's first real finding is fixed and merged to `main`.
- Added `mode: z.enum(["fast","moderate","full"]).optional()` to
  `indexRepositoryShape` and threaded it through the `callIndexer` call site
  ([code-tools.ts](src/mcp-server/tools/code-tools.ts)); the C
  `handle_index_repository` already read the arg.
- **Cache correctness (beyond the original fix shape):** folded `mode` into
  `computeCacheKey` ([cache.ts](src/db/cache.ts)) so a `fast`/`moderate`
  snapshot is never served for a deeper `full` request; `full` hashes
  identically to the historical no-mode key (existing cache entries stay valid).
- Added a validated `cortex index --mode` flag (`resolveIndexMode` in
  [index.ts](src/cli/commands/index.ts)).
- Removed `"index_repository"` from `KNOWN_MISMATCHES` in
  [tests/regression/contracts-rpc-seam.test.ts](tests/regression/contracts-rpc-seam.test.ts);
  the seam guard now enforces the contract permanently.
- **Verified:** 766/766 TS tests green, `tsc` clean. `runContractExtraction`
  on the live graph: mismatches **3 → 2** (only the still-allowlisted
  `detect_changes` + `ingest_traces` remain). Built TDD (3 red→green cycles).

**Plugin caveat still applies:** the running Cortex MCP plugin is the
**pre-merge build**, so the `check_contracts` MCP tool reflects the old
mismatch count until the plugin is **rebuilt and restarted**. Exercise the
pass directly meanwhile:
`npx tsx -e "import('./src/contracts/run-contracts.ts').then(m=>m.runContractExtraction({repoPath:process.cwd(),project:'Users-rka-Development-cortex',dbPath:'.cortex/db'}).then(r=>console.log(JSON.stringify(r))))"`.

## ✅ DONE (2026-06-07) — `detect_changes` routed by `repo_path` (decision `4cad5308`, merged)

The last genuine contract bug is fixed and merged. `handle_detect_changes` now
uses the passed `repo_path` as the working-tree root, derives the project name
from it (`ctx_project_name_from_path`) for the impacted-symbols filter, and
opens the addressed graph DB from the pinned `CORTEX_DB` (query-only, NULL-safe)
— no more `get_project_root(project)` / "project not found". Also: MCP exposes
`base_branch`/`scope`/`depth`; the CLI `cortex index changes` sends `repo_path`
+ pins `CORTEX_DB`; and `detect_add_impacted_symbols` now filters **lowercase**
`file`/`folder`/`project` labels (Phase-4 fold) so structural nodes stop leaking
into results. Indexer binary rebuilt via `scripts/build-indexer.sh` (version
restored to `0.1.0`).
- **Verified at runtime:** `detect_changes` returns the changed files + 139
  impacted code symbols (no error); `scope=files` → 0 impacted. `check_contracts`
  (MCP, live): **mismatches 2 → 1** — only `ingest_traces` remains. 770/770 TS
  tests, `tsc` clean.
- **Note:** the running plugin's TS is still pre-merge (schema won't show the new
  optional params until restart), BUT the binary is spawned per-call, so the core
  fix is already live — the pre-merge MCP sends `{ repo_path }`, which the new
  binary now reads correctly.

## ✅ DONE (2026-06-07) — repo-name label suppression in `pickFrameLabel` (decision `9c05cabc`, merged)

The #1 label-quality lead. The biggest low-F1 bucket was frames labelled by the
repo name / top package (e.g. `saleor` on ~33 clusters) — ubiquitous across the
repo, so non-distinguishing, but uncatchable by the per-cluster salience gate.
- New pure `ubiquitousPathSegments()` ([inject-frames.ts](src/frame-extraction/inject-frames.ts))
  computes path segments present in ≥90% of members across **all** clusters,
  guarded to fire only with ≥2 clusters (one cluster → the shared prefix IS the
  best label). Threaded into `pickFrameLabel` as `suppressedTerms` (gate + both
  path fallbacks); wired through `buildFrameAssignments` and `scoreClusters` so
  injected labels and the F1 metric agree.
- **Deterministic offline check** on cached `saleor` data (82 clusters):
  "saleor"-containing labels **33 → 0**; F1 mean **0.389 → 0.425**, weighted
  **0.361 → 0.425**; e.g. `saleor/graphql`→`mutations`, `saleor/payment`→`payment`.
  Backward compatible (default empty set). 775/775 tests (5 new), `tsc` clean.
- **Follow-up:** regenerate the committed F1 baseline across the full corpus to
  *lock* the gain. Not done here (full corpus eval is heavy + HDBSCAN-nondeterministic);
  safe to defer — an improvement never trips the regression gate (it only fails
  on >0.05 *regression* or <0.45 floor).

## ✅ DONE (2026-06-07) — `ingest_traces` typed accessor; RPC contract allowlist now EMPTY (decision `f5da5c77`, merged)

The last allowlist entry (a parser false-positive) is resolved. Added a typed
`ctx_mcp_get_array_len_arg()` to the C accessor family and used it in
`handle_ingest_traces` (instead of raw `yyjson_obj_get`); generalized the
scanner regex to `ctx_mcp_get_\w+_arg`. `KNOWN_MISMATCHES` is now `[]` — the
C↔TS RPC seam is **fully consistent** and the regression guard enforces
zero-tolerance drift. `check_contracts` (MCP, live): **mismatches 1 → 0**, 5/5
consumers matched. 776/776 tests, `tsc` clean, binary rebuilt.

## ▶ NEXT STEP — see "Trust over grep" assessment (2026-06-07) below for the prioritized roadmap

The contract arc is complete (all three findings closed; guard is zero-drift).
The next frontier is the stated goal: make agents *trust* the graph over grep
during heavy development. The assessment section lays out the gaps and a
prioritized plan (reliability/freshness first, then coverage/recall, then
the trust signals).

---

## TL;DR (2026-06-07 earlier session — label-quality verdict + label rendering)

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
4. **Shipped: F1 regression gate** (decision `2990a57e`, merged). `eval:frames`
   now enforces it by default (`--no-gate` to skip, `--baseline <path>` to
   override). Pure `evaluateF1Gate` (`src/frame-extraction/eval-gate.ts`, 8
   tests) compares the corpus **mean** weighted-F1 over repos common to both
   runs, **excludes 0-cluster (degenerate) runs**, only enforces (exit 3) at
   ≥3 comparable repos, fails on >0.05 mean regression or <0.45 floor. Smoke:
   10 repos (cobra excluded), 0.561 vs 0.562 → pass.

- **Branch:** `main`, all four merged and **pushed to `origin/main`**. **TS tests
  727/727 green, `tsc` clean.** Graph reindexed (108 frames). Four decisions
  captured: `11c742ec`, `ccd1ab6c`, `2990a57e` (this session) + the prior
  `8d2ced0c`/`589d9e3c`.
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

0. **DONE — F1 regression gate** (decision `2990a57e`). Was the prior #1; shipped
   this session. The gate is regression-relative + soft floor + degenerate-run
   exclusion, exactly as the deferred note specified.

1. **Improve `pickFrameLabel` (the high-value lead the metric surfaced).**
   Stop emitting non-characterising labels — the biggest low-F1 bucket is the
   **repo name** (`saleor` on ~20 clusters, `rubygems`…), then structural dir
   names (`examples`, `demo`, `content`, `migrate`) and bare framework tags
   (`react`, `graphql`). **Design note for next session:** `pickFrameLabel` only
   sees *member* paths, not the whole repo, so it can't measure true specificity
   itself (the repo name has member-salience 1.0, same as a good label) — hence
   the existing salience gate can't catch it. Three approaches were scoped (see
   below); **repo-name suppression** (pass the project name in, exclude it as a
   label term) is the highest-value/lowest-risk start. Whatever lands here
   **raises F1 → regenerate the committed baseline** afterward to lock the gain.
   - Options: (a) repo-name suppression [targeted]; (b) + structural-dir
     stop-list expansion [broader, risks `cluster:N` fallbacks for demo/examples];
     (c) plumb corpus document-frequency into `pickFrameLabel` for
     specificity-aware candidate selection [most principled, larger pipeline change].
2. **Phase B.2 (per-candidate LLM validator) — DEMOTED to optional.** No longer
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

- **Research report (2026-06-07):** [label-quality verdict + path-ordered rendering + the F1 gate](docs/research/2026-06-07-label-quality-verdict-and-rendering.md) — the empirical basis for decisions `11c742ec`/`ccd1ab6c`/`2990a57e` and the "F1 is not too harsh" verdict, with the offline-reconstruction method and the full distribution data.
- **Spec:** [label-quality signal design](docs/superpowers/specs/2026-06-06-label-quality-signal-design.md) (read the "Phase B run outcome" section)
- **Plan:** [label-quality implementation plan](docs/superpowers/plans/2026-06-06-label-quality-signal.md) (Phase B.2 not yet written)
- **Decisions:** `589d9e3c` (C-runner stale fixtures), `8d2ced0c` (validator confound + Phase B.2 redesign), `11c742ec` (path-ordered label rendering), `ccd1ab6c` (viewer membership matching), `2990a57e` (F1 regression gate)
- **Key code:** metric `src/frame-extraction/label-quality.ts`; gate `src/frame-extraction/eval-gate.ts::evaluateF1Gate`; label rendering `src/frame-extraction/inject-frames.ts::formatPathOrderedLabel`/`pickFrameLabel`; viewer matchers `src/viewer/adapters.js::buildFramePathIndex`/`frameIdForPath`; validator `scripts/frame-extraction/intruder.ts` · `validate-labels.ts`; harness `scripts/frame-extraction/eval-all.ts`; baseline `scripts/frame-extraction/baselines/2026-06-06.json`
- **Reproduce the 2026-06-07 verdict:** the inspection ran offline from the cached `clusters/`+`blobs/` via the real `scoreClusters` (no pipeline re-run); 258 clusters, 137 slash / 36 hyphen / 1 spaced-fallback / 81 single-word labels after the rendering change.
- **Run the validator (optional, Phase B.2 only):** `ANTHROPIC_API_KEY=… npm run eval:frames -- --validate --seed 1` (add `--model claude-opus-4-8` to spot-check judge strength)

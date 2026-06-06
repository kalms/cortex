# Cortex — Session Handoff (2026-06-06, label-quality arc)

## TL;DR

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

## Next priorities (suggested)

1. **Phase B.2 — per-candidate validator redesign** (the real next step). Replace
   the comparison-set "which of these N doesn't belong" with a per-candidate fit
   judgment: label + ONE file → "does this label describe this file? yes/no",
   scored against membership (members→yes, sampled non-members→no). The label
   becomes the only basis, so opaque `cluster:N` can't score above chance. Then
   re-run and finally adjudicate whether F1 specificity is too harsh; set the
   gate threshold from the result. Full shape in decision `8d2ced0c` + spec
   "Phase B run outcome" section.
2. **Set the F1 gate threshold** in `eval-all.ts` (regression vs baseline +
   absolute floor) — only after Phase B.2 tells us whether to trust the raw F1
   distribution or adjust specificity first.
3. **C test harness fixtures** — implement the deferred fix from `589d9e3c`
   (`th_open_store_graph()` fixture that creates the canonical `nodes`/`edges`
   schema; lowercase the stale capitalized-label assertions; rename `ctx_nodes`
   in `test_sqlite_writer`).
4. **Fix the `detect_changes` MCP tool** — it's a half-migrated multi-project-routing
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
5. **(Parked)** clustering nondeterminism — HDBSCAN gives run-to-run variance
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
- **Decisions:** `589d9e3c` (C-runner stale fixtures), `8d2ced0c` (validator confound + Phase B.2 redesign)
- **Key code:** metric `src/frame-extraction/label-quality.ts`; validator `scripts/frame-extraction/intruder.ts` · `validate-labels.ts`; harness `scripts/frame-extraction/eval-all.ts`; baseline `scripts/frame-extraction/baselines/2026-06-06.json`
- **Run the validator:** `ANTHROPIC_API_KEY=… npm run eval:frames -- --validate --seed 1` (add `--model claude-opus-4-8` to spot-check judge strength)

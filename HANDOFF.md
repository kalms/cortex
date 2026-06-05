# Cortex — Session Handoff (2026-06-05)

## TL;DR

The **import-aware frame-extraction arc is done and its honest result is mixed-to-negative.** Phase 1 (convention-aware tokenization + label salience) is the only change that touched frame quality and it shipped; the two graph-signal phases (import-affinity blend, modularity split) were built, swept, and **discarded as negative**. Phase 1 itself did **not** clearly improve label quality — it removed some egregious labels and, in exchange, strands a real number of frames at the `cluster:N` non-label. Two things are now top priority: **fix the `cluster:N` labeling bug**, and **fix + refactor the viewer/frames storage pipeline** (it's a multi-store mess and needs to be far more stable for Mesh).

- **Branch:** `main` @ `7b662d6`. **`origin/main` @ `d6a8938`** — the Phase-3 research merge (`c54e5ac`, `7b662d6`) is **unpushed**. Push when ready.
- **TS tests:** 680/680 on a clean run (`npm test`). The old cluster-determinism flake is fixed (30s timeout for cold Python-venv tests). One caveat: Python-venv integration tests can still flake under parallel cold-start; they pass in isolation.
- **`.mcp.json`:** `CORTEX_DB_PATH` override removed (by user) + MCP server restarted — multi-project routing works through the plugin now.

---

## What shipped this session (on `main`, mostly pushed)

1. **Phase 0 — eval guardrail** (`scripts/frame-extraction/eval-all.ts`, `eval-labels.ts`, corpus + baseline). `npm run eval:frames`.
2. **Phase 1 — convention-aware tokenization + label salience** — the one frame-quality change. New `structural-tokens.ts`; `path-tokenize.ts` drops `[brackets]`/`(groups)`, strips leading `use`, drops route-method suffixes; `pickFrameLabel` gained a ≥50%-path-salience gate + structural-token ineligibility, falling back to path-prefix then `cluster:<id>`.
3. **Plan 1b — zero-frames warning** — `frameCoverage` detector + dismissible viewer banner (Gate-0 QA'd).
4. **Read-path routing fix** — `CORTEX_DB_PATH` global override no longer defeats per-call `repo_path`; new `resolveGraphDbForRead` (`src/db/resolve-path.ts`) finds the populated store; `RepoContext.graphDbPath` threads it to all MCP read tools. **Incomplete — see Priority 2: the viewer's `openProjectStore` was NOT fixed.**
5. **Eval teardown** — `eval-all.ts` deregisters git-cloned corpus projects after a run (`--keep` opts out).
6. **Flaky-test fix** — 30s timeout on cold Python-venv cluster tests.

## What was built then DISCARDED (negative results, documented)

- **Phase 2 — import-affinity `delta`** ([docs/research/2026-06-05-import-affinity-delta.md](docs/research/2026-06-05-import-affinity-delta.md)): no safe global weight; targeted files have too few/diffuse edges, dense monorepos over-merge. Branch deleted.
- **Phase 3 — modularity split** ([docs/research/2026-06-05-modularity-split.md](docs/research/2026-06-05-modularity-split.md)): splits cortex's `cli commands` blob into *incoherent* mixed communities with `cluster:N` labels (+ label-violation regression). Branch deleted.
- **Why both failed (one cause):** the `IMPORTS`/`CALLS` graph couples files *across* the topical boundaries frames should express (CLI→decisions→MCP, tests→everything, framework leaves→shared utils). **The import graph is the wrong signal for topical grouping — do not reattempt graph-signal blends/splits.** Spec §13 records this.

## Honest verdict on label quality (don't trust the headline number)

- The "label violations 133→10" metric is **circular**: `checkLabelQuality` enforces the same rules `pickFrameLabel` was built to satisfy. It measures rule-compliance, not semantic quality. There is **no independent label-quality signal** in the eval.
- A human before/after on real corpus labels showed **net mixed**: genuine wins (`orgid design`→`design systems`, `activator email`→`activator`), several "vaguer but arguably more correct" (`account`→`admin`, `dsl compiler`→`dsl`), and a **real regression** — frames stranded at `cluster:N` (see Priority 1).

---

## PRIORITY 1 — Fix the `cluster:N` labeling bug

**Symptom:** frames render with no label, just `cluster:<id>`. Observed on the current index: anthill **1** (`cluster:0`), rosalind **4+ of 22** (`cluster:24/22/21/17`).

**Root cause:** `pickFrameLabel` (`src/frame-extraction/inject-frames.ts`) passes 1–2 require a token that is non-structural AND ≥50%-path-salient (`pathSalience` in `structural-tokens.ts`). When a frame's members span multiple directories with no ≥50%-shared token, all candidates are rejected; the path-prefix fallback (`commonPathSegmentLabel`) then finds no common informative segment and drops to the `cluster:<id>` terminal fallback. The salience gate, tuned to kill leaf-token mislabels, is too aggressive at the tail and deletes specificity (also: `dsl compiler`→`dsl`, `drizzle config`→`config`).

**Fix direction (decide + implement):** replace the `cluster:N` terminal with a real last-resort label — e.g. the most-frequent path segment even if <50%, or the top TF-IDF token regardless of salience, or the dominant directory name — and consider lowering/ramping the salience threshold so it removes noise without erasing specificity. Re-judge by *eyeballing real labels*, not the circular count. Files: `inject-frames.ts` (`pickFrameLabel`, `commonPathSegmentLabel`), `structural-tokens.ts` (`pathSalience`).

## PRIORITY 2 — Finish + refactor the viewer/frames storage pipeline

**The clusterfuck:** three stores disagree on where a project's frames live.
- MCP `index_repository` writes **`<repo>/.cortex/db`**.
- CLI `cortex index` writes the shared cache **`~/.cache/cortex-indexer/<slug>.db`** (and leaves an un-checkpointed WAL).
- The viewer's `openProjectStore` (`src/graph/code-queries.ts:198`) reads the **cache** for any non-active project.
- The read-path fix (`resolveGraphDbForRead`) only covered the MCP `RepoContextResolver` — **`openProjectStore` was not migrated**, so the viewer reads a possibly-stale cache while reindexes land in `.cortex/db`. This is why "reindex + view" showed pre-Phase-1 labels until manually worked around.

**⚠ TEMP HACK currently on disk (uncommitted):** to let the viewer render current frames, each repo's `.cortex/db` (authoritative Phase-1 frames) was `cp`'d over its `~/.cache/.../<slug>.db`. This will drift on the next index — ignore/undo it; it is not a fix.

**The work:**
1. Migrate `openProjectStore` (and any other reader) to `resolveGraphDbForRead` so the viewer reads the populated/freshest store.
2. Make the index **write** and the viewer **read** agree on ONE canonical store per project (pick `.cortex/db` *or* the cache, not both) and checkpoint the WAL after frame injection.
3. **Revisit/refactor the whole frames pipeline** (collect → cluster → inject → read), removing the store divergence and WAL footguns. **It needs to be far more stable for Mesh.** The dev server is `npm run dev` (port 3334, `/viewer`); `startViewerServer` is `src/mcp-server/api.ts`.

---

## Loose ends / state

- **Unpushed:** Phase-3 research merge (`7b662d6`).
- **Registry re-polluted:** `list_projects` again carries ~10 `Users-rka-Development-cortex-.tmp-frame-extraction-corpus-*` entries (a full `eval:frames` run re-indexed the corpus; teardown only deregisters on a full-corpus run, and these came back). Re-clean via `delete_project`, OR make teardown/registry permanently exclude `.tmp/` clones.
- **Temp cache-sync hack** (Priority 2) is live on disk, uncommitted.

## Pointers

- **Spec (with §13 outcome):** [docs/superpowers/specs/2026-06-04-import-aware-frame-extraction-design.md](docs/superpowers/specs/2026-06-04-import-aware-frame-extraction-design.md)
- **Research reports:** [import-affinity-delta](docs/research/2026-06-05-import-affinity-delta.md) · [modularity-split](docs/research/2026-06-05-modularity-split.md)
- **Field report (label quality assessment):** [field-report-2026-06-04-frame-extraction-semantic-quality.md](docs/field%20reports/field-report-2026-06-04-frame-extraction-semantic-quality.md)
- **Plans:** [Phase 1](docs/superpowers/plans/2026-06-04-frame-convention-aware-tokenization.md) · [1b zero-frames](docs/superpowers/plans/2026-06-05-zero-frames-warning.md) · [P2 (discarded)](docs/superpowers/plans/2026-06-05-import-affinity-delta.md) · [P3 (discarded)](docs/superpowers/plans/2026-06-05-modularity-split.md)
- **Key code:** frame labels `src/frame-extraction/inject-frames.ts` + `structural-tokens.ts`; tokenizer `path-tokenize.ts`; pipeline `run-frames.ts`; store resolution `src/db/resolve-path.ts` (`resolveGraphDbForRead`) + `src/mcp-server/repo-context.ts`; viewer read `src/graph/code-queries.ts` (`openProjectStore`) + `src/mcp-server/api.ts`.

# Frame Extraction Auto-Integration — Design / ADR

**Date:** 2026-05-26
**Status:** Accepted (design approved; implementation pending)
**Topic:** Make `frame_id` extraction run automatically after `index_repository`, so the frames viewer works out of the box once Cortex is installed.

---

## Context

Frames are clusters of files that belong together by topic + co-change. The `/viewer` renders one box per frame. Frames live as `frame_id` / `frame_label` / `frame_confidence` keys on `nodes.data` (no schema — they ride on the existing JSON column).

Today frame extraction is a **manual, offline pipeline** (`scripts/frame-extraction/`): run `co-change.ts`, then `cluster-tfidf-hdbscan.ts` (spawns Python/HDBSCAN), then `inject-frames.ts` (writes `frame_id` into the DB). Nothing automates it.

**The observed problem (2026-05-26 visual QA):** the viewer renders no frames for any project. Root cause: zero file nodes in any of the 10 indexed cache DBs have a `frame_id` — `inject-frames.ts` has never been run against them. Re-running the indexer also *wipes* any injected `frame_id` (the indexer replaces the `nodes` table wholesale), so even a previously-framed project loses its frames on the next index. The `frame-extraction.md` architecture doc claims "recluster + inject is fast enough that this isn't a real cost" — but only if something actually re-runs it, and nothing does.

**Speed data (this machine, Apple Silicon, warm caches), gathered to settle the "too slow to integrate" question:**

| Stage | anthill-cloud (443 files) | cortex (869 files) | rosalind (3043 files) |
|---|---:|---:|---:|
| co-change | 1.15 s | 1.09 s | 0.45 s |
| cluster:tfidf (HDBSCAN) | 1.78 s | 1.62 s | 1.91 s |
| inject-frames | 0.41 s | 0.41 s | 0.41 s |
| **total** | **3.34 s** | **3.12 s** | **2.77 s** |

For comparison: the C indexer full reindex is ~1.3 s; `npx tsx` cold-start is ~0.42 s (so ~1.2 s of the ~3 s total is three separate tsx process startups); first-time venv creation is ~170 s (one-time). HDBSCAN compute itself is ~0.3–0.5 s and does not visibly scale within this corpus size range.

**Conclusion that drove this ADR:** the earlier "clustering is minutes, not milliseconds" argument was wrong by an order of magnitude. At ~3 s per index — comparable to the indexer itself — there is no performance argument against integrating. The only real costs are the one-time Python venv setup and the fact that the clustering parameters are still under active evaluation.

---

## Decision

Integrate frame extraction as an **additive TypeScript post-index step** that runs automatically after every successful full `index_repository`, gated on an opt-out env var and the presence of a Python venv. The C indexer is untouched.

Four decisions locked during brainstorming:

1. **Trigger:** recluster on **every successful index**, default-on, opt-out via `CORTEX_FRAMES=0`. Frames are a *global* property — changing even a few files can shift cluster boundaries — so reclustering only on full reindex would leave incremental updates with stale frames; partial/stale frames are worse than a ~1.8 s recluster. Always-recluster also keeps the C indexer untouched (no need for it to report a changed/unchanged signal) and is self-healing: if frames were skipped on an earlier index (e.g., venv not yet set up), the next index fills them in. The accepted cost is that a rare incremental-noop index (nothing changed) still pays ~1.8 s for an identical recluster — deemed acceptable since you only index when you expect a change.
2. **Layer:** the TS orchestration layer (CLI `index` command + MCP `index_repository` tool), *not* the C indexer. The raw `cortex-indexer cli index_repository` C-binary path stays frame-less by design (it has no Python).
3. **Venv setup:** created at install time, foreground (~170 s once, with a progress message). If `python3` is absent, warn and skip — **never fail install**.
4. **Integration shape:** Approach A — a surgical shared helper called from both chokepoints, running the three stages **in-process** (importing the scripts' exported core functions rather than spawning three tsx subprocesses), which also reclaims the ~1.2 s tsx-startup tax (~3 s → ~1.8 s).

---

## Architecture

```
index_repository (CLI or MCP)
        │
        ▼
  [C indexer subprocess]  ──writes──▶  graph DB (cache or .cortex/db)
        │ success
        ▼
  runFrameExtraction({ repoPath, project, dbPath, signal })   ← NEW, shared
        │
        ├─ gate: CORTEX_FRAMES≠0  AND  venv present  → else {status:"skipped"}
        ├─ 1. co-change   (git log → file-pair weights)      [in-process]
        ├─ 2. cluster     (spawn venv python, HDBSCAN)       [1 subprocess]
        └─ 3. inject      (UPDATE nodes.data SET frame_id…)  [in-process, same dbPath]
```

Frames remain a purely additive overlay on `nodes.data`. No schema change. The C indexer has no knowledge of frames.

---

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `src/frame-extraction/run-frames.ts` (NEW) | Orchestrate the three stages in one process; gate on env + venv; return a structured `FrameResult`. Never throws into the index path. | the three existing script modules' exported core fns |
| `src/frame-extraction/venv.ts` (NEW) | Resolve venv path, check presence (`hasVenv()`), expose `setupVenv()` for install. Honor `CORTEX_VENV` override (tests). | — |
| `scripts/frame-extraction/co-change.ts` | Already exports its core; import rather than spawn. | unchanged |
| `scripts/frame-extraction/cluster-tfidf-hdbscan.ts` | Exports `runTfIdfHdbscan(opts)`; reused as-is (still spawns Python internally — that's the one unavoidable subprocess). | unchanged |
| `scripts/frame-extraction/inject-frames.ts` | Exports its inject core; import and call with an explicit `dbPath`. | unchanged |
| `src/cli/commands/index.ts` | After the index subprocess succeeds, call `runFrameExtraction`; render a one-line frames summary/skip note. | run-frames |
| `src/mcp-server/tools/code-tools.ts` | In the `index_repository` tool, after `callIndexer` succeeds, call `runFrameExtraction`; attach a structured `frames` field to the response envelope. | run-frames |
| install path (`src/cli/install.ts` and/or the C `ctx_install_*`) | Call `setupVenv()` at install, foreground, warn-on-missing-python. | venv |

### Venv location

Move the venv from the in-repo `scripts/frame-extraction/python/.venv` to **`~/.cache/cortex-indexer/python-venv/`** — the same directory that already holds project DBs. Rationale: when Cortex is installed as a plugin, the repo/scripts live under `~/.claude/plugins/cache/…` which may be read-only; the venv needs a writable, cross-cwd home. `CORTEX_VENV` env var overrides for tests and power users. `setup-venv.sh` is updated to target this path; the existing `npm run setup-python` continues to work for repo-local development.

---

## Data flow & the DB-path subtlety

`runFrameExtraction` writes to the **same DB the index just wrote** — it takes an explicit `dbPath` from the caller, no re-resolution:

- CLI path → cache DB (`~/.cache/cortex-indexer/<project>.db`)
- MCP path → whatever `CORTEX_DB` pointed at during indexing (typically `.cortex/db`)

This mirrors the lesson from the 2026-05-26 multi-project routing fixes: pass the resolved path through explicitly rather than letting a downstream component guess (which is exactly how the `CORTEX_DB`-override bug and the viewer's bound-store bug arose).

co-change reads `repoPath`'s git history; cluster reads file blobs from `dbPath`; inject writes back to `dbPath`. All three receive their inputs explicitly.

---

## Error handling / degradation

`runFrameExtraction` **never throws into the index path** — a successful index must not depend on frames succeeding. It returns a discriminated result:

```ts
type FrameResult =
  | { status: "ok";      framesAssigned: number; clusters: number; elapsedMs: number }
  | { status: "skipped"; reason: "venv_missing" | "disabled" | "no_files" | "no_git" }
  | { status: "failed";  reason: string };   // first line of python/stage stderr; logged, not fatal
```

Surfacing, per caller:

- **MCP** (`index_repository` tool): attach `frames` as a structured field on the response JSON envelope, so agents can read machine-readable status (e.g., `{ status: "skipped", reason: "venv_missing" }`) and decide whether to tell the user to run `cortex setup frames`.
- **CLI** (`cortex index`): append a single human-readable line to the index output (e.g., `frames: 130 assigned across 8 clusters (1.8s)` or `frames: skipped (python venv not set up — run 'cortex setup frames')`).

A `failed` status logs the stderr first line but the index call still reports success.

---

## Install / setup workflow

1. **`cortex install` / plugin postinstall:** detect `python3`. If present, run `setupVenv()` in the foreground (~170 s once) with a progress message. If absent, print a one-line warning with remediation (`install python3, then run 'cortex setup frames'`) and continue — install never fails over the Python dep.
2. **New `cortex setup frames` command:** idempotent venv (re)creation, for users who skipped at install, whose venv broke, or who installed Python after the fact.
3. **Open item:** whether `.claude-plugin/marketplace.json` supports a postinstall hook, or whether a once-per-machine SessionStart guard (marker file in `~/.cache/cortex-indexer/`) is needed. To be resolved during planning (see Open Questions).

---

## Testing

- **Unit** — `run-frames` gating logic: env off (`disabled`), venv missing (`venv_missing`), no file nodes (`no_files`), no git (`no_git`). Python stage mocked.
- **Unit** — `venv.ts`: presence detection + path resolution + `CORTEX_VENV` override.
- **Integration** — index `tests/fixtures/sample-project`, run real frame extraction, assert `frame_id` count > 0 on file nodes. Gated behind venv-present; skipped when no `python3` (mirrors the existing `cluster-tfidf-hdbscan.test.ts` skip behavior so `npm test` stays runnable without Python).
- **No new C tests** — the C indexer is untouched.

---

## Alternatives considered

**Trigger.** Rejected: *explicit opt-in only* (viewer stays empty by default — fails the "out of the box" goal); *auto on first index only* (frame_ids drift from reality as code changes, and the indexer wipes them on every reindex anyway); *decoupled post-index hook / event* (multi-process coordination complexity for no benefit at this scale).

**Layer.** Rejected: *C indexer shells out to Python* (pollutes the pure-C, zero-runtime-dep indexer; breaks portability); *new standalone `cortex-frames` binary* (a third entry point users must learn — doesn't make existing index paths "just work").

**Venv setup.** Rejected: *lazy on first frame-extracting index* (a 170 s first-index is a nasty surprise); *background async* (confusing "frames appear eventually" UX + pending-state tracking); *require system Python packages, no venv* (fragile across machines). A *pre-built per-platform venv bundle* (~50 MB) was noted as a future option if install latency becomes a complaint — deferred, not chosen, because of the macOS-arch / Linux-libc platform matrix.

**Integration shape.** Rejected: *Approach B — consolidate both call sites into one `indexRepository()` TS function* (DRYs duplication but is a bigger refactor of the working index path, and the CLI's sync `execFileSync` vs MCP's async `execFileAsync` unification is its own project — too much risk for an additive feature); *Approach C — orchestrate the 3 scripts as separate subprocesses* (keeps the ~1.2 s tsx-startup tax).

---

## Consequences

**Positive.**
- Viewer works out of the box after install + index — the original goal.
- Frame data stays current: every index reclusters, so frames never drift from the codebase (incremental changes shift cluster boundaries, and that's reflected immediately).
- C indexer stays pure C, fast, zero-runtime-dep.
- Surgical blast radius — frames are additive; the proven index path is untouched.
- ~1.8 s per index (down from ~3 s) by running stages in-process.

**Negative / accepted costs.**
- ~170 s one-time venv setup at install (mitigated: foreground, progress message, never blocks install).
- ~1.8 s added to every index, including rare incremental-noops where the recluster is identical (acceptable: comparable to the indexer pass; opt-out via `CORTEX_FRAMES=0`).
- Two call sites both invoke the helper (one line each — minor duplication, deliberately preferred over the B refactor).
- The raw `cortex-indexer cli index_repository` C-binary path produces no frames (acceptable — it has no Python; the user-facing CLI and MCP paths are covered).
- HDBSCAN parameters are still under evaluation; integrating "bakes in" the current params. Mitigated: params remain configurable via the existing `cluster-tfidf-hdbscan.ts` options, and the eval harness stays available to retune.

---

## Open questions (resolve during planning)

1. **Plugin postinstall hook** — does `.claude-plugin/marketplace.json` support running a setup script on install? If not, design a once-per-machine SessionStart guard (marker file under `~/.cache/cortex-indexer/`).
2. **Python version pinning** — `setup-venv.sh` should pin a minimum Python (≥ 3.9 to match HDBSCAN wheels) rather than assuming whatever `python3` resolves to.

*(Resolved during brainstorming — kept for the record: "incremental vs full" — the helper reclusters on **every** successful index, not just full reindexes, because frames are a global property and reclustering is cheap. No change-detection signal from the C indexer is needed.)*

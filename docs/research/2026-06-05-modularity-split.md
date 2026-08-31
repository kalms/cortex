# Research Report — TS Modularity Split (Phase 3): Negative Result

**Type:** Research report (designed experiment, not active-use feedback).
**Date:** 2026-06-05
**Author:** Claude (Opus 4.8, 1M context) + rka
**Subject:** Frame-extraction Phase 3 — splitting fused clusters by community detection on their `IMPORTS`+`CALLS` subgraph.
**Spec:** [2026-06-04-import-aware-frame-extraction-design.md](../superpowers/specs/2026-06-04-import-aware-frame-extraction-design.md) §7
**Outcome:** **Negative.** The split is incoherent and degrades labels. Implementation **discarded** (not merged); recoverable from git history.

---

## Question

Phase 1's field report flagged cortex's `cli commands` frame as a coarse blob fusing three subsystems (CLI + decisions + MCP server) that no labeling change can fix. Phase 3 asked: **can community detection on the cluster's own `IMPORTS`+`CALLS` subgraph split it into coherent sub-frames** (CLI / decisions / MCP), without regressing other repos? Acceptance (spec §7): the blob splits into ≥2 coherent frames; no corpus `noise_rate`/agreement regression.

## Method

Built a pure greedy-modularity community detector (`modularity.ts`) and a coverage-preserving `refineSplit` pass (`refine-split.ts`) that runs between Python clustering and `injectFrames`: for each cluster > 12 files, build the induced `IMPORTS`+`CALLS` subgraph among its members, detect communities, and split into ≥2 sub-clusters when modularity `Q > threshold` (sub-min communities folded into the best-connected seed; new sub-clusters relabeled via the Phase-1 path-prefix labeler). Swept `Q ∈ {0.25, 0.30, 0.40}` on cortex (the target) and private-monorepo (regression), comparing against the no-split baseline on the same code snapshot, and **inspected the actual split membership**.

## Results — before (no split) vs after (`Q=0.30`)

`noise_rate` is structurally invariant under split (members are only redistributed, never sent to noise), confirmed empirically. The signals that move are cluster count, CALLS agreement, and label quality:

| repo | clusters | CALLS agreement | label violations |
|---|---|---|---|
| cortex | 8 → 10 (+2) | 0.621 → **0.606** | 0 → **3** |
| private-monorepo | 10 → 12 (+2) | 0.571 → **0.543** | 1 → 1 |

Splits were identical across `Q=0.25…0.40` (the communities' modularity sits well above 0.40).

**The cortex split is incoherent.** The three new sub-clusters (the former blob) each *mix* subsystems and all fall back to `cluster:N` labels (no salient token, no common path prefix):

```
frame "cluster:8"  — 13 files | src/cli(6) src/mcp-server(2) tests/mcp-contract(2) tests/mcp-server(2)
frame "cluster:9"  —  6 files | src/mcp-server(3) src/cli(2) src/decisions(1)
frame "cluster:10" —  5 files | src/mcp-server(3) tests/mcp-contract(2)
```

## Findings

1. **The split does not separate subsystems — it produces tangled, unlabel-able groups.** The hoped-for CLI / decisions / MCP partition does not appear; each community spans `cli` + `mcp-server` + `decisions` + `tests`. Because members span directories, the Phase-1 labeler has no common path prefix and emits `cluster:N` — strictly worse than the original (labeled) blob. That is the +3 label violations.

2. **Root cause is structural, not a tuning miss.** Real call/import graphs cross the boundaries frames should respect: the CLI shells the decisions layer and MCP tools; tests call the code they exercise. There is no clean modular cut, so modularity returns mixed communities. No `Q` threshold or `min_cluster_size` fixes a graph that genuinely lacks subsystem-aligned community structure.

3. **It degrades the metrics it touches.** CALLS agreement dips (−0.015 cortex, −0.028 private-monorepo) — partly the inherent cost of splitting cross-calling files — and label quality regresses. Even at the off-gate, `refineSplit` runs full community detection on every large cluster each index for a result that is then discarded (wasted compute).

## Cross-phase conclusion (the bigger finding)

**Both graph-signal phases of the import-aware effort are negative.** Phase 2 (import-affinity blend — [research](2026-06-05-import-affinity-delta.md)) and Phase 3 (modularity split) each tried to use the `IMPORTS`/`CALLS` graph to improve frames, and neither delivered — for the *same underlying reason*: a codebase's call/import graph couples files **across** the topical/subsystem boundaries that frames are meant to express (CLI→decisions→MCP, tests→everything, framework leaves→shared utils). The import graph is the wrong signal for *topical* grouping.

**Phase 1 (convention-aware tokenization + label salience) was the durable win of the entire arc** (label violations 133→10 corpus-wide). The lexical/path signal, cleaned of framework idioms, expresses topical structure better than the call graph does. Future frame-quality work should build on tokenization/labeling and auxiliary-detection, not on the import graph.

## Recommendation

- **Do not enable Phase 3.** Implementation discarded; production frame extraction is unchanged (Phase-1 behavior).
- **Treat the import-aware arc's graph phases as closed (negative).** Phase 1 stands. If frame quality is revisited, the leads are: better auxiliary/generated-file routing, content-aware (not just path) tokenization, and improved extraction — not import-graph clustering.

## Status of the implementation

Phase-3 code (`modularity.ts` greedy community detector, `refine-split.ts`, `run-frames` gate, `eval --split`) was built and tested on branch `feature/frames/modularity-split` but **deliberately not merged**: inert at the off-gate yet adds per-index community-detection overhead, and degrades frames if enabled. The greedy modularity detector is a clean, tested, reusable artifact recoverable from git if a *different* application (not topical frame splitting) ever wants it.

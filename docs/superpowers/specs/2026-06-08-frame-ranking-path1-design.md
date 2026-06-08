# Frame ranking + force-directed layout (Path 1, taxonomy-free) — design

**Date:** 2026-06-08
**Status:** approved (brainstorm), pending implementation plan
**Branch:** `feature/viewer/frame-ranking-path1`
**Refines:** `docs/specs/cortex-v0.3/frame-ranking.md` (full taxonomy + 4-factor
score) and `docs/specs/cortex-v0.3/frame-layout.md` (force-directed mechanics —
already resolved there). This spec is the **Path 1** slice agreed in the
2026-06-08 brainstorm: ship the budget-cut ranker + the real gravity layout
**without** taxonomy first; add taxonomy later as an additive refinement.

> **Handoff note:** written at the end of a long session to preserve the design
> decisions before context rolled. Execution (plan → subagent build) is for a
> fresh session. The Path 1 decision is also recorded in memory
> `project-v03-work-queue`.

## Problem

The viewer renders **every** extracted frame through a temporary 1:1:1 grid
(`src/viewer/layout.js` `gridLayout`). Two gaps:

1. **No budget.** Real repos overproduce past the readable-map budget. Measured
   from corpus cluster outputs this session: Cortex self = **7** frames,
   anthill-cloud = **10**, **tRPC = 31** (vs the spec's 4–10 ambient budget). A
   31-box grid is not a "readable map" (§8.2 product claim).
2. **The grid is scaffolding.** The intended layout is force-directed and
   gravity-driven (`frame-layout.md`); the grid was a stopgap "to see what we
   output." rka wants the real gravity layout.

So Path 1 builds: a **deterministic budget-cut ranker** (picks the ambient 4–10)
and a **force-directed gravity layout** to replace the grid — both **without
taxonomy**, because taxonomy feeds only one of six layout forces (layer-adjacency)
and one of four ranker factors (kind weight); the rest are concrete graph facts
we already have. Taxonomy is a later additive refinement (the `FrameKind` type in
`frame-ranking.md` is explicitly designed to be added without rewrites).

## Goals

- Deterministic ranker selecting the ambient set; rest stay queryable/navigable.
- Force-directed gravity layout replacing `gridLayout`, driven by real CALLS/
  import edges + frame mass + collision.
- Deterministic + explainable (per `frame-ranking.md` "Properties of the ranker").
- Forward-compatible: adding taxonomy later switches on the layer-adjacency force
  + kind weight without touching the ranker/layout interfaces.

## Non-goals (deferred)

- **Taxonomy / `FrameKind` classification** — and therefore the layer-adjacency
  force and the ranker's kind weight, and the layer-based diversity term. Added
  in a follow-up once Path 1 output is visible.
- **Bare-node bridge force** — no `affinity` is computed in the codebase yet;
  import-neighbourhood covers cohesion for v1.
- **Persisting positions/ranks to a DB** — recompute-on-read (frames are a
  materialized cache, spec §8.7). The durable-primitive store landed 2026-06-08,
  so if persistence is wanted later it has a home; not needed for Path 1.
- The full multiplayer canvas (cursors, drawers, merge animation).

## Design

### A. Ambient ranker (taxonomy-free)

`score = nameability × structural_weight`

- **nameability** — reuse the shipped `src/frame-extraction/label-quality.ts`
  F1 (coverage × specificity): it measures how well a frame's label characterises
  its members, and opaque `cluster:N` fallback labels score ~0 by construction —
  a ready-made, non-circular signal. Combine with the existing generic-token
  penalty (`GENERIC_TOKENS` in `inject-frames.ts`).
- **structural_weight** — `sqrt(member_count)` (normalised so a 200-file frame
  doesn't unconditionally beat a 30-file one, per `frame-ranking.md`).
  Import-centrality is a later enhancement.
- **budget** — `max(4, min(10, ceil(extracted_count × 0.7)))` (resolved in
  `frame-ranking.md` open-q #2).
- **diversity** — **dropped** in Path 1: the spec defines it as a *layer*
  coordinate, which needs taxonomy. tf-idf clusters are already semantically
  distinct, so the cost is low. Re-enters with taxonomy.
- **tie-break** — lexicographic on `frame_id` (§8.6).
- **output** — per frame: `{ ambient: boolean, rank: int, score, components }`
  (components kept for the "why is X ambient and Y not" explainability query).

### B. Force-directed layout (taxonomy-free)

- **Library:** `d3-force` (already a dependency — verified in `package.json`).
- **Compute location:** server-side in the MCP/viewer process,
  **recompute-on-read** (deterministic, sub-second on ≤10 frames → no DB
  migration). Viewer renders the server-computed map; the existing event pipeline
  (`graph-ui.md`) overlays agent presence by referencing frame/node IDs on top of
  the stable skeleton.
- **Forces (3 of the 6 in `frame-layout.md` — the grounded ones):**
  1. **Import-neighbourhood (primary):** attractive force between frame pairs ∝
     rolled-up `CALLS`+`USAGE`+`IMPORTS` edge count. Edges are at *symbol*
     granularity (`module→function`); roll up: symbol → defining file (via
     `DEFINES`) → frame (via `frame_id` on the file node) → frame-pair weight.
     (Verified available: a healthy graph has CALLS≈8.4k, USAGE≈13.7k,
     IMPORTS≈597.)
  2. **Frame mass:** `member_count` → inertia (heavier frames move less).
  3. **Collision:** frame bounding boxes, hard non-overlap constraint.
  - *Optional tertiary:* decision-governance attraction (frames sharing a
     governing decision) — cheap; include if clean, else defer.
  - *Deferred:* layer-adjacency (taxonomy), bare-node bridges (no affinity).
- **Determinism (per `frame-layout.md`):** replace d3's `Math.random` with
  **mulberry32** seeded from `SHA-256(sorted frame records).first_32_bits`
  (record = `frame_id + entity_count + label`); fixed **300 iterations**; final
  **integer-pixel quantization**.
- **Frame size:** sqrt-bounded to the **110–160px** band from entity count.
- **Floating entities:** bare nodes + aggregates via uniform gravity-centroid
  (near connected frames). PR/decision overlays deferred.

### C. Viewer wiring

- Replace the `gridLayout` consumption in the viewer with the server-computed
  `{ id, name, count, x, y, w, h, ambient, rank }`. `groupNodesIntoFrames` in
  `src/viewer/adapters.js` stays the grouping primitive; only ambient frames
  render on the first map, the rest remain reachable via search/navigation.

## Key files

- `src/frame-extraction/inject-frames.ts` — `frame_id`/`frame_label` injection;
  `GENERIC_TOKENS` (penalty source).
- `src/frame-extraction/label-quality.ts` — `scoreLabel`/F1 (nameability source).
- `src/viewer/layout.js` — `gridLayout` (the function being replaced).
- `src/viewer/adapters.js` — `groupNodesIntoFrames`, edge access.
- `src/mcp-server/api.ts` — the `/api/graph` (+ frames) endpoint the viewer reads.
- graph store: file nodes carry `data.frame_id`; `DEFINES` edges (file→symbol);
  `CALLS`/`USAGE`/`IMPORTS` (symbol→symbol) for the rollup.

## Verification (intrinsic-only, per `frame-ranking.md`)

- **Determinism:** re-run twice on the same repo → byte-identical ranks +
  positions; cross-machine via integer quantization.
- **Mechanical:** every frame gets a rank; `|ambient| == budget(extracted)`;
  every node assigned (frame / bare / aggregate).
- **Output stats:** ambient-cut score distribution; layout cost p95 (< target).
- **Gate-0 visual QA:** Cortex (7 → all ambient) + a large repo (tRPC 31 → ~7
  ambient) — confirm the gravity layout reads as a map, no console errors.
- Reuse the corpus harness in `scripts/frame-extraction/`.

## Risks / open questions

- **Symbol→file→frame rollup** is the main new query logic — unit-test it
  directly (edge cases: symbols whose file has no `frame_id`; self-edges within a
  frame excluded from frame-pair weights).
- **Index freshness:** the rollup needs frames + edges in one healthy graph
  store. (The 2026-06-08 fence fix + durable-store work hardened index hygiene;
  still confirm a clean index before corpus eval — the earlier exploration this
  session hit a degraded `.cortex/db` where edges lived only in `graph.db`.)
- **Cross-platform float determinism** — pin to integer arithmetic where layout
  permits; quantize before emit.
- **Decision-governance force** — only include if the decision→frame association
  (via governed path → owning frame, already in `adapters.js`) is clean.

## Relationship to other specs

- **Refines** `frame-ranking.md` (drops taxonomy/kind-weight/diversity for v1) and
  consumes `frame-layout.md`'s resolved force-directed mechanics.
- **Taxonomy follow-up** re-enables: layer-adjacency force, ranker kind-weight,
  layer-diversity — additive, no interface change (the `FrameKind` type is
  pre-designed for it).
- **Builds on** the landed durable-primitive store (a home for persisted frame
  state if/when recompute-on-read is outgrown).

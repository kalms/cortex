# Floating-entity placement — layout slice part 2 (design)

> **Status:** approved design, ready for implementation plan.
> **Arc:** frame-layers taxonomy → layout slice. Part 1 (layer-adjacency
> vertical force, `D-marq`) shipped and is default-on (0.3.22). This is **part 2**:
> place the *satellites* (non-ambient frames + auxiliary aggregates) by a
> gravity-centroid near their connected frames, **replacing the two fixed strips**
> and **superseding the `D-xwxj` governed-frame promotion stopgap**.

## Problem

The base layout (`layoutFrames`, `src/mcp-server/frame-layout.ts`) positions only
**ambient** frames — the top of the ranked set. Everything else is parked in two
**fixed strips**, both client-side, both placement-blind:

- **Auxiliary aggregates** (`locales/`, `fixtures/`, `__snapshots__/`, …) render as
  bare dots in a **fixed bottom strip** (`drawAggregates`, `src/viewer/viewer.js`),
  evenly spaced — adjacent to nothing they relate to.
- **Decision-governed non-ambient frames** are promoted into a **fixed top strip**
  at `y=0.07` (`withGovernedFramesRendered`, `src/viewer/adapters.js`) — the
  `D-xwxj` stopgap, whose own resolution notes it "guarantees reachability, not
  optimal placement" and that the server-side approach was "deferred to the
  redesign."

The v0.3 spec (`docs/specs/cortex-v0.3/frame-layout.md` §Floating entities) calls
for the opposite: every floating entity sits at the **centroid of its tied code
entities**, with frame-repulsion to avoid landing inside an unrelated frame — *no
dedicated strips, no per-type docking*. This slice is that redesign.

## Scope

| Aspect | Decision | Why |
|---|---|---|
| **Entities placed** | **Auxiliary aggregates + decision-governed non-ambient frames** (the two entities that have fixed strips today). Bare nodes / all below-cut frames / PRs / TODOs deferred. | The two strips are the concrete regressions; placing exactly them keeps the slice tightly attributable. The same module generalizes to the others later. |
| **Where placement lives** | **Server-side, pure** (`placeFloatingEntities` in a new module). The viewer renders server positions. | Matches part 1 (pure, deterministic, golden-testable) and the viewer-as-renderer direction; decouples placement from the decisions store (the `D-xwxj` rationale). |
| **Aggregate ties** | **Edge → path → margin cascade.** | Measured signal first (CALLS/IMPORTS rollup), directory-ancestry fallback for tie-less aux content, de-emphasized margin as graceful last resort. |
| **Governance coupling** | **Selection stays client-side; position comes from the server.** | The viewer decides *which* non-ambient frames to render (from `FRAME_GOVERNANCE`); the server positions *all* non-ambient frames purely from frame-pairs, with no knowledge of decisions — honoring `D-xwxj`'s decoupling rationale. |
| **Rollout** | **No env flag.** Validation = golden determinism tests + Gate 0 on cortex + 1–2 corpus repos; strips removed. | Unlike 3a/3b/part-1, there is no measurable corpus delta to *observe* — this is a visual replacement of an acknowledged stopgap. A flag would mean two render paths in the viewer for no observe payoff. |
| **Composability** | The floating pass depends only on `(final ambient positions, ties)`, never on *how* positions were produced. | Extensibility seam (see below): a future network/layered base-layout slots in underneath with zero changes to this pass. |

## Architecture

The ambient force-sim is **untouched** — part-1's default-on output stays
byte-identical (golden-guarded). A new pure module adds a deterministic post-pass:

```
layoutFrames(ambient, pairs)        →  final ambient positions   (UNCHANGED)
            │
            ▼
placeFloatingEntities({                 ← NEW, pure, deterministic
  ambientPositions,   // [{id, x, y, w, h}]
  nonAmbientFrames,   // [{id, label, member_count}]
  framePairs,         // rollupFramePairs() — inter-frame weights
  aggregates,         // [{label, member_count, member_paths}]
  aggregateTies,      // [{aggregateId, frameId, weight}] (edge ties, pre-rolled)
  framePaths,         // frameId → representative dir prefix (for path ties)
})                                   →  positioned satellites
```

The two consumers — `/api/frames` (non-ambient frame positions) and
`/api/aggregates` (aggregate positions) — are served from the position output.

### Placement rules

1. **Non-ambient frame** → pair-weighted centroid of the **ambient** frames it
   shares `framePairs` weight with:
   `pos = Σ(w_i · ambientPos_i) / Σ(w_i)` over ambient partners `i`.
   A frame whose only partners are *other non-ambient* frames (no ambient anchor)
   → margin fallback (no transitive chasing — keeps the pass single-level and
   deterministic).

2. **Aggregate** → tie cascade, first match wins:
   a. **edge tie** — centroid of ambient frames in `aggregateTies` (weighted);
   b. **path tie** — centroid of ambient frames whose representative dir prefix
      shares the aggregate's directory ancestry (e.g. `app/locales/` →
      `app/*` frames);
   c. **margin** — a deterministic slot in a de-emphasized margin band.

3. **Frame-repulsion** (`repelFromFrames`, shared) — after centroiding, if a
   satellite's box overlaps an ambient frame's box, nudge **the satellite only**
   (anchored frames never move) along the axis of lesser penetration until clear.
   Bounded iteration count; purely positional; no PRNG. A cousin of the existing
   AABB-separation tail in `layoutFrames`, but one-directional.

4. **Margin band** — a reserved low-traffic region (e.g. the outer right/bottom
   gutter inside stage margins). Tie-less entities are slotted deterministically
   by `frame_id` / aggregate label order. This is a *fallback zone*, not a
   per-entity strip with fixed pitch — it exists only for entities with no signal.

### Determinism

Same input → byte-identical output. Fixed ordering throughout
(`a.id - b.id` for frames, `String(id).localeCompare` / label order for
aggregate slots), integer-pixel quantize, bounded repulsion iterations, no
PRNG (centroids and repulsion are positional solves). Golden-tested.

## Components & files

- **`src/mcp-server/floating-placement.ts`** (NEW, pure) — `placeFloatingEntities`,
  `repelFromFrames`, the aggregate tie-cascade resolver, and the margin-slot
  allocator. One responsibility: position satellites relative to anchored frames.
- **`src/mcp-server/aggregate-ties.ts`** (NEW, pure) *(or folded into
  `auxiliary-detection.ts`)* — build `aggregateTies` from graph edges
  (aggregate member file → frame member file via the CALLS/IMPORTS/USAGE rollup)
  and expose each aggregate's directory ancestry for the path fallback.
- **`src/mcp-server/frame-map.ts`** (MODIFY) — after `layoutFrames`, call
  `placeFloatingEntities` for non-ambient frames and attach their `x/y` to the
  frame-map payload (they already ride in `frames` unpositioned today).
- **`src/mcp-server/api.ts`** (MODIFY) — `/api/aggregates` (and/or `/api/frames`)
  serve *positioned* entities; aggregate placement is computed where the graph +
  ambient positions are available and reused by the endpoint.
- **`src/viewer/viewer.js`** (MODIFY) — delete `drawAggregates`' fixed bottom
  strip; render aggregates as dots at server `x/y` (keep sqrt sizing + count
  badge). Render non-ambient/governed frames at server positions, **visually
  de-emphasized** (smaller / lower opacity) so ambient frames stay primary.
- **`src/viewer/adapters.js`** (MODIFY) — retire `withGovernedFramesRendered`'s
  strip layout; the viewer still *selects* governed non-ambient frames to render
  (from `FRAME_GOVERNANCE`) but reads their *position* from the frame-map.

## Data flow

1. `buildFrameMap` runs ranking → ambient selection → `layoutFrames` (ambient
   positions, unchanged) → `placeFloatingEntities` for non-ambient frames →
   payload carries every frame with `x/y` (ambient + non-ambient) and an
   `ambient` flag.
2. The aggregates path builds `aggregateTies` from edges + paths, runs
   `placeFloatingEntities`' aggregate branch against the same ambient positions,
   serves positioned aggregates.
3. Viewer: renders ambient frames (primary), non-ambient frames it chooses to
   show at their server positions (de-emphasized), aggregates as dots at their
   server positions. No strips.

## Error handling / edge cases (all deterministic)

- **Zero ambient frames** → every satellite resolves to margin; layout is the
  margin band only. No crash, no NaN centroid (empty sum guarded → margin).
- **Aggregate with no edge tie and no path match** → margin (branch c).
- **Non-ambient frame with no ambient partner** → margin.
- **Centroid lands on a frame** → `repelFromFrames` pushes it clear; if the stage
  is saturated, the bounded loop terminates and the clamp keeps it on-stage
  (acceptable residual overlap over an infinite loop).

## Extensibility — future layout modes

This slice deliberately preserves the ability to add alternate layout *modes*
(e.g. a network / layered-DAG diagram exploiting the layer taxonomy):

- **Layout is a server-side position-producer behind a stable contract**
  (`{id, x, y, w, h}` in the fixed virtual stage). A new mode = another base
  position strategy selected by a request param (e.g. `?layout=stratified|network`),
  not a rewrite. The viewer renders whatever positions it is handed.
- **The floating pass composes on top of any base layout** — it consumes only the
  *final* ambient positions + ties, so a layered/Sugiyama base (layer as rank
  axis, `framePairs` as edges — both already computed server-side) drops in with
  no change to `placeFloatingEntities`.
- **Frame-pair weights are available server-side** if a network mode wants to draw
  frame-to-frame links (an additive payload field, not built here).

We do **not** build the network mode or a `layout` selector now (YAGNI); this
section only fixes the seam so the next slice has a clean hook.

## Out of scope

- Bare nodes / below-cut frames at large / PR / TODO floating entities (same
  module generalizes later).
- The network / layered-DAG layout mode and the `layout` strategy selector
  (seam documented, not built).
- Per-pair directed flow links as a drawn edge layer in the viewer.

## Rollout & decision capture

- **No env flag.** Strips removed; validation is golden determinism tests + Gate 0
  visual QA on cortex + 1–2 corpus repos (governed frames appear near related
  frames, aggregates near related frames, tie-less aggregates in the margin, no
  overlap pathology, console clean).
- **Supersede `D-xwxj`** with a new decision recording: server-side
  gravity-centroid placement, the edge→path→margin tie cascade, selection-stays-
  client / position-from-server governance decoupling, and the layout-strategy
  seam. (`supersede_decision`.)

## Testing

**Pure module (`floating-placement.ts`, `aggregate-ties.ts`):**
- Weighted centroid correctness (a non-ambient frame paired 3:1 with two ambient
  frames lands ¾ of the way toward the heavier one).
- Tie cascade: edge tie chosen over path tie when both exist; path tie when no
  edges; margin when neither.
- `repelFromFrames`: a satellite seeded inside an ambient box ends outside it;
  anchored frame unmoved.
- Margin allocator: deterministic, non-overlapping slots; stable across runs.
- Edge cases: zero ambient frames; tie-less aggregate; non-ambient-only partner.
- **Golden determinism**: same input → byte-identical positions across runs.

**Frame-map integration:**
- Ambient positions byte-identical to pre-change (part-1 output preserved — the
  new pass must not perturb the ambient sim).
- Non-ambient frames now carry `x/y`; ambient flag intact; no internals leaked.

**Gate 0 (viewer):** strips gone; governed non-ambient frames render near their
related ambient frames; aggregates near related frames (or margin when tie-less);
de-emphasized treatment reads as secondary; no overlap/clamp pathology; zero
console errors. cortex + 1–2 corpus repos.

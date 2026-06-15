# Layer-Diversity — Enable Slice (taxonomy step 3b)

> Design spec, approved 2026-06-15. Second half of the enable slice from
> [`frame-ranking.md`](../cortex-v0.3/frame-ranking.md) (`Score = nameability ×
> structural weight × kind weight × diversity`). Slice 3a shipped the **static**
> `× kind_weight` factor (now on by default, decision `D-g4qb`); this slice
> ships the **stateful** `× diversity` term. Builds directly on the kind-weighted
> ambient scores and the earnable-domain signal (`D-8vbv`).

## Goal

Make the **ambient set selection** layer-aware. Today the ambient set is the
top-`budget` frames by score (`nameability × structural × kind_weight`) — which
can render five boxes from the same layer and show a newcomer none of the
product's domain, interface, or data. This slice replaces the naïve top-N cut
with a deterministic greedy selection that:

1. **guarantees coverage** — ≥1 of `domain` / `interface` / `data` when the repo
   has them,
2. **caps ceremony at one**, and
3. **decays repeats** of an already-represented layer,

so the rendered map reads as a vertical slice of the system rather than the
biggest, best-named clusters of whatever layer happens to dominate. Ships
**behind a flag, default off**, until validated — same observe-first discipline
as slice 3a.

## Why a separate slice from kind-weight

`score = nameability × structural × kind_weight × diversity` decomposes into a
**static** factor (kind-weight — a per-frame multiplier, slice 3a) and a
**stateful** one (diversity — which frames are chosen depends on what is already
chosen). Kind-weight shipped alone as a clean, deterministic, easily-attributed
increment. Diversity is selection logic with internal state; bundling it would
have made an ambient-set change impossible to attribute to one mechanism during
observe. This is the second, final half of the enable slice.

## Decisions (brainstorm, 2026-06-15)

| Knob | Choice | Rationale |
|---|---|---|
| **Coverage strength** | **Bounded promotion** | Promote a missing layer's best candidate into the set only if it clears a quality floor (`≥ PROMOTION_FLOOR × displaced score`). Coverage is a goal, not an absolute — refuse to inject a frame too weak to deserve the slot. The analog of the `D-qn7z` "junk leapfrogging" trap that 3a's earned/fallback split guarded against. |
| **Repeat-decay** | **Geometric per-repeat** | `effective = score × DECAY^k`, `k` = count of this frame's layer already selected. One tunable constant; compounding (a 3rd same-layer frame is penalized much harder than the 2nd). The natural reading of the `× diversity` term. |
| **Rollout** | **Flag, default off + observe** | Ship behind `CORTEX_LAYER_DIVERSITY` (default off, inert). Run the corpus eval before/after, capture the verdict, flip the default on in a follow-up release. Matches the arc's walk-before-run pattern. |

## Architecture

One new pure unit; the ranker stays untouched and layer-free.

### 1. `src/frame-extraction/frame-diversity.ts` — the greedy selector (new, pure)

Slice 3a deliberately kept `rankFrames` **layer-agnostic** — it sees
`kind_weight` only as a plain number, never the layer. Diversity needs each
frame's `layer`, so it lives in its own pure module rather than polluting the
ranker with stateful selection logic.

```ts
import type { FrameLayer } from "./frame-kind.js";

/** Per-frame input to diversity selection. Frames arrive already sorted by raw
 *  score descending (the order rankFrames produced). */
export interface DiversityInput {
  frame_id: number;
  /** Raw ranker score (nameability × structural × kind_weight). */
  score: number;
  layer: FrameLayer;
}

export const DIVERSITY_DECAY = 0.6;
export const CEREMONY_CAP = 1;
export const PROMOTION_FLOOR = 0.5;
/** Canonical order — also the tie-break / coverage-repair order. */
export const REQUIRED_LAYERS: readonly FrameLayer[] = ["domain", "interface", "data"];

/**
 * Deterministic greedy ambient selection. Returns the set of frame_ids that
 * should be ambient. Pure: same input + budget → same set. All tie-breaks are
 * on the stringified frame_id, matching the ranker (spec §8.6).
 */
export function selectAmbientByDiversity(
  frames: readonly DiversityInput[],
  budget: number,
): Set<number>;
```

**Phase 1 — greedy fill with decay + ceremony cap.** Fill `budget` slots one at
a time; each step picks the remaining frame with the highest *effective* score:

```
effective(frame) = frame.score × DIVERSITY_DECAY ^ (count of frame.layer already selected)
```

- A `ceremony` frame is **excluded** once `CEREMONY_CAP` (1) ceremony frames are
  already selected — *unless* only ceremony candidates remain and slots are
  still unfilled (don't leave the canvas emptier than budget for a pathological
  all-ceremony repo; see edge cases).
- Geometric decay means an unrepresented layer's frame (×1.0) naturally beats a
  decayed repeat, so good spread **emerges** in this phase. The first pick is
  unchanged from raw ranking (all counts 0 ⇒ effective = score), so the top
  frame is stable.
- Ties on effective score break on stringified `frame_id`.

**Phase 2 — bounded coverage repair.** For each layer in `REQUIRED_LAYERS`
(canonical order) that the repo *has* (≥1 frame of that layer exists in the full
input) but Phase 1 left out of the selected set:

- `c` = that layer's highest-raw-score omitted frame (tie-break: `frame_id`).
- `w` = the weakest **displaceable** selected frame: lowest raw score
  (tie-break: `frame_id`) among frames whose removal would **not** drop another
  required layer to zero — i.e. frames whose layer is non-required, or whose
  required layer still has another representative after removal.
- **Swap `c` for `w` only if `c.score ≥ PROMOTION_FLOOR × w.score`.** Otherwise
  leave the layer uncovered (bounded promotion — refuse the weak candidate).
- If no displaceable `w` exists (every selected frame is the sole rep of a
  required layer), skip — never rob coverage of one required layer to give it to
  another.

Missing required layers are processed one at a time, updating the selected set
and counts between each, so the second repair sees the first's result.
Deterministic throughout.

### 2. `src/mcp-server/frame-map.ts` — gate + override (existing)

`frame-map.ts` already computes `ranked` (with `score`, `rank`, `ambient`) and
holds `layerById`. Add the flag and, when on, override ambient membership and
lay out the diversity set:

```ts
const applyDiversity = opts.applyDiversity ?? process.env.CORTEX_LAYER_DIVERSITY === "1";

// ranked is unchanged; rank stays raw-score order.
let ambientIds: Set<number>;
if (applyDiversity) {
  ambientIds = selectAmbientByDiversity(
    ranked.map((r) => ({
      frame_id: r.frame_id,
      score: r.score,
      layer: layerById.get(r.frame_id) ?? "domain",
    })),
    ambientBudget(ranked.length),
  );
} else {
  ambientIds = new Set(ranked.filter((r) => r.ambient).map((r) => r.frame_id));
}
const ambient = ranked.filter((r) => ambientIds.has(r.frame_id));
// layoutFrames(ambient …) and the per-entry `ambient: ambientIds.has(r.frame_id)`
// flow from this set.
```

- `buildFrameMap(nodes, edges, opts?: { applyKindWeight?; applyDiversity? })`.
  `applyDiversity` defaults to `process.env.CORTEX_LAYER_DIVERSITY === "1"`; the
  env read lives here, not in the pure module. Tests pass it explicitly.
- `rankFrames` is **not modified**. `RankedFrame.rank` stays raw-score order
  (explainability + stability); `RankedFrame.ambient` from the ranker is used
  verbatim only when the flag is off.
- The serialized `ambient` flag and the `x/y/w/h` positions reflect the diversity
  set when the flag is on. `rank` and `score` are untouched — an honest map can
  show a rank-11 frame as ambient (promoted for coverage) and a rank-8 frame as
  not (decayed/displaced). No internal diversity machinery is serialized.

## Data flow

```
/api/frames
  → rollupFrameFlows → classifyFramesInternal            (layer + fallback; existing)
  → kind_weight per record (CORTEX_KIND_WEIGHT on by default; slice 3a)
  → rankFrames (score, rank, naïve ambient)              (pure, unchanged)
  → applyDiversity ? selectAmbientByDiversity(ranked+layer, budget) : ranked ambient
                                                          (frame-map gate)
  → ambient = frames in the selected set; layoutFrames(ambient)
```

## Error handling & edge cases

- **Flag off (default):** `selectAmbientByDiversity` never runs; ambient set,
  layout, and `/api/frames` are byte-identical to pre-slice. Inert guarantee,
  golden-tested.
- **`budget ≥ frame count`** (small repos, < 4 frames): every frame is ambient;
  the selector returns all ids — decay/coverage/cap are moot but harmless.
- **A required layer absent from the repo** (no `data` frames at all): coverage
  guarantee skips it — it only fires "when the repo has them".
- **All-ceremony repo (pathological):** the ceremony cap yields once non-ceremony
  candidates are exhausted and slots remain, so the canvas still fills to budget
  rather than rendering one box.
- **Degraded graph / missing edges:** classifier still returns a layer for every
  frame (`domain` fallback), so every `DiversityInput` has a layer; selection
  never throws on empty input (`budget 0 → empty set`).
- **Budget vs required layers:** `ambientBudget` min is 4 and `REQUIRED_LAYERS`
  has 3 entries, so coverage never exhausts the budget — there is always room
  for non-required layers.

## Observe

Extend the corpus eval (`eval-layers.ts` or a sibling) to report, per repo, the
ambient set with the flag **off vs on**:

- frames entering / leaving the ambient set,
- ambient **layer composition** both ways,
- **coverage gained** — which required layers became present that weren't,
- **the regression to watch** — any Phase-2-promoted frame whose raw score is far
  below the frame it displaced, or any fallback-domain / very-small frame
  injected purely to fill a coverage slot (the `PROMOTION_FLOOR` gate should
  prevent this; the eval proves it).

**Success:** ambient sets read as a vertical slice (domain + interface + data
present where the repo has them), ceremony capped at one, **no junk promoted on
coverage alone**. This verdict gates flipping the default on in a follow-up; this
slice ships the flag off.

## Out of scope

- **Flipping the default on** — a follow-up after the observe verdict (mirrors
  the 3a → 0.3.10 flip).
- **Layout slice** (layer-adjacency force in `frame-layout.ts`) — the next slice;
  unchanged here.
- **Floating-entity placement** and the **cross-cutting concern axis** — later
  slices per the taxonomy arc.
- Tuning the four constants beyond their starter values — the observe loop's job.

## Testing

1. **Unit — `frame-diversity.test.ts`** (the core):
   - ceremony cap holds at 1, and **relaxes** only when no non-ceremony candidate
     remains and slots are unfilled;
   - geometric decay evicts a 3rd same-layer frame in favor of an unrepresented
     layer's frame at the chosen `DECAY`;
   - bounded promotion **swaps** when the candidate clears
     `PROMOTION_FLOOR × displaced`, and **refuses** (layer stays uncovered) when
     it doesn't;
   - a required layer absent from the repo is skipped (no error, no promotion);
   - coverage repair never displaces the sole representative of another required
     layer;
   - determinism: two runs over shuffled input → identical set;
   - `budget ≥ n` → all ids; `budget 0` / empty input → empty set.
2. **Unit — `frame-map` (`frame-map-layer.test.ts` or sibling):**
   - `applyDiversity:false` → ambient set + serialized output equal to the
     pre-slice golden (inert guard);
   - `applyDiversity:true` over a fixture with a missing-but-present required
     layer → that layer becomes ambient and ceremony ≤ 1;
   - negative contract still holds: no diversity internals in the serialized map.
3. **Determinism:** two `buildFrameMap` runs with the flag on over shuffled input
   → identical ambient ids + layout.
4. **Gate 0 visual QA:** flag off → ambient set pixel-identical to current; flag
   on (a corpus repo, e.g. anthill) → ambient visibly spans layers, ≤1 ceremony
   box, console clean.

## Decision capture

After implementation, capture: the greedy diversity selection as a **separate
pure module** (keeping the ranker layer-free — the same isolation discipline as
the kind-weight number-threading); the **two-phase fill → bounded-repair** shape;
the four named constants (`DIVERSITY_DECAY 0.6`, `CEREMONY_CAP 1`,
`PROMOTION_FLOOR 0.5`, `REQUIRED_LAYERS [domain, interface, data]`); and the
**inert-default** guarantee. Link to `frame-diversity.ts`, `frame-ranker.ts`,
`frame-map.ts`, and this spec; relate to `D-g4qb` (kind-weight enable) and
`D-qn7z` (the junk-leapfrogging trap this slice's bounded promotion respects).

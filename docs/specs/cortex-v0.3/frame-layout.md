# Frame layout — design notes

> Companion to `cortex-multiplayer-spec.md` §8 plus
> `frame-ranking.md` and `frame-extraction.md`. Closes open question
> #6 in `frame-ranking.md` and the layout-related implementation
> risks. Adopted direction for v1; promote into the spec when v0.3
> lands.

---

## Position

Layout is force-directed, consuming the gravity signals defined in
`frame-extraction.md` and `frame-ranking.md`. Deterministic from
shared state — same inputs produce identical positions across all
viewers and machines.

The shape is settled; what this document captures is the
implementation specifics: library, RNG strategy, cross-platform
determinism mechanics, and the placement policy for floating
entities (PRs, decisions, TODOs, aggregates, bare nodes).

---

## Algorithm

Force-directed simulation with the following forces:

| Force | Source | Effect |
|---|---|---|
| Layer adjacency | Taxonomy (`frame-ranking.md`) | Spring-force between same-layer frames; medium between adjacent layers (vertical slice); repulsion between non-adjacent |
| Bare-node bridges | Affinity (`frame-extraction.md`) | Attractive force between frame pairs proportional to bridging entity count |
| Import neighbourhoods | CBM edge graph | Secondary attractive force between frames with high cross-frame import density |
| Decision governance | Decision graph | Tertiary attractive force between frames sharing governing decisions |
| Frame mass | Entity count | Heavier frames move less under applied forces (inertia) |
| Collision | Frame bounding boxes | Frames don't overlap (hard constraint) |

Forces are linear-combined per simulation step. Weights are tunable
on the corpus (likely α/β/γ/δ along the same lines as extraction's
clustering distance, but for layout the values may differ).

---

## Library

**D3-force** (`d3-force` package). TS-native, no build complexity,
well-tested, the JS visualisation community standard. Deterministic
when given a fixed-seed PRNG. Composable via custom force functions —
each gravity signal becomes a registered force.

Considered and rejected:

- **ngraph.forcelayout** — smaller, faster, but less common; adopting
  D3 keeps Cortex's stack within mainstream JS visualisation
- **igraph (Python/C)** — heavyweight; out of scope
- **Hand-rolled** — ~200 lines, full determinism control, but reinvents
  edge cases (collision resolution, convergence detection). Not worth
  it given D3 handles them well

---

## Determinism mechanics

D3-force is non-deterministic by default (uses `Math.random()` for
initial jitter). v1 must:

### Seed source

`SHA-256(sorted-frame-records).first_32_bits`, where each record is
`frame_id + entity_count + label` joined deterministically. Same
frame set produces the same seed; any change to the set (new frame,
renamed frame, member-count delta) reseeds the layout.

### PRNG

Replace D3's `Math.random` with a seeded deterministic PRNG.
Candidates: `seedrandom` (npm package, ~3KB) or hand-rolled
**mulberry32** (10 lines, 32-bit state, fast, sufficient for layout
jitter). Lean: mulberry32 — small dep surface, sufficient quality.

### Initial positions

Seed each frame's starting position from `hash(frame_id)` mapped to
the unit disk:

```
angle = (hash(frame_id) % 360) * (π/180)
radius = 0.3 + (hash(frame_id, 'r') % 100) / 200   // 0.3–0.8 of unit
x = 0.5 + radius · cos(angle)
y = 0.5 + radius · sin(angle)
```

Avoids the "all start at center, push outward identically" collapse
where same-mass frames produce ambiguous positions. Each frame gets
a stable starting offset that's a function of its ID alone.

### Iteration count

Fixed. **300 iterations**, regardless of convergence state. D3's
default alpha-decay convergence is non-deterministic across
platforms (different JS engines may converge at slightly different
counts due to floating-point). Fixed count eliminates the variance.

300 is a starting value; calibrate empirically — fewer if the layout
visually settles earlier, more if late iterations still produce
meaningful refinement. Tunable.

### Cross-platform float discipline

Modern JS engines (V8, JavaScriptCore, SpiderMonkey) implement
IEEE-754 transcendentals identically, so `sin`, `cos`, `sqrt`
produce bit-identical results on the same input. Edge cases at the
last bit of mantissa precision can drift, but for layout's
human-perceptible scale (positions in pixels) this is below the noise
floor.

To eliminate any residual drift:

- **Final quantisation.** After 300 iterations complete, snap each
  frame's `(x, y, w, h)` to the nearest integer pixel coordinate (or
  4-pixel grid for crispness). Sub-pixel drift between platforms is
  eliminated as the last step.
- Apply same quantisation to floating-entity positions (PRs,
  decisions, TODOs, aggregates, bare nodes).

---

## Frame size scaling

Frame size scales with entity count, but within a tight visual band.
The point is to *indicate* there's more to investigate when a frame
is dense, not to dramatically vary canvas mass.

Range: standard width ~120px, scaling band roughly **110–160px**
across all frames in a given canvas. Same proportional band for
height.

Scaling function: `sqrt(entity_count / median_entity_count)` clamped
to the visual band. Sqrt rather than linear because perceptually it
flattens at extremes — a 200-entity frame doesn't read as 10× larger
than a 20-entity frame, which would be visually overwhelming and
would crowd small frames out of the canvas.

Concretely:

```
median = median of entity counts across the ambient frame set
factor = clamp(sqrt(this_frame.entity_count / median), 0.92, 1.33)
width = 120 * factor       // → 110.4 to 159.6
height = 90 * factor       // proportional, similar band
```

Heavier frames also have higher inertia in the force simulation —
they move less per applied force. This compounds with the size
visual: large frames stay roughly where the seeding put them, smaller
frames drift more freely to find their gravity equilibrium.

---

## Canvas size

**Adaptive to viewport.** Simulation runs in unit space `[0, 1]²`;
render scales to whatever the viewport is, with a sensible aspect
ratio (the prototype uses roughly 16:10 effective canvas). On viewport
resize, re-render is cheap (no re-simulation needed) — frame
positions are unit-space coordinates, only the pixel transform
changes.

This matches the v5 prototype's behavior: the prototype uses
fractional positioning (`x: 0.16, y: 0.30` on its frame seed) which
is the same coordinate model. The new layout pipeline produces
fractional positions; render multiplies by viewport dimensions.

---

## Floating entities

PRs, decisions, TODOs, aggregates, and bare nodes are all positioned
by **the same gravity logic** — uniform treatment across the
floating-entity grammar. No special docking rules per type, no
dedicated strips, no per-type placement policies.

Each floating entity has gravity ties to a set of code entities (PR
touches, decision governance, TODO governs, aggregate membership,
bare-node split-loyalty). Position is the centroid of its tied
entities, with frame-repulsion to keep the dot from falling inside a
frame the entity doesn't relate to.

The visual mass varies by type:

| Entity | Dot size | Notes |
|---|---|---|
| Decision | 4px | Standard floating dot |
| PR | 4px | Standard |
| TODO | 4px | Standard |
| Bare node | 3–4px | Slightly smaller, neutral |
| Aggregate | ~5.5px (1.4× standard) | Larger to accommodate count badge |

Aggregates' larger visual mass is purely a render-time treatment;
the gravity logic positioning them doesn't change.

---

## Pipeline shape

```
Inputs:
  - Ambient frame set (post-ranking, post-cut)
  - Bare nodes
  - Aggregate nodes
  - Floating entities (PRs, decisions, TODOs)
  - Gravity signals (taxonomy, bare-node bridges, import neighbourhoods, decision governance)

1. Compute frame positions:
   a. Seed initial positions from hash(frame_id) on unit disk
   b. Run 300 fixed-iteration force simulation in unit space
   c. Apply collision constraint (no overlap)
   d. Quantise to integer-pixel grid

2. Compute floating-entity positions:
   a. For each entity: collect tied code-entity positions
   b. Position at centroid of tied entities (in unit space)
   c. Frame-repulsion: if centroid lands inside a non-tied frame,
      push outward to nearest unoccupied space
   d. Quantise

3. Output:
   - Per-frame { id, x, y, w, h }
   - Per floating-entity { id, type, x, y }

4. Render-time:
   - Multiply unit positions by viewport dimensions
   - Re-render is cheap; resize just rescales transforms
```

---

## Re-layout cadence

Layout is deterministic from shared state, so re-layout fires
whenever the inputs change:

- Extraction re-run (CBM reindex, git HEAD advance, algorithm version
  bump)
- Ranking re-run (taxonomy classification update, ambient budget
  change)
- Frame set delta (new frame appears, frame disappears, member
  changes)
- Floating-entity delta (decision/PR/TODO created or state change)

Cost is sub-second on 4–10 frames (300 iterations is trivial), so
just always re-layout when any input changes. No incremental
re-layout, no diffing — the full pipeline re-runs and produces a new
position set.

For animation continuity: if old layout exists, render-side
interpolates between old and new positions over a short transition
(~360ms ease-out, matching the drawer-open transition timing).
Doesn't affect the underlying layout determinism — the canonical
state is the new positions; interpolation is purely visual.

---

## Open questions

1. **Force weights.** Layer-adjacency vs bare-node-bridges vs
   import-coupling vs decision-governance — the relative magnitudes.
   Initial intuition: layer-adjacency is the strongest (taxonomy
   structure is the skeleton); bare-node-bridges and decision
   governance are medium; import-coupling is the weakest because it
   often duplicates information already in the other forces.
   Calibrate empirically.
2. **Iteration count tuning.** 300 is a starting value. Fewer might
   suffice for small frame counts; more might be needed for
   high-frame-count canvases. Profile on the Phase 2 corpus.
3. **Quantisation grid.** Integer pixel vs 4-pixel grid vs 8-pixel
   grid. Tighter grid → more layout options; coarser → more
   visual rhythm. Lean: 4-pixel for crispness without rigidity.
4. **Animation interpolation curve.** Match the drawer-open
   transition (360ms ease-out) for consistency, or use a different
   curve appropriate for layout reflow? Probably match for grammar
   uniformity.
5. **Edge case: frame set entirely changes.** If a re-extraction
   produces a completely different frame set (no carryover), the
   transition animation has nothing to interpolate. Hard cut, fade
   the old set out, fade the new set in? TBD.

---

## Status

Adopted as v1 direction 2026-05-03 during brainstorm pass on the
v0.3 layout topic. Library (D3-force), RNG strategy (mulberry32 +
hash-seeded initial positions), iteration count (300 fixed),
quantisation (integer or 4-pixel grid), frame-size scaling
(sqrt-based, clamped 110–160px band), canvas (adaptive to viewport,
unit-space simulation), floating entities (uniform gravity logic, no
type-specific docking), re-layout cadence (always recompute on input
change) all defined.

Closes:
- `frame-ranking.md` open question #6 (layout algorithm)
- `frame-ranking.md` implementation risk: layout algorithm
- `frame-ranking.md` implementation risk: aggregate node layout

Promote into `cortex-multiplayer-spec.md` as new sub-section
(likely §8a or §8.15 depending on numbering when v0.3 lands).

# Layer-Adjacency Layout Force — Vertical Stratification (taxonomy step: layout slice, part 1)

> Design spec, approved 2026-06-16. The third effect surface of the
> [`frame-ranking.md`](../cortex-v0.3/frame-ranking.md) taxonomy arc: after the
> classifier (milestone 1), kind-weight (3a, default-on), and layer-diversity
> (3b, default-on), this adds the **layout** effect — frames settle into a
> vertical surface→substrate slice. Realizes the first half of the deferred
> "layout slice" (out-of-scope item 2 of the
> [taxonomy design](2026-06-12-frame-layers-taxonomy-design.md)); **floating-entity
> placement is a separate follow-on slice.** End-state visual direction previewed
> + approved in the 2026-06-12 brainstorm (`layers-experience-v5.html`, scene B).

## Goal

Today the ambient frames are laid out by a force whose only positional signals
are pair-attraction (which frames connect) + repulsion + centering — there is no
architectural axis, so a newcomer can't read the canvas as a stack. This slice
adds a **vertical stratification force**: each frame's target y is derived from
its **measured** flow direction (surface = sources high, substrate = sinks low),
so the map reads as a vertical slice — interface up top, the product's subject in
the middle band, plumbing low. **Behind a flag, default off, until validated** —
same observe-first discipline as slices 3a/3b.

## Decisions (brainstorm, 2026-06-16)

| Knob | Choice | Rationale |
|---|---|---|
| **Scope** | **Layer-adjacency force first; floating-entity placement is a separate follow-on slice** | The two touch different surfaces (server-side force in `frame-layout.ts` vs viewer-side rendering + retiring the `D-xwxj` governed-frame promotion). Splitting keeps each layout change independently attributable — the same walk-before-run discipline that split 3a/3b. |
| **Vertical position** | **Measured sink ratio** (`fanIn/(fanIn+fanOut)` from `FrameFlowStats`), zero-flow frames fall back to a per-layer nominal | The taxonomy spec is explicit: use *measured* adjacency from `rollupFrameFlows`, **not** categorical bands. Sink is the already-computed surface↔substrate signal (the same one the classifier uses); position is earned from data, and visually approximates the mockup's bands since layer correlates with sink. |
| **Force composition** | **Add one vertical `forceY(yTarget(sink))`; keep the existing pair-link clustering, charge, collide** | One new positional force on a proven base = attributable + minimal. The undirected pair-link force still owns horizontal cohesion; the new force owns the vertical axis. Directed per-pair flow links are a possible later refinement, deliberately out of scope. |
| **Rollout** | **Flag `CORTEX_LAYER_LAYOUT`, default off + observe** | Positions are UI-visible; flag-off must be byte-identical. Gate 0 + a corpus layout-shift eval gate the default-on flip in a follow-up. Mirrors 3a/3b. |

## Architecture

The pure layout module stays **layer-agnostic** — it receives a plain `sink`
number per frame, never the layer or the flag. This is the same isolation
discipline that kept `frame-ranker.ts` layer-free in 3a/3b.

### 1. `src/mcp-server/frame-layout.ts` — the vertical force (pure)

`LayoutInputFrame` gains an optional `sink?: number`:

```ts
export interface LayoutInputFrame {
  frame_id: number;
  frame_label: string;
  member_count: number;
  /** Effective sink ratio in [0,1] (surface 0 → substrate 1). When present on
   *  any frame, the vertical stratification force is applied. Omitted (the
   *  default) → layout is byte-identical to pre-slice. */
  sink?: number;
}
```

New constants + helper:

```ts
/** Vertical band the stratification force targets (px), inside stage margins. */
const TOP_Y = STAGE_H * 0.14;     // 112
const BOTTOM_Y = STAGE_H * 0.86;  // 688
/** forceY strength — strong enough to stratify, weak enough that pair-link
 *  clustering still groups connected frames horizontally. */
const STRENGTH_Y = 0.18;
/** Target y for a frame, from its sink ratio. */
function yTargetFor(sink: number): number {
  const s = Math.max(0, Math.min(1, sink));
  return TOP_Y + s * (BOTTOM_Y - TOP_Y);
}
```

`layoutFrames` branches on whether sink data is present:

```ts
const stratify = frames.some((f) => f.sink !== undefined);
// …build nodes (SimNode gains `sink: number` carried from the input, default 0.5)…
const sim = forceSimulation<SimNode>(nodes)
  .randomSource(mulberry32((seed ^ 0x9e3779b9) >>> 0))
  .force("charge", forceManyBody<SimNode>().strength(-320))
  .force("link", /* unchanged undirected pair-link force */)
  .force("collide", /* unchanged */);
if (stratify) {
  // Vertical axis owned by the sink force; centering becomes horizontal-only so
  // forceCenter's mean-recentering doesn't fight the vertical distribution.
  sim.force("x", forceX<SimNode>(STAGE_W / 2).strength(0.05))
     .force("y", forceY<SimNode>((d) => yTargetFor(d.sink)).strength(STRENGTH_Y));
} else {
  sim.force("center", forceCenter(STAGE_W / 2, STAGE_H / 2)); // EXACT current path
}
sim.stop();
```

- The **flag-off branch is the literal current code** (`forceCenter`, no `x`/`y`
  forces) → byte-identical positions. Enforced by a golden test. **Force
  registration order matters:** d3 applies forces in insertion order each tick,
  so the off branch MUST register them in the exact current order
  (`charge, center, link, collide`) — do not refactor into a shared builder that
  reorders. The pseudocode above is illustrative; the implementer keeps the
  current `forceCenter` call sequence verbatim in the off path and only assembles
  the alternative (`…, x, y`) set in the on path.
- The main 300-tick loop with mass-inertia damping and the collision-relaxation
  AABB tail are **unchanged** in both branches.
- `forceX`/`forceY` are deterministic (positional targets, no PRNG); the seed,
  `randomSource`, iteration counts, and relax tail are untouched, so flag-on is
  deterministic too.
- `forceX` strength `0.05` is a gentle horizontal recentre replacing the removed
  `forceCenter` so the cloud doesn't drift off-stage on x; the pair-link force
  still does the real horizontal clustering.

### 2. `src/mcp-server/frame-map.ts` — gate + effective sink (call site)

`frame-map` already computes `const { stats } = rollupFrameFlows(nodes, edges)`
and holds `layerById`. Add the flag and, when on, attach an **effective sink**
per ambient frame before calling `layoutFrames`:

```ts
const applyLayout = opts.applyLayout ?? process.env.CORTEX_LAYER_LAYOUT === "1";
const statsById = new Map(stats.map((s) => [s.frame_id, s])); // already built
const positioned = layoutFrames(
  ambient.map((r) => ({
    frame_id: r.frame_id,
    frame_label: r.frame_label,
    member_count: r.member_count,
    ...(applyLayout ? { sink: effectiveSink(r.frame_id) } : {}),
  })),
  pairs,
);
```

`effectiveSink(frame_id)`:

```ts
const st = statsById.get(frame_id);
const flow = (st?.fanIn ?? 0) + (st?.fanOut ?? 0);
if (flow > 0) return st!.fanIn / flow;           // measured
return NOMINAL_SINK[layerById.get(frame_id) ?? "domain"]; // zero-flow fallback
```

`NOMINAL_SINK` (call-site table; the zero-flow fallback only — frames with flows
use the measured value):

| layer | nominal sink |
|---|---|
| interface | 0.10 |
| orchestration | 0.30 |
| domain | 0.50 |
| data | 0.70 |
| infrastructure | 0.90 |
| ceremony | 0.97 |

- `buildFrameMap(nodes, edges, opts?: { applyKindWeight?; applyDiversity?; applyLayout? })`.
  The env read lives here, not in the pure layout module; tests pass `applyLayout`
  explicitly.
- The serialized frame shape is unchanged (`x/y/w/h` only) — no `sink` or layer-
  layout internals leak into `/api/frames`.

## Data flow

```
/api/frames
  → rollupFrameFlows → stats (fanIn/fanOut)            (existing)
  → classify + kind-weight + diversity → ambient set   (existing; 3a/3b)
  → applyLayout ? attach effectiveSink per frame : {}  (frame-map gate)
  → layoutFrames(ambient + sink?, pairs)               (pure)
        stratify? forceY(yTarget(sink)) + forceX : forceCenter
  → positions; serialized x/y/w/h
```

## Error handling & edge cases

- **Flag off (default):** no frame carries `sink` → `layoutFrames` takes the
  `forceCenter` path → positions byte-identical to pre-slice. Golden-tested.
- **Single ambient frame:** `forceY` pulls it to its band; `forceX` to center.
  No links, no collisions. Deterministic.
- **All frames same sink** (e.g. all flowless in one layer): they share a y
  target; collide + AABB relax spread them horizontally within the band.
- **Degraded graph / no edges:** every frame is flowless → all use `NOMINAL_SINK`
  → stratifies by layer (the categorical fallback, which is acceptable when there
  is no measured signal at all).
- **sink out of range / undefined on a SimNode:** clamped to [0,1] in
  `yTargetFor`; `SimNode.sink` defaults to 0.5 if somehow unset.
- **Bounds:** the final half-size clamp (unchanged) keeps frames on-stage; the
  vertical band [TOP_Y, BOTTOM_Y] sits inside the margins so clamping is rare.

## Observe

The **primary signal is visual** — does the canvas read as a vertical slice? —
validated at Gate 0 on the live viewer (cortex + a corpus repo). Plus a light
numeric check in a corpus eval (extend `eval-layers` or a sibling): per repo, the
**Spearman rank correlation between each ambient frame's y and its sink**, flag
off vs on. On should show strong positive monotonic stratification (surface high
= low y, substrate low = high y) where off is ~uncorrelated.

The regression to watch: clustering breaking down (connected frames flung apart
by the vertical pull), or frames colliding / clamping at stage edges. Success:
clear vertical stratification with horizontal clustering preserved and no overlap
pathology. The verdict gates flipping the default on in a follow-up; this slice
ships flag-off.

## Testing

1. **Unit — `frame-layout.test.ts`:**
   - **Inert guard:** frames with no `sink` → positions byte-identical to the
     current golden (the `forceCenter` path is taken).
   - **Vertical ordering:** flag-on, a frame with `sink≈0` ends at a smaller `y`
     than a frame with `sink≈1` (allowing for collision jitter, assert a clear
     margin).
   - **Determinism:** two runs with sink present → identical positions; shuffled
     input order → identical (seed is order-independent).
   - **Bounds invariant** still holds with the vertical force on (frames clamped
     on-stage).
   - A frame's provided `sink` is honored verbatim (layout does no fallback — the
     call site resolves measured-vs-nominal).
2. **Unit — `frame-map` (`frame-map-layer.test.ts` or sibling):**
   - `applyLayout:false` → `layoutFrames` receives no `sink`; serialized positions
     equal the pre-slice golden (inert).
   - `applyLayout:true` → every ambient frame is laid out with an effective sink;
     a flowless frame gets its layer's `NOMINAL_SINK`; a frame with flows gets the
     measured ratio. Negative contract: no `sink`/layer-layout internals serialized.
   - default OFF (env unset) matches `applyLayout:false`; `CORTEX_LAYER_LAYOUT=1`
     matches `applyLayout:true`.
3. **Gate 0 visual QA:** flag off → canvas pixel-identical to current; flag on
   (cortex + a corpus repo) → frames stratify into a vertical slice, clustering
   still groups connected frames, no overlap/edge-clamp pathology, console clean.

## Out of scope

- **Floating-entity placement** (the next slice): replace the fixed bottom strip;
  below-cut frames + aggregates + post-reclamation residual files drift to a
  gravity centroid near their connected frames; **subsumes the `D-xwxj`
  governed-frame promotion** (`withGovernedFramesRendered` in the viewer).
- **Directed per-pair flow links** as the attraction force (this slice keeps the
  undirected pair-link clustering; the vertical axis is the only new force).
- **Flipping the default on** — a follow-up after the observe verdict.
- **Cross-cutting concern axis** — later, per the taxonomy arc.

## Decision capture

After implementation, capture: the measured-sink vertical force as a single new
positional force on the proven layout base (layout stays layer-agnostic — sink
threaded as a plain number, mirroring 3a/3b's number-threading); the
`forceCenter`→`forceX` swap applied only when stratifying; the nominal-sink
zero-flow fallback resolved at the call site; and the default-off inert
guarantee. Link to `src/mcp-server/frame-layout.ts`, `src/mcp-server/frame-map.ts`,
and this spec; relate to `D-wvsz` (layer-diversity) and the taxonomy design.

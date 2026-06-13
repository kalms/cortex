# Kind-Weight Ranking — Enable Slice (taxonomy step 3a)

> Design spec, approved 2026-06-13. First half of the enable slice from
> [`frame-ranking.md`](../cortex-v0.3/frame-ranking.md) (`Score = nameability ×
> structural weight × kind weight × diversity`). Ships **kind-weight only**;
> layer-diversity is a separate follow-up (step 3b). Builds on the earnable
> domain signal (decision `D-8vbv`, spec
> [2026-06-13-earnable-domain-signal-design.md](2026-06-13-earnable-domain-signal-design.md)).

## Goal

Let the architectural layer influence which frames are ambient. Today the
ambient set is the top-`budget` frames by `nameability × structural_weight` —
which favors big, well-named clusters regardless of narrative value (on
cortex, substrate `frame-extraction` outranks the product's subject). This
slice multiplies in a per-layer `kind_weight` so the ambient set tilts toward
the narrative layers (domain/interface/orchestration) and away from substrate
and ceremony — **behind a flag, default off, until validated**.

Layer-diversity (the `× diversity` term — "≥1 of domain/interface/data, cap
ceremony at one, penalize repeats") is **out of scope**: it is stateful
selection logic, observed separately as step 3b.

## Decision: kind-weight first, diversity next

`score = nameability × structural × kind_weight × diversity` decomposes into a
**static** factor (kind-weight, a per-frame multiplier) and a **stateful** one
(diversity, which depends on what's already selected). Shipping kind-weight
alone is a clean, deterministic, easily-attributed increment; bundling the
stateful diversity logic would make an ambient-set change impossible to
attribute to one mechanism during observe. (Same walk-before-run discipline as
the Louvain deferral.)

## Kind-weight table

From `frame-ranking.md`'s taxonomy table, with the earned/fallback domain split
from `D-8vbv`:

| layer | weight |
|---|---|
| domain (earned) | 1.00 |
| interface | 0.90 |
| orchestration | 0.85 |
| data | 0.75 |
| infrastructure | 0.55 |
| domain (fallback) | 0.50 |
| ceremony | 0.20 |

`domain (fallback)` at 0.50 is the D-qn7z trap's resolution: a frame that
*earned nothing* must not receive the top multiplier. Values are the spec's
opinionated defaults; the observe loop may tune them.

## Architecture

Three units; the pure ranker stays pure.

### 1. `src/frame-extraction/frame-kind.ts` — own the weights

The weights belong next to the taxonomy. Add:

```ts
export const KIND_WEIGHT: Record<FrameLayer, number> = {
  interface: 0.9, orchestration: 0.85, domain: 1.0,
  data: 0.75, infrastructure: 0.55, ceremony: 0.2,
};
/** Kind-weight for a classified frame. Fallback-domain is demoted to 0.5 —
 *  it earned nothing, so it must not carry domain's top weight (D-qn7z). */
export function kindWeight(layer: FrameLayer, fallback: boolean): number {
  if (layer === "domain" && fallback) return 0.5;
  return KIND_WEIGHT[layer];
}
```

### 2. `src/frame-extraction/frame-ranker.ts` — multiply a plain number

`FrameRecord` gains an optional `kind_weight?: number`. The ranker multiplies
it into the score and records it for explainability. It never sees the table,
the flag, or the layer — just a number, defaulting to 1.

```ts
export interface FrameRecord {
  /* …existing… */
  /** Per-layer ranking multiplier (taxonomy). Omitted (≡ 1) when the
   *  kind-weight feature is off → ranking is byte-identical to pre-slice. */
  kind_weight?: number;
}
// in rankFrames:
const kind_weight = r.kind_weight ?? 1;
const score = nameability * structural_weight * kind_weight;
// RankComponents gains: kind_weight
```

**Flag off ⇒ every record omits `kind_weight` ⇒ `× 1` ⇒ ranking byte-identical
to today.** This is the inert-by-default guarantee, enforced by a test.

### 3. `src/mcp-server/frame-map.ts` — reorder + gate

Today: `rankFrames` runs before classification. Reorder so classification
feeds the ranker:

```
rollupFrameFlows(nodes, edges)            (existing)
classifyFramesInternal(inputs)            (move BEFORE rankFrames; internal for `fallback`)
  → per record: kind_weight = applyKindWeight ? kindWeight(layer, fallback) : undefined
rankFrames(records-with-kind_weight, corpus)
layoutFrames(ambient)                     (existing; now reflects kind-weighted ambient set)
```

- `buildFrameMap(nodes, edges, opts?: { applyKindWeight?: boolean })`.
  `applyKindWeight` defaults to `process.env.CORTEX_KIND_WEIGHT === "1"`; tests
  pass it explicitly. The env read lives here, not in the pure ranker.
- `classifyFramesInternal` is used (not `classifyFrames`) because the ranker
  needs `fallback`. The flag is consumed only to pick `kind_weight`; **`fallback`
  is never written to `FrameMapEntry`** — the no-internals contract and its
  negative test are unaffected (a test asserts `/api/frames` carries no
  `fallback`/`confidence`/`contributions`).
- The `layer` field on each entry is unchanged.

## Data flow

```
/api/frames
  → rollupFrameFlows → classifyFramesInternal           (layer + fallback)
  → kind_weight per record (gated on CORTEX_KIND_WEIGHT) (frame-map)
  → rankFrames (score ×= kind_weight)                   (pure)
  → ambient = top-budget; layoutFrames(ambient)
```

## Error handling & edge cases

- Flag off (default): `kind_weight` undefined everywhere → ranking and ambient
  set identical to pre-slice. No reclassification, no reorder of output.
- Missing/empty edges (degraded graph): classifier still returns a layer +
  fallback for every frame; kind_weight always defined when the flag is on.
- A layer absent from `KIND_WEIGHT` is impossible (`FrameLayer` is closed), but
  `kindWeight` is total over the union.
- Ambient budget unchanged (`ambientBudget` is untouched) — only *which* frames
  fill it changes.

## Observe

Extend the corpus eval (`eval-layers.ts` or a sibling) to report, per repo, the
**ambient set with the flag off vs on**:

- frames that enter / leave the ambient set,
- the layer composition of the ambient set both ways,
- any fallback-domain or very-small frame that becomes ambient (the regression
  to watch — junk leapfrogging on weight alone).

Success: the ambient set tilts toward domain/interface/orchestration and sheds
substrate/ceremony, with **no** fallback-domain frame entering on weight alone.
The verdict gates flipping the default in a follow-up; this slice ships the
flag off.

## Out of scope

- **Layer-diversity** (step 3b): the `× diversity` term — greedy
  selection that guarantees ≥1 of domain/interface/data, caps ceremony at one,
  and decays repeats of an already-represented layer. Stateful; observed
  separately.
- **Flipping the default on** — a follow-up after the observe verdict.
- **Layout slice** (layer-adjacency force) — unchanged here.

## Testing

1. **Unit — `frame-kind.test.ts`:** `kindWeight` returns the table value per
   layer; `kindWeight("domain", true) === 0.5` and `kindWeight("domain", false)
   === 1.0`.
2. **Unit — `frame-ranker.test.ts`:** score multiplies `kind_weight`; a record
   with a higher kind_weight outranks an equal-base-score record with a lower
   one; **omitted `kind_weight` ≡ 1.0** (a frame set ranked with vs without the
   field, all weights 1, produces identical order + scores — the inert guard).
3. **Unit — `frame-map` (`frame-map-layer.test.ts` or sibling):** with
   `applyKindWeight:false` the ranked output equals the pre-slice output
   (golden); with `applyKindWeight:true` a known substrate-heavy fixture
   demotes the substrate frame below a domain frame it previously outranked.
   Negative contract still holds: no `fallback` in the serialized map.
4. **Determinism:** two runs with the flag on over shuffled input → identical
   ranks (kind_weight is a pure function of layer+fallback).
5. **Gate 0 visual QA:** flag off → ambient set pixel-identical to current;
   flag on (anthill) → ambient set visibly tilts toward domain/interface.

## Decision capture

After implementation: capture the kind-weight enable mechanism (static
per-frame multiplier threaded as a plain number to keep the ranker pure; flag
+ weights table at the call site; earned/fallback domain split 1.00/0.50;
default-off inert guarantee). Link to `frame-ranker.ts`, `frame-kind.ts`, and
this spec; relate to `D-8vbv` and `D-qn7z`.

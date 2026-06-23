# Frame Layers — Taxonomy Follow-up, Milestone 1: Classify + Observe

> Design spec, approved 2026-06-12. Realizes the first slice of the
> [`frame-ranking.md`](../../specs/cortex-v0.3/frame-ranking.md) taxonomy
> follow-up ("FrameKind layer-first taxonomy + classifier"), reshaped by
> measured graph evidence and an explicit classify → observe → enable rollout.
> Visual treatment validated interactively against a faithful canvas replica
> of the shipping viewer (brainstorm session 2026-06-12).

## Goal

Classify every extracted frame into one of six architectural layers —
`interface | orchestration | domain | data | infrastructure | ceremony` —
deterministically and replicably, and surface the result as a quiet,
toggleable lens in the 2D viewer. **Nothing else changes**: ranking, ambient
selection, and layout are untouched in this milestone.

## Why this slice first (decision: classify → observe → enable)

The taxonomy follow-up has three effect surfaces: the classifier, its ranking
effect (kind-weight + layer-diversity change the ambient set), and the
layer-adjacency layout force. Frames themselves were validated visually in
the viewer; the ranking effect perturbs exactly that validated baseline.
So milestone 1 ships the classifier **with zero ranking effect**, the user
visually validates layer assignments on real repos, and the enable slices
follow on a validated foundation. From the measured signals we expect 2–3 of
cortex's 14 frames to be legitimately contested (sharpest case:
`frame-extraction` — topologically substrate, semantically cortex's core
domain). Surfacing those cases is the purpose of the observation phase, not
a defect of it.

## End-user benefit: current state vs. shipped

**Today:** every frame renders with equal visual authority. The only signals
are label text and box size, and size (`sqrt(member_count)`) favors big
substrate — on cortex's own graph `frame-extraction` (56 files, the
most-imported substrate in the repo) visually dominates, while nothing tells
a newcomer that `contracts` is plumbing and `decisions` is the product's
subject. The `decisions` frame is 65% test files and nothing shows it.

**After milestone 1:** one new affordance — a `layers` item in the viewer
toolbar. It opens a small menu (viewer chrome vocabulary) containing a
`show layers` switch and the six-layer legend. Switch on: frame borders,
fills, and labels take a quiet per-layer hue, so the canvas reads as a stack
at a glance — `cli`/`mcp` surface-blue, `decisions` domain-ochre,
`contracts`/`events/worker` data-teal, `hooks`/`evals` ceremony-dim. Switch
off (default): **pixel-identical to today's viewer**. The legend exists only
inside the menu; the canvas gains no new elements in either state. Mesh
receives the same `layer` field through `/api/frames` for free.

**What this foundation buys later (explicitly NOT in this milestone):**
kind-weight + layer-diversity re-ranking (the ambient set shifts from "the
biggest, best-named clusters" to "a vertical slice of what the product is"),
the layer-adjacency layout force (canvas as architecture diagram), and
floating-entity placement (0.8.5: below-cut frames and aggregates drift to a
gravity centroid near their connected frames instead of the fixed bottom
strip). These were previewed and approved as an end-state direction; each is
its own future slice.

## Determinism contract (user requirement, non-negotiable)

- Same graph → same layers. No randomness, no timestamps, no LLM, no
  network. All thresholds and weights are named constants in committed code.
- Stable tie-breaks everywhere (fixed canonical layer order:
  `interface, orchestration, domain, data, infrastructure, ceremony`).
- **Internal machinery is never exposed to the user.** The classifier's
  internal record carries `confidence` and per-source contributions for the
  eval harness only. The public type — and the only thing serialized into
  `/api/frames` or rendered — is the layer string. No confidence, no source,
  no agreement data anywhere user-facing.

## Architecture

Three new units, all pure, following the `frame-ranker.ts` pattern
(inputs in, results out, no I/O):

### 1. `src/mcp-server/frame-flow-rollup.ts` — directed flows

The existing [`frame-pair-rollup.ts`](../../../src/mcp-server/frame-pair-rollup.ts)
is undirected (symmetric lo/hi keys) — correct for layout gravity, useless
for layer direction. This module is its directed counterpart, same inputs
(`NodeRow[]`, `EdgeRow[]`, same `ROLLUP_RELATIONS`):

```ts
export interface FrameFlow { from: number; to: number; weight: number }
export interface FrameFlowStats {
  frame_id: number;
  fanIn: number;       // Σ inbound inter-frame edge weight
  fanOut: number;      // Σ outbound inter-frame edge weight
}
export function rollupFrameFlows(nodes, edges): { flows: FrameFlow[]; stats: FrameFlowStats[] }
```

Intra-frame edges are skipped (as in the undirected rollup). Edge direction
is `source → target` as stored (CALLS/IMPORTS/USAGE are already directional
in the graph).

### 2. `src/frame-extraction/frame-kind.ts` — the classifier

```ts
export type FrameLayer =
  'interface' | 'orchestration' | 'domain' | 'data' | 'infrastructure' | 'ceremony';

export interface FrameKindInput {
  frame_id: number;
  frame_label: string;
  member_paths: string[];
  fanIn: number;
  fanOut: number;
}

/** Public result — the ONLY shape that leaves the module boundary. */
export interface FrameKind { frame_id: number; layer: FrameLayer }

/** Internal result — eval harness only. Not exported from the package
 *  surface that frame-map serializes. */
interface FrameKindInternal extends FrameKind {
  confidence: number;                      // argmax margin, 0–1
  contributions: Record<FrameLayer, number>;
}

export function classifyFrames(inputs: FrameKindInput[]): FrameKind[]
```

**Agreement-based combination (decision, deviates from frame-ranking.md's
first-match-wins chain).** Rationale: the spec's #1 source (ACDC dominator
symbol) cannot be built — the shipped tfidf+hdbscan pipeline produces no
dominator data — and measurement shows topology and lexical signals are
authoritative at *opposite ends* of the layer axis (topology separates
surface↔substrate; vocabulary refines the middle). So every source always
runs and emits a weight vector over the six layers; vectors are summed; the
final layer is the argmax, ties broken by canonical layer order. Fallback:
when the summed maximum is below `MIN_SIGNAL`, the layer is `domain` (per
frame-ranking.md's fallback, which the enable slice must treat carefully
since `domain` carries the highest kind-weight).

**Source A — graph position** (from `fanIn`/`fanOut`):
`sink = fanIn / (fanIn + fanOut)` (0.5 when no flows).

- `sink ≤ SINK_SURFACE (0.35)`: add `(0.5 − sink) × 2 × W_GRAPH` to
  **interface** and **orchestration** (the surface pair — topology cannot
  split them; lexical signals do).
- `sink ≥ SINK_SUBSTRATE (0.65)`: add `(sink − 0.5) × 2 × W_GRAPH` to
  **data** and **infrastructure** (the substrate pair).
- middle band: no contribution (deliberately silent where it is not
  authoritative).

**Source B — path patterns** (curated table, seeded from frame-ranking.md
§classification-sources; lives in code, versioned): for each layer, compute
the fraction of `member_paths` containing one of that layer's path segments,
and add `W_PATH × fraction` to that layer (multiple layers may accumulate;
a member counts toward each layer it matches). v1 table:
`routes|pages|views|components|cli|ui → interface` ·
`handlers|controllers|services|workflows|seed → orchestration` ·
`models|schemas|db|store|persistence|events → data` ·
`transport|infra|mcp-server|server|cache|queue|indexer → infrastructure` ·
`evals|scripts|build|hooks|config|integration → ceremony`.
Test-path tokens are deliberately excluded from this table (observation-phase finding, 2026-06-12): tests co-cluster with their subjects, so test-shadow paths fired ceremony on mixed frames in defiance of the TEST_FRACTION_MIN intent — test-ness belongs to Source C exclusively.
Source B additionally detects Nitro/h3 method-suffixed route files
(`*.{get,post,put,patch,delete,head,options}.{ts,js,…}`, case-insensitive,
**scoped to paths containing an `api` or `routes` segment**) as
**orchestration** at `W_HANDLER = W_PATH` × fraction (observation-phase
finding, 2026-06-13, on anthill-cloud): these handler frames are pure sources
(sink 0.0), the surface pair always tied, and the canonical tie-break starved
orchestration to zero frames — no path token matches the Nitro idiom. The
route-dir scoping exists because `<thing>.get.ts` is also a typed-accessor
idiom outside route dirs; unscoped, it flipped data-substrate frames.
(No path tokens map to `domain` — domain is what remains when a frame is
neither surface plumbing nor substrate plumbing nor ceremony; it wins via
fallback or content signals, never via directory ceremony.)

**Source C — content signals**:

- test-file fraction of members (`*.test.*`, `*.spec.*`, `/test/`):
  adds `W_TEST × fraction` to **ceremony** when fraction ≥ 0.8. (0.8, not
  0.5: cortex's clustering co-locates tests with their subjects — the
  `decisions` frame is 65% test files yet is the product's subject. Only a
  near-all-tests frame is ceremony *by content*; mixed frames must win or
  lose on other signals.)
- non-runtime extensions fraction (`.sh`, `.yml`, `.json`, `.md` majority):
  adds `W_CEREMONY_EXT` to **ceremony**.
- `frame_label` vocabulary: the label's tokens run through the same
  path-pattern table as Source B (no separate word list in v1); a match adds
  `W_LABEL` to the mapped layer.

The indexer's `is_entry_point` flag is **explicitly unused** — measured too
loose (72 "entry points" in frame-extraction alone).

Starter constants (tuned during observation, committed as code):
`W_GRAPH = 1.0`, `W_PATH = 0.8`, `W_TEST = 0.9`, `W_CEREMONY_EXT = 0.5`,
`W_LABEL = 0.4`, `MIN_SIGNAL = 0.4`.
MIN_SIGNAL was raised from 0.25 to 0.4 after the cortex fixture showed boundary-grazing topology alone (sink 0.33 → strength 0.34) claiming the `decisions` frame; a weak plurality must not override the domain fallback.

### 3. Orchestration + API — `frame-map.ts`

`frame-map.ts` already loads nodes, edges, and ranked frames for
`/api/frames`. It additionally calls `rollupFrameFlows` + `classifyFrames`
and attaches **one field** per frame in the response: `layer: FrameLayer`.
Read-time placement (decision): classification derives from data frame-map
already holds; zero schema change; classifier iteration takes effect on
server restart with no reindex — which is what makes the observe loop fast.
Persistence into `nodes.data` is **deferred, not designed** — revisit only
if Cypher queryability is actually wanted after observation.

### 4. Viewer — the `layers` menu item

In [`src/viewer/`](../../../src/viewer/) (index.html, style.css, viewer.js):

- Toolbar gains a `layers` button (existing toolbar button style) that opens
  a small dropdown anchored beneath it: a `show layers` switch row, a
  separator, and six legend rows (6px swatch + layer name, mono 10.5px,
  `--text-3`). Click-away closes. **The legend exists only here.**
- Switch ON applies the tint in the canvas draw path:
  - frame fill: layer RGB at alpha **0.032** (replaces `rgba(14,14,17,0.25)`)
  - frame border: layer RGB at alpha **0.22** (replaces `rgba(255,255,255,0.08)`)
  - frame label text: layer RGB at alpha **0.55** (replaces
    `rgba(237,237,237,0.5)`); count keeps its idle color
  - nothing else changes: dots, edges, decision pills, focus, hover, layout
    are all untouched
- Switch OFF (default): the draw path takes the exact existing constants —
  pixel-identical to today. State persists in `localStorage`
  (`cortex.viewer.layers`), like the theme toggle.
- Palette (softened ~20% toward neutral; validated in the mockup):

```
interface      rgb(92, 161, 237)
orchestration  rgb(171, 130, 237)
domain         rgb(234, 186, 95)
data           rgb(92, 204, 167)
infrastructure rgb(131, 141, 163)
ceremony       rgb(125, 110, 93)
```

Ceremony was originally `rgb(99, 105, 121)` — a cool gray that proved
indistinguishable from infrastructure's slate at lens alphas (observation
finding, 2026-06-13: a correct `infrastructure` frame on anthill-cloud read
as `ceremony` to the eye). Revised to a warm dim taupe: warm-vs-cool hue
separates where lightness alone washed out, and ceremony remains the dimmest
layer.

Light theme uses the same palette (the alphas are low enough; revisit in
observation if light-mode contrast disappoints).

## Data flow

```
/api/frames request
  → load nodes + edges + ranked frames        (existing)
  → rollupFrameFlows(nodes, edges)            (new, pure)
  → classifyFrames(frameInputs)               (new, pure)
  → response frames[] += { layer }            (one field)
viewer
  → layers menu switch → tint constants in draw path (no new canvas elements)
```

## Error handling & edge cases

- Frame with zero inter-frame flows: `sink = 0.5` → graph source silent;
  lexical sources decide or fallback `domain`.
- Empty/missing edges (degraded graph): classifier still returns a layer for
  every frame (lexical + fallback); never throws on empty inputs.
- Frames absent from `/api/frames` (non-ambient, no position): still
  classified — the field rides on every frame entry, placed or not.
- Stage with zero frames: `classifyFrames([]) → []`.
- The viewer treats a missing `layer` field (old server) as layers-off for
  that frame — no error, no tint.

## Testing

1. **Unit (pure modules)** — `frame-flow-rollup.test.ts`: direction
   preserved, intra-frame skipped, stats sums; `frame-kind.test.ts`: each
   source in isolation, agreement combination, canonical tie-break, fallback,
   empty inputs, and a determinism test (two runs over shuffled input order →
   identical output).
2. **Layer fixture (regression)** — as built: a frozen snapshot of cortex's
   frame inputs at `tests/fixtures/frame-layers/cortex-frames.json` (generated
   once by `scripts/frame-extraction/dump-frame-kind-inputs.ts` against a
   running server, then committed) plus hand-labeled expectations in
   `tests/frame-extraction/expected-layers.test.ts` — contested frames assert
   an `anyOf` set with written justification. The test's console agreement
   report is the only place `FrameKindInternal.confidence` is ever printed,
   and it runs in `npm test` (no network, no live graph).
3. **Gate 0 visual QA** — Playwright drive of the running viewer: toggle
   off → screenshot-compare against pre-change baseline (must be identical);
   toggle on → tint present, legend only in menu, console clean; reload →
   localStorage persistence.
4. **API shape** — `/api/frames` response: `layer` present on every frame,
   `confidence`/`source`/`contributions` present on none (explicit negative
   assertion).

## Out of scope (future slices, in order)

1. **Enable slice**: kind-weight + layer-diversity in `rankFrames`
   (flag-gated `CORTEX_KIND_WEIGHT=1` until validated), weights per
   frame-ranking.md's table; gated on the observation verdict + layer
   fixture.
2. **Layout slice**: layer-adjacency force in `frame-layout.ts`, using
   *measured* adjacency from `rollupFrameFlows` (which cross-layer flows
   actually exist) rather than categorical adjacency.
3. **Floating-entity placement** (0.8.5 item, previewed): below-cut frames +
   aggregates at gravity centroid near connected frames; subsumes the
   `D-xwxj` promotion stopgap.
4. **Cross-cutting concern axis**: graph communities spanning many frames
   (measured example: the 13-file freshness community scattered across 5
   frames) populate `FrameKind.concern: 'cross-cutting'` — the field the
   original spec reserved.

## Decision capture

After implementation, capture: (a) agreement-based source combination over
first-match-wins (with the dominator-source impossibility + measured
opposite-ends evidence as rationale); (b) read-time classification over
index-time persistence; (c) the no-internals-exposed determinism contract.
Link all three to `src/frame-extraction/frame-kind.ts` and this spec.

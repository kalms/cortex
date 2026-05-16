# Frame ambient-ranking — design notes

> Companion to `cortex-multiplayer-spec.md` §8. Adopted direction for v1
> implementation; verification is intrinsic-only (mechanical correctness,
> determinism, output statistics) — no human-evaluation phase. Quality
> judgement happens informally during development and through real-world
> use. Promote into §8 (likely as §8.14 or a new §8a) once corpus results
> confirm the algorithm runs cleanly and the output reads sensibly to
> maintainers.

---

## Problem

The ambient canvas must render the same truth for every viewer (per §8.6
determinism). It can't rely on viewer-local state (recent focus, user
pinning) or non-shared signals. Activity signals are also ruled out as a
*selection* criterion per §8.2: frames are stable semantic anchors; activity
is the motion on top, never the reason a frame appears or disappears.

The ambient has a finite visual budget — the prototype's 6 frames use most
of the canvas comfortably. An extractor that produces 12+ semantic frames on
a mid-size repo will exceed that budget. The question is which frames get
first-render priority without violating the shared-truth rule.

Key reframing: **frame extraction count and ambient render count are
separable layers.** The extractor produces the full semantic frame set
(whatever that is for the repo). A deterministic ranker — keyed on the same
shared inputs — picks the ambient budget. Frames that don't make the ambient
cut remain in the graph, queryable and navigable; they're just not on the
first-render map.

---

## Proposed ranking target

**Maximise semantic information density per ambient frame.**

Each of the 4–10 frames in the ambient should carry as much intrinsic
semantic information as possible. The optimisation has three components,
all measurable from the algorithm's own output without human input:

1. **Per-frame label specificity.** A frame called `auth` carries more
   information than one called `util`. Specificity is computable from
   the label content (penalty for generic tokens, bonus for
   dominator-anchored or markdown-section names).
2. **Layer-diversity coverage.** A spread across the architectural
   layers (interface, orchestration, domain, data, infrastructure)
   conveys more about the codebase than five frames from the same layer.
3. **Layer weighting.** Frames in business-meaning layers (domain
   highest) carry more semantic weight than frames in plumbing layers
   (infrastructure, ceremony).

This frames ambient ranking as an information-theoretic optimisation:
maximise the information density of the rendered set, given a fixed
budget. Intrinsic, deterministic, no human reader invoked. The
algorithm's design choices (nameability scoring, diversity rule,
generic-name penalty, layer weights) are all justified directly from
this target.

### Operational decomposition

Score = nameability × structural weight × kind weight × diversity.

- **Nameability** — how much the frame's label tells a reader
  - Dominator symbol names (from ACDC dominator pattern) score high — the
    cluster has a clear semantic anchor
  - Markdown-section matches score high (novel signal from the research
    brief)
  - Raw directory names score variably (`auth`/`routing` high,
    `lib`/`src`/`utils`/`misc`/`core` low)
  - A lookup table of "penalised generic names" handles the common
    low-signal cases (`util`, `helper`, `common`, `core`, `misc`,
    `shared`, `service`, `manager`, `handler`)
  - Low-confidence labels (e.g. "the cluster around schema.ts") receive
    the lowest nameability score and are usually pushed below the
    ambient cut
- **Structural weight** — entity count + centrality in the import/call
  graph
  - Normalised so a 200-entity frame doesn't unconditionally beat a
    30-entity one
- **Kind weight** — from the taxonomy (see next section)
- **Diversity** — within the ambient budget, prefer at least one frame
  from each of (domain, interface, data) when the repo has them; cap
  ceremony at one; penalise the 2nd+ frame of any layer already
  represented

---

## Taxonomy

Frame classification is the foundation the ranker and the layout engine
both stack on top of. Without a taxonomy, "diversity" has no defined
coordinate and layout distance can't be computed.

### Starter taxonomy (v1) — layer-first

Single dimension, 6 values, hand-curated weights. The axis is
**architectural layer**: where the frame sits in the stack from the user's
perspective down to the substrate, with a tail position for non-runtime
ceremony. Opinionated; tunable based on corpus results.

| Layer | Examples | Weight | Notes |
|---|---|---|---|
| Interface | views, pages, routes, cli, admin-ui | 0.90 | User-visible shell |
| Orchestration | controllers, handlers, services, workflows | 0.85 | Coordinates domain calls |
| Domain | business logic, entities, core models, the product's actual subject | 1.00 | Highest narrative value |
| Data | schemas, migrations, persistence, store, graph | 0.75 | Often load-bearing for narrative |
| Infrastructure | transport, cache, queue, storage, ws, mcp-server | 0.55 | Necessary but narratively quiet |
| Ceremony | build, scripts, config, tests, deploy, tooling | 0.20 | Usually drops below cut |

### Classification payload

Classification produces a structured record, not a bare string, so
additional axes can be added later without rewrites:

```ts
interface FrameKind {
  layer: 'interface' | 'orchestration' | 'domain' | 'data' | 'infrastructure' | 'ceremony'
  // Future axes — populated when we have the signals to extract them cheaply:
  // concern?: 'feature' | 'cross-cutting' | 'substrate'
  // lifecycleRole?: 'runtime' | 'build' | 'test' | 'observability'
  // visibility?: 'external' | 'internal' | 'developer-only'
  confidence: number     // 0–1
  source: 'dominator-symbol' | 'path-pattern' | 'content-signal' | 'low-confidence'
}
```

v1 only populates `layer`, `confidence`, and `source`. The other axes
are declared optional in the type so code that consumes `FrameKind`
doesn't need to change when they're added.

### Classification sources (priority order)

All intrinsic and deterministic — consistent with the extraction model
in `frame-extraction.md`. No framework templates, no LLM fallback, no
user input.

1. **Dominator symbol name.** When ACDC's dominator pattern produced a
   clear semantic anchor (a function/class/method dominating the
   cluster), the symbol's vocabulary maps to a layer. `authenticate`,
   `authorize`, `login` → orchestration or domain depending on
   surrounding signals; `render`, `view`, `template` → interface;
   `migrate`, `schema`, `query` → data.
2. **Path patterns.** A small curated list maps path segments to layers:
   `models/`, `schemas/`, `db/` → data; `routes/`, `pages/`,
   `views/`, `components/` → interface; `middleware/`, `transport/`,
   `infra/` → infrastructure; `scripts/`, `build/`, `tests/` →
   ceremony.
3. **Content signals.** Function-name patterns (`render*`, `migrate*`,
   `transport*`), file-extension patterns (`.test.ts` → ceremony;
   `.tsx` → interface for React projects), and CBM-derived structural
   markers (presence of class methods only invoked by tests → ceremony).
4. **Low-confidence fallback.** When 1–3 produce nothing definitive,
   the kind defaults to `domain` (the highest-weight layer) with
   `confidence < 0.3` and `source: 'low-confidence'`. The renderer
   may visually de-emphasise these frames.

### Maintenance

The taxonomy itself is stable — adding new kinds requires real
justification and a version bump. What evolves is the curated
path-pattern and content-signal rule sets. These are part of Cortex's
own code (committed, versioned, reviewed), not external content. Low
ongoing load.

### Distance and gravity (layout)

Once frames are classified, layout derives from taxonomy position:

- **Same layer** → high gravity between frames (cluster together spatially)
  *and* diversity penalty in the ranker (so you don't fill the ambient with
  three infrastructure frames)
- **Adjacent layers** (interface + orchestration + domain + data — the
  "vertical slice") → medium gravity, cluster loosely in the same canvas
  region
- **Non-adjacent** (e.g. domain vs ceremony) → repulsion, visual separation

This answers the layout-is-computed requirement: positions are a
deterministic function of the classified frame set, not hand-seeded
coordinates.

---

## Nodes outside frames

Not every node belongs to a frame. Three legitimate cases:

- **Root artefacts.** Files that belong to the repo as a whole rather than
  any subsystem: `package.json`, `README.md`, `LICENSE`, `tsconfig.json`,
  `.env.example`, `Dockerfile`, lockfiles. These will never cleanly belong
  to a frame and shouldn't be forced into one.
- **Unassigned extraction output.** Files the extractor couldn't cluster
  into any frame — a `lib/` orphan, a one-off utility, a clustering
  miss.
- **Auxiliary aggregates.** Auxiliary content (locales, fixtures,
  assets, snapshots) collapsed into one aggregate node per collection.
  Rendered at ~1.4× the dot size of a single source file so the count
  badge is legible and visual mass roughly matches actual content
  size — not a linear scale (a 1.2k aggregate is not 1200× larger
  than a single dot).

From the viewer's perspective they're identical: bare neutral dots in
canvas space *outside any frame boundary*, fully participating in the graph
— decisions can govern them, PRs can touch them, search finds them. They
just don't belong to a grouping. Provenance metadata on each node
(`isRoot: boolean`, `isUnassigned: boolean`) is kept for debugging; the
renderer doesn't treat them differently.

No labelled border around the region — giving "bare nodes" a name would
turn it into an accidental frame and imply grouping-hood. The region is
unbounded space.

Layout for bare nodes: positions driven by import/call neighbourhoods in
the graph. A bare node with strong ties to one frame drifts toward that
frame's edge without crossing in. A bare node with ties across multiple
frames finds a neutral position among them. A genuinely unconnected root
file (e.g. a LICENSE that imports nothing and is imported by nothing)
parks at the canvas edge.

This interacts with the "unassigned as valid output" rule in spec §8.5 —
that rule survives, but the §8.5 "edge strip or softly-bordered region" is
softened. It's just canvas space, not a bordered region.

---

## Properties of the ranker

- **Deterministic.** Every input is a pure function of shared state
  (the extracted frame set, CBM graph, decision graph, intrinsic
  label sources). No wall-clock, no viewer state, no external
  dependencies.
- **Stable.** Changes only when the underlying extraction changes.
  Re-rank triggers follow the same cache-key rules as re-extraction.
- **Explainable.** Each frame's ambient score has a reason. An agent
  can query "why is frame X in the ambient set and frame Y isn't?" and
  get an answer from the four score components.

---

## Implications

1. **Labelling quality is now load-bearing beyond just display.** The
   labelling priority in `frame-extraction.md` (dominator symbol →
   frequency-token → directory → markdown-section) influences ranking
   directly, not just display text. That raises the stakes on the
   dominator pattern's quality, the generic-token penalty list, and the
   markdown-section signal's hit rate.

2. **Layout becomes deterministic-from-inputs.** The prototype's
   hand-seeded frame positions (`x: 0.16, y: 0.30`) can't generalise
   to variable frame counts. Frame positions must be computed from the
   same shared state that drives ranking. Layout algorithm TBD — see
   open question #6 and the implementation risks section.

3. **"Overflow" and "unassigned" converge.** Frames that didn't make
   the ambient cut are structurally the same as unassigned files: in
   the graph, navigable via search / decision governance / PR touches,
   just not on the first-render map. Whether they need a dedicated
   visual treatment (a collapsed "other regions" dock) is TBD — the
   existing focus/search/drawer paths may cover it.

---

## Verification

Intrinsic-only — no human evaluation, no expert ground-truth clustering.
The corpus run produces three kinds of data, all automatable.

**Mechanical correctness:**
1. Algorithm runs to completion on every corpus repo
2. Every code entity gets assigned (frame, bare node, or aggregate) —
   no orphans
3. No errors, timeouts, or non-deterministic output across re-runs

**Determinism:**
- Re-run the full pipeline twice on the same repo. Outputs must be
  byte-identical (frame IDs, frame members, labels, ranks, layout
  positions)
- Cross-machine determinism: same repo on a different machine produces
  the same output (modulo platform-specific floats — pin to integer
  arithmetic where layout permits)

**Output statistics:**
- Distribution of frame counts per repo
- Distribution of label sources (dominator-symbol vs path-pattern vs
  content-signal vs low-confidence)
- Fraction of entities in bare nodes vs frames vs aggregates
- Classification confidence distribution (how many frames are above
  0.7? above 0.5? below 0.3?)
- Performance: end-to-end extraction + classification + ranking +
  layout cost per repo

**Cost targets** (no empirical basis — calibrate on Phase 1 results):
classification p95 under 50ms per frame; full corpus pass completes in
under 30s per repo.

**Quality judgement** is *not* part of formal verification. Maintainers
spot-check output during development; real-world use produces feedback
that informs the next iteration. The algorithm doesn't need to pass a
casual-viewer test before shipping — it ships as good as the intrinsic
signals allow, and improves through iteration on intrinsic-signal
quality.

Failure modes drive tuning:
- High `low-confidence` rate → path-pattern or content-signal rules
  too sparse; expand them
- "Interface" frames systematically under-ranked → raise base weight
- "Ceremony" frames bubbling above the ambient cut → harder penalty
  or tighter cap
- Maintainer spot-checks consistently flag a repo type as wrong → the
  layer axis may be missing a value for that codebase shape, or
  needs a second axis

---

## Open questions

1. **When to add a second axis.** v1 uses layer only. Extraction-cost
   benchmark tells us whether a second axis (concern or lifecycle-role)
   is affordable. Maintainer judgement on mixed repos (ML projects,
   research codebases, heterogeneous monorepos) tells us whether the
   single layer axis is discriminating enough or a second axis is
   needed. Add axis 2 only when both answers say yes.

2. ~~**Ambient budget size.**~~ *Resolved.* Proportional to extracted
   count with floor and cap: `max(4, min(10, ceil(extracted × 0.7)))`.
   Respects the determinism rule (pure function of shared state), adapts
   to repo size without leaving a half-empty canvas on small repos or
   forcing a hard cap on large ones. Tunable constants if corpus data
   points elsewhere.

3. **Overflow treatment.** Is there a visible "other regions" affordance on
   the ambient canvas for frames below the cut, or are they only reachable
   through search / navigation / drawer references? Ship without a dedicated
   overflow surface in v1; add one if corpus testing shows frames regularly
   missed that users needed to find.

4. **Tie-breaking at the cut.** When scores tie at the ambient cut line,
   tie-break lexicographically on frame ID (per §8.6 discipline).

5. **What happens when the repo has fewer than the target budget?**
   Render all extracted frames; don't invent padding. Canvas breathes;
   bare nodes (root artefacts, unassigned, aggregates) still render in
   open canvas space.

6. ~~**Layout algorithm.**~~ *Resolved.* See `frame-layout.md`.
   Force-directed (D3-force) consuming the gravity model from
   extraction + ranking. Deterministic via mulberry32 PRNG seeded
   from frame-set hash, fixed 300-iteration count, final
   quantisation to integer-pixel grid. Frame size scales sqrt-bounded
   to 110–160px band. Floating entities (PRs, decisions, TODOs,
   aggregates, bare nodes) all use uniform gravity-centroid
   positioning.

---

## V1 implementation risks

Underspecified mechanics that will need real design work before
implementation lands:

- ~~**Layout algorithm.**~~ Resolved in `frame-layout.md`.
- ~~**Aggregate node layout.**~~ Resolved in `frame-layout.md` —
  uniform gravity-centroid positioning, no type-specific docking.
- **Leiden version-pinning.** Determinism only holds for a given
  library version. Two installs on different versions produce
  different output on the same input. Pin the dep explicitly or skip
  Leiden entirely.
- **Schema migration.** New entity types (`Frame`, `Aggregate`,
  `Todo`) are real migrations on the existing Cortex SQLite schema.
  Existing v0.2.0 deployments need a migration path. Not designed.
- **CBM coverage gaps.** Auxiliary content (images, fonts, lockfiles)
  isn't parsed by CBM. Discovery happens via filesystem walk, parallel
  to CBM. Reconciliation rules between the two data sources are not
  yet designed.
- **No formal quality gate.** Verification is intrinsic-only;
  algorithm quality is judged informally by maintainers and through
  real-world use, not by a structured human-evaluation phase. The
  trade-off: faster iteration, lower operational cost, but no formal
  evidence the algorithm is "good enough" before shipping.
  Mitigation: keep the corpus runs visible during development, treat
  obvious failures as stop-the-line signals, ship and iterate.

---

## Status

Adopted as v1 direction 2026-04-21 during brainstorm pass on
`cortex-multiplayer-spec.md` §8. Reconciled 2026-04-28 to align with
`frame-extraction.md` (semantic-first extraction; no framework
templates; no LLM fallback; no user input shaping the algorithm). Build
to this; verify via the corpus; adjust or replace based on results.
Promote into the spec as `§8.14 Ambient ranking and taxonomy` (or
similar) once corpus data supports it.

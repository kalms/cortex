# Earnable Domain Signal — Frame-Layer Classifier (step 2 of the taxonomy follow-up)

> Design spec, approved 2026-06-13. Resolves the "domain question" that
> [`HANDOFF.md`](../../../HANDOFF.md) records as the gate on the enable slice.
> Builds on the milestone-1 classifier
> ([`src/frame-extraction/frame-kind.ts`](../../../src/frame-extraction/frame-kind.ts))
> and the observe-phase findings shipped in 0.8.7.

## Problem

On every real graph measured (cortex, anthill-cloud), the `domain` layer is
**only ever reached by fallback** — no frame earns it by positive signal. The
classifier's middle topological band (`SINK_SURFACE < sink < SINK_SUBSTRATE`,
i.e. 0.35–0.65) contributes nothing, so a frame with no surface, substrate, or
ceremony signal falls through to the `domain` default at `confidence 0`.

This collides with the enable slice (step 3), whose score is

```
Score = nameability × structural weight × kind weight × diversity
```

and whose kind-weight table gives `domain = 1.00` — the **highest** weight.
A frame that earned nothing would receive the top ranking multiplier. On
cortex that is 5 of 17 frames, including the #1 ambient frame. The original
[`frame-ranking.md`](../cortex-v0.3/frame-ranking.md) anticipated the
low-confidence fallback (it tagged those frames `confidence < 0.3`) but never
reconciled it with the weight table. Decision `D-qn7z` flagged the trap; this
spec resolves it.

## Decision: positive signal, cheap variant first (walk before run)

Three resolutions were considered (see HANDOFF observe section): make domain
**earnable** via a positive signal, **demote** the fallback's weight, or fix
**frame quality** upstream first. We take *earnable*, because it is the only
option that makes the layer mean what the taxonomy claims ("the product's
actual subject") rather than conceding the layer is undetectable — and it
**composes** with weight-demotion: once domain is earnable, the residual
fallback-domain is separately down-weighted via the `fallback` flag already
shipped in 0.8.7.

Within "earnable" there are two signals:

- **Runtime-content-in-the-topological-middle** (this spec) — ~15 lines,
  deterministic, reuses existing predicates. Rescues genuine mid-band runtime
  frames.
- **Louvain feature-community `concern` axis** (deferred) — catches
  heavily-imported *core* domain that reads as substrate (anthill's
  `dsl/compiler` at sink 0.83; cortex's 23-member `frame-extraction`). Requires
  reviving dead `ctx_louvain` code and wiring community detection into
  extraction; it is the reserved `concern` axis in the `FrameKind` type. Out of
  scope here, and overlaps the frame-quality track, so deferred until both are
  tackled together.

## Architecture — the signal

Domain is the **earned fallback**: the middle-band runtime residual is held
aside, and applied at combine time *only if no layer-specific source (B/C)
cleared `MIN_SIGNAL`*. This is the faithful form of "domain only takes a frame
where no layer-specific signal exists." (An earlier additive sketch —
`c.domain += residual` in Source A — was rejected because it let the generic
residual override a real-but-weak signal: a frame with a `W_LABEL` data hint
0.4 and runtime content 0.5 wrongly flipped to domain. A unit test caught it.)

In `classifyOne`, the middle-band branch computes but holds the residual:

```ts
// ── Source A: graph position — surface/substrate branches unchanged.
// Domain residual (middle band only), held aside — NOT summed here:
let domainResidual = 0;
if (sink > SINK_SURFACE && sink < SINK_SUBSTRATE && members.length > 0) {
  const runtimeFrac =
    members.filter((p) => !TEST_PATH_RE.test(p) && !NON_RUNTIME_EXT_RE.test(p)).length /
    members.length;
  domainResidual = W_DOMAIN_RUNTIME * runtimeFrac;
}
```

and the combine step applies it only as a fallback rescue:

```ts
if (bestScore < MIN_SIGNAL) {           // nothing layer-specific cleared the bar
  if (domainResidual >= MIN_SIGNAL) {   // ...but runtime residual does → EARNED
    c.domain += domainResidual; best = "domain"; bestScore = c.domain;
  } else {
    return { ...fallback domain, confidence: 0, fallback: true };
  }
}
```

New constant: `W_DOMAIN_RUNTIME = 0.5`.

### Why 0.5 — the threshold to earn domain

- **Override-protection is structural, not weight-based:** because the residual
  is applied only when no layer-specific source cleared `MIN_SIGNAL`, *any* real
  signal (path `W_PATH`, label `W_LABEL`, content) wins regardless of the
  residual's magnitude. A typed mid-band frame keeps its layer; the residual
  never competes with it.
- **`0.5 × 0.8 = 0.4 = MIN_SIGNAL`:** the bar to *earn* domain (vs. default to
  fallback-domain) is "**≥ 80% runtime content**, mid-band, untyped." A frame
  that is mostly tests/tooling scores below `MIN_SIGNAL` on the residual and
  stays fallback (or wins ceremony on its own content signal) — correctly.

### Reuse and continuity

- `TEST_PATH_RE` and `NON_RUNTIME_EXT_RE` already exist (Source C) — no new
  matching logic. `runtimeFrac` is their complement over members.
- The band edges are the existing `SINK_SURFACE` / `SINK_SUBSTRATE` constants;
  domain fires strictly inside, where surface/substrate are silent. The hard
  band boundary is consistent with the classifier's existing design (surface
  turns on at exactly 0.35).
- No change to the `fallback` mechanism: it keys off `bestScore < MIN_SIGNAL`,
  so earned domain clears it (`fallback = false`) for free and the residual
  stays `fallback = true`. The signal only feeds `contributions.domain`.

### Determinism

`runtimeFrac` is a pure fraction over sorted member paths; no randomness, no
timestamps. The determinism contract (spec, non-negotiable) is preserved.

## Measured effect (verified against live graphs, 2026-06-13)

**The signal demonstrates on anthill-cloud, not on cortex.** Measured
mid-band runtime fractions:

| repo · frame | sink | runtimeFrac | residual | verdict |
|---|---|---|---|---|
| anthill · `dsl/primitives` | 0.43 | 1.00 | 0.50 | **domain (earned)** — DSL core |
| anthill · `rbac-policies` | 0.50 | 1.00 | 0.50 | **domain (earned)** — authz policies |
| anthill · `activator` | 0.50 | 1.00 | 0.50 | **domain (earned)** |
| cortex · `frame-extraction` (7) | 0.42 | 0.57 | 0.29 | fallback — below bar |
| cortex · `cluster:12` | 0.49 | 0.75 | 0.38 | fallback — just below bar |
| cortex · `frame-extraction` (23) | 0.54 | 0.83 | 0.41 | ceremony — real content signal wins |
| cortex · `extraction/eval` | 0.36 | 0.47 | 0.24 | fallback — runtime-light eval harness |

The anthill frames are exactly the ones that were fallback-domain in the
original observe analysis — now upgraded to *earned*. **cortex earns no
domain**: its clusters co-locate tests with their subjects, so runtimeFrac
sits below the 0.8 bar (0.57 / 0.75 / 0.47). That is the documented
frame-quality ceiling, not a defect of the signal — and `W_DOMAIN_RUNTIME`
is deliberately **not** lowered to fit cortex (that would overfit one corpus
and assert confidence the frame quality doesn't support). cortex's regression
fixture therefore shows no reclassification — which is the conservative-
correctness evidence: no currently-correct assignment regresses (ceremony
keeps its stronger content signal, typed frames keep `W_PATH`, substrate /
surface bands untouched).

## Weight-table decision (recorded now, wired in step 3's enable slice)

Settled here so the enable slice inherits it:

- **earned domain → 1.00** — frame-ranking.md's top weight, now meaningful.
- **fallback domain → 0.50** — an unclassifiable frame has low narrative
  value; roughly tied with infrastructure (0.55), well below data (0.75). The
  two are *distinct*, which the `fallback` flag already enables. Exact value is
  tunable in step 3's own observe loop; the decision is the distinction.

## Out of scope

- The enable slice itself (kind-weight + layer-diversity in `rankFrames` behind
  `CORTEX_KIND_WEIGHT=1`) — step 3, a separate classify→observe→**enable**
  increment now safe to take.
- The Louvain `concern` axis (deferred, as above).
- Frame-quality work (fragmentation, co-cluster noise) — separate track.

## Testing

1. **Unit (TDD), `frame-kind.test.ts`:**
   - mid-band frame, runtime members, no path tokens → **earned** domain
     (`fallback = false`, `confidence > 0`).
   - mid-band frame with `store/` (data) tokens → stays **data** (domain 0.5
     does not override W_PATH 0.8).
   - mid-band frame that is mostly tests → stays fallback domain (or ceremony
     on content) — runtime signal below MIN_SIGNAL.
   - surface-band and substrate-band frames → unaffected (domain signal silent
     outside the middle).
   - empty-member mid-band frame → still fallback (guarded on
     `members.length > 0`).
   - determinism: shuffled input order → identical output.
2. **Regression fixture:** regenerate `tests/fixtures/frame-layers/cortex-frames.json`
   against the current 17-frame graph; relabel per the in-file judgment rules
   (the coverage guard enforces a label for every named frame); the agreement
   report now shows fewer `(fallback)` annotations.
3. **Gate 0 visual QA:** the lens tint shifts for reclassified frames
   (`frame-extraction`/`cluster:12` → domain ochre); off-state still
   pixel-identical; console clean.

## Decision capture

After implementation: capture the earnable-domain signal (positive residual in
the middle band, `W_DOMAIN_RUNTIME = 0.5` below `W_PATH`, rationale = make
domain mean the product's subject while staying a residual) and the
earned/fallback weight split (1.00 / 0.50). Link both to
`src/frame-extraction/frame-kind.ts` and this spec; relate to `D-qn7z`.

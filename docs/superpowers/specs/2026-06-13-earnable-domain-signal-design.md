# Earnable Domain Signal — Frame-Layer Classifier (step 2 of the taxonomy follow-up)

> Design spec, approved 2026-06-13. Resolves the "domain question" that
> [`HANDOFF.md`](../../../HANDOFF.md) records as the gate on the enable slice.
> Builds on the milestone-1 classifier
> ([`src/frame-extraction/frame-kind.ts`](../../../src/frame-extraction/frame-kind.ts))
> and the observe-phase findings shipped in 0.3.7.

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
shipped in 0.3.7.

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

One addition to Source A (graph position) in `classifyOne`, in the existing
middle-band branch that is currently silent:

```ts
// ── Source A: graph position
// ...surface and substrate branches unchanged...
else if (members.length > 0) {                  // middle band — was silent
  // Domain is the positive residual: runtime code sitting topologically
  // between surface and substrate, with no layer-specific signal of its own.
  const runtimeFrac =
    members.filter((p) => !TEST_PATH_RE.test(p) && !NON_RUNTIME_EXT_RE.test(p)).length /
    members.length;
  c.domain += W_DOMAIN_RUNTIME * runtimeFrac;
}
```

New constant: `W_DOMAIN_RUNTIME = 0.5`.

### Why 0.5 — domain as positive residual, not override

- **Below `W_PATH` (0.8):** a typed mid-band frame keeps its layer. A 100%
  runtime `store/` frame scores data `0.8` > domain `0.5` — Source B still
  wins. Domain only takes a frame where no layer-specific signal exists, which
  is exactly today's fallback condition — now *earned* instead of defaulted.
- **`0.5 × 0.8 = 0.4 = MIN_SIGNAL`:** the bar to earn domain is "**≥ 80%
  runtime content**, mid-band, untyped." A frame that is mostly tests/tooling
  scores below `MIN_SIGNAL` on this signal and stays fallback (or wins ceremony
  on its own content signal) — correctly.

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

## Expected effect (cortex, against live numbers)

| frame | sink | today | after |
|---|---|---|---|
| `frame-extraction` (7-member src split) | 0.42 | domain (fallback) | **domain (earned)** |
| `cluster:12` | 0.49 | domain (fallback) | **domain (earned)** if ≥80% runtime |
| `extraction/eval` | 0.36 | domain (fallback) | domain (fallback) — runtime-light eval harness |
| `decisions` | 0.33 | domain (fallback) | domain (fallback) — 65% tests, surface-band; frame-quality casualty |
| `contracts` | 0.69 | domain (fallback) | unchanged — substrate band, not middle |
| typed/ceremony frames | — | their layer | unchanged — those signals exceed 0.5 |

No currently-correct assignment regresses: ceremony frames keep their stronger
content signal, typed frames keep their `W_PATH` signal, and substrate/surface
bands are untouched.

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

# Cortex — Session Handoff

## ✅ DONE (2026-06-12 → 13 — frame layers milestone 1, deterministic viewer, field report)

Three merges to `main`, all gated (Gate 0 visual QA + reviews + green suite),
**none pushed** (`main` is ~25 commits ahead of origin).

### 0.3.4 — Frame layers taxonomy, milestone 1: classify + observe
- **Deterministic 6-layer classifier**
  ([src/frame-extraction/frame-kind.ts](src/frame-extraction/frame-kind.ts)):
  agreement-based combination (NOT the original first-match chain — its
  dominator source is unbuildable, and measurement showed topology owns the
  surface↔substrate ends while lexicon owns the middle) of three sources:
  directed graph position ([frame-flow-rollup.ts](src/mcp-server/frame-flow-rollup.ts),
  fan-in/fan-out sink ratio), curated path patterns, content signals.
  Argmax + canonical tie-break + `domain` fallback below `MIN_SIGNAL`.
- **`layer` rides every `/api/frames` entry** (read-time in `buildFrameMap`,
  nothing persisted). Internals (confidence/contributions) **never serialize**
  — negative test enforces it.
- **Viewer `layers` menu**: toolbar item → dropdown with `show layers` switch
  + the only legend. On = quiet per-layer tint (fill 0.032 / border 0.22 /
  label 0.55, palette softened ~20%); **off (default) = pixel-identical**
  (draw-path `else` branches are the literal pre-lens expressions).
  localStorage-persisted; ARIA + keyboard on the switch.
- **Regression net**: frozen fixture
  ([tests/fixtures/frame-layers/cortex-frames.json](tests/fixtures/frame-layers/cortex-frames.json),
  generator `scripts/frame-extraction/dump-frame-kind-inputs.ts`) +
  hand-labeled `anyOf` expectations
  ([expected-layers.test.ts](tests/frame-extraction/expected-layers.test.ts))
  with a console agreement report on every `npm test`. It caught two real
  bugs pre-merge: test-path tokens leaked ceremony onto mixed frames
  (removed from Source B — test-ness is Source C's exclusively, gated 0.8),
  and `MIN_SIGNAL` 0.25 let boundary-grazing topology claim `decisions`
  (raised to 0.4).
- **Ranking and layout deliberately untouched** — classify → observe →
  enable rollout, per the approved spec.
- Decisions **`D-qn7z`** (agreement combination), **`D-24p0`** (read-time
  placement), **`D-b1gd`** (determinism / no-internals contract).
  Spec: [docs/superpowers/specs/2026-06-12-frame-layers-taxonomy-design.md](docs/superpowers/specs/2026-06-12-frame-layers-taxonomy-design.md) ·
  Plan: [docs/superpowers/plans/2026-06-12-frame-layers-taxonomy.md](docs/superpowers/plans/2026-06-12-frame-layers-taxonomy.md)

### 0.3.5 — Deterministic collision-aware dot placement
- Viewer dots were `Math.random` per load → ~1–2 dot pairs per dense frame
  rendered as one dot, faking "duplicate edges" to a single target. Dots now
  sit on a jitter-bounded grid (cell from member index, jitter seeded from
  file path, fnv1a + mulberry32 — D-pzc8's seeding approach); decision anchor
  dots seeded too. **Last `Math.random` removed from the render data path**;
  verified by byte-identical screenshots across reloads.
- ⚠ numbering: this consumed the version `0.3.5`; the feature line progress.md
  used to call "0.3.5" (TODO entity etc.) is now **0.3.6+** (progress.md updated).

### 0.3.3 — Field report + improvement plan (docs)
- [docs/field reports/field-report-2026-06-12-mesh-m1-platform-consumer.md](docs/field%20reports/field-report-2026-06-12-mesh-m1-platform-consumer.md)
  — first report from the platform-consumer seat (Mesh consumes the HTTP API
  as a sidecar). Honest token-economics ledger + prioritized **P1–P8 plan**:
  context_pack composite tool · search ranking · target-repo-aware grep hook ·
  warm-path decision drafting · cross-repo decision search · **versioned HTTP
  contract + freshness over HTTP** (gates Mesh) · token-tax reduction ·
  temporal layer.

### Measurements worth keeping (2026-06-12 session)
- **Graph communities**: multi-level Louvain over the real import/call graph
  confirms the shipped clustering's cores and finds cross-cutting subsystems
  lexical signals can't see (13-file freshness community scattered across 5
  frames). `ctx_louvain` in cortex-indexer is **dead code** (test-only,
  single-level). Candidate: hybrid signal into frame extraction +
  `FrameKind.concern` axis.
- **IMPORTS edges stay**: 23% of import-coupled file pairs are import-only
  (type imports — irreplaceable coupling); removing IMPORTS flips 5/15 frame
  layer bands. Settled: keep. (The drawn web was already CALLS-only.)

## 🔬 OBSERVE PHASE — findings (2026-06-13, cortex + anthill-cloud)

The :3333 plugin server **is restarted and serving `layer`** (the old
"restart needed" step is done). Observe ran on both repos: live `/api/frames`
+ the internal classifier (`classifyFramesInternal`) over regenerated inputs.
No-internals contract verified live (nothing beyond `layer` serializes).

**Verdict: classifier behaves as designed; do NOT enable kind-weight yet.**
Findings, by nature:

- **`domain` is never earned, only fallen into.** Cortex: all 5 domain
  frames are `MIN_SIGNAL` fallbacks (conf 0.00) — including the #1 ambient
  frame `extraction/eval`. Anthill: `dsl/compiler` (the product's core) is
  an *exact* data=0.66 / infrastructure=0.66 tie, coin-flipped to `data` by
  canonical order; sink 0.83 because everything imports it. **Cross-repo
  confirmed: heavily-imported core domain reads topologically as substrate.**
  This gates the enable slice — `domain` carries the highest kind-weight
  (1.00) and is currently awarded precisely for the absence of signal
  (D-qn7z's trap, now quantified). Options to decide: a positive domain
  signal (per-repo tokens? Louvain `concern` axis from the 06-12
  measurements?), demote the fallback, or lower fallback-domain's weight.
- **Orchestration starves on framework idioms.** Anthill: 10/21 frames
  interface, 0 orchestration — Nuxt/Nitro `server/api/*.{get,post}.ts`
  handlers (sink 0.00, conf 0.00) tie the surface pair and canonical order
  always picks `interface`; no orchestration token matches Nitro paths.
  Cortex's only orchestration frame exists via the literal token "seed".
  → fixed on this branch (handler-suffix signal).
- **Infra/ceremony grays are visually confusable** — `arcane/server` (a
  correct `infrastructure`, conf 0.60) read as `ceremony` to the user's eye;
  the two hues are near-identical at lens alphas. → fixed on this branch.
- **`conf=0.00` conflates two states**: pure fallback (no signal → domain)
  vs within-pair tie (strong signal, unsplit pair, e.g. `api/post`). → eval
  report now distinguishes them (this branch).
- **Frame quality is the real ceiling** (upstream of the classifier):
  cortex's core domain fragments into 3 frames (`frame-extraction` ×2 +
  `extraction/eval`; the 23-member one is 64% tooling → honestly classified
  `ceremony` at ambient rank 9); anthill's `dsl/compiler` frame contains 4
  unrelated Vue modals from `apps/cloud`. Tuning classifier constants cannot
  fix clustering. Defensible-but-odd, accepted for now: `drizzle` →
  `ceremony` (7 generated `meta/*_snapshot.json` files).

## ▶ NEXT STEP

1. ✅ **Observe-polish branch landed** (0.3.7): fixture regen + coverage guard,
   handler-suffix orchestration signal, palette separation, tie/fallback report.
2. ✅ **Domain question resolved** — earnable domain via an *earned-fallback*
   runtime signal in the middle sink band (decision **`D-8vbv`**, spec
   [2026-06-13-earnable-domain-signal-design.md](docs/superpowers/specs/2026-06-13-earnable-domain-signal-design.md)).
   `W_DOMAIN_RUNTIME = 0.5` (earn bar ≈80% runtime), held aside so any real
   layer signal still wins. **Measured:** earns domain for anthill's
   `dsl/primitives` / `rbac-policies` / `activator`; earns nothing on cortex
   (test-co-clustering depresses runtimeFrac — the frame-quality ceiling, not a
   defect). Substrate-band core domain (`dsl/compiler`) still needs the deferred
   Louvain `concern` axis. Enable-slice weights settled: **earned domain 1.00,
   fallback domain 0.50.**
3. ✅ **Enable slice 3a — kind-weight shipped** (flag-gated, decision **`D-g4qb`**,
   spec [2026-06-13-kind-weight-enable-slice-design.md](docs/superpowers/specs/2026-06-13-kind-weight-enable-slice-design.md)).
   `score ×= kind_weight` (earned domain 1.00 / interface 0.90 / orchestration
   0.85 / data 0.75 / infra 0.55 / fallback-domain 0.50 / ceremony 0.20), behind
   `CORTEX_KIND_WEIGHT` **default off (inert — ranking byte-identical when off)**.
   Ranker stays pure (kind_weight a plain number on `FrameRecord`); weights +
   flag at the call site. **Observe verdict (corpus, 11 repos, `eval-layers.ts`
   ambient before/after):** kind-weight ON consistently evicts ceremony/config
   noise (eslint-config, playwright-config, tsconfig, training/scripts, test
   cassettes, json-schemas) and tilts ambient toward interface/domain/data; the
   0.50 fallback-domain demotion correctly yields fallback-domain to interface
   (rubygems `mailer`); **no junk leapfrogged into ambient** (D-qn7z trap held).
   Neutral on tiny/already-diverse repos (cobra/click/vueuse).
   **→ Verdict is positive; recommended next step is to FLIP THE DEFAULT ON** (a
   small follow-up: change the `CORTEX_KIND_WEIGHT` default in `buildFrameMap`,
   re-run Gate 0).
4. **Enable slice 3b — layer-diversity** (deferred): the `× diversity` term —
   greedy selection guaranteeing ≥1 of domain/interface/data, cap ceremony at
   one, decay repeats of an already-represented layer. Stateful; its own slice.
5. **Layout slice**: layer-adjacency force in `frame-layout.ts` using
   *measured* adjacency from `rollupFrameFlows` (not categorical), then
   floating-entity placement (subsumes the `D-xwxj` promotion stopgap).
   End-state visual direction was previewed + approved in the 2026-06-12
   brainstorm (`.superpowers/brainstorm/` mockups).
6. **Co-change lens** (parallel, small): `FILE_CHANGES_WITH` minus structural
   edges = hidden coupling — a sibling row in the layers menu, dashed quiet
   style, ~55 edges of ink. The lens pattern (menu + deterministic + off =
   identical) is established; follow it.
7. **Agentic-experience P1–P8** (parallel): quick wins first — target-repo-
   aware grep hook (P3), search ranking (P2) — then `context_pack` (P1).
   **P6 (versioned HTTP contract + freshness header) should land before
   Mesh's viewer-adaptation milestone** consumes `/api/frames`/`/api/file-edges`.
8. **Push to origin** when ready — `main` is ~25 commits ahead, all local.
9. **Mesh side** (separate repo, waiting on Figma): faithful viewer
   adaptation + threads-to-top; keep pan/zoom. Mesh consumes the `layer`
   field for free once its sidecar runs ≥0.3.4.

---

_Previous handoff content (graph-DB transactional-swap publish, 2026-06-10,
decision `D-47xb`; freshness signal + auto-refresh, 2026-06-07, decision
`bbf0fce5`) is superseded-and-stable: shipped, verified, and documented in
[docs/architecture/graph-storage.md](docs/architecture/graph-storage.md) and
CLAUDE.md. progress.md's Known-issues section now reflects their resolution._

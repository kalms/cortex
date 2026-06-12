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

## ▶ NEXT STEP

1. **Restart Claude Code / the MCP server** (dev-reload, again): the plugin
   server on :3333 still runs pre-layers code — the `layer` field and the
   lens only work against a restarted server. Then flip the `layers` switch
   in the viewer and **start the observe phase**: validate layer assignments
   on cortex + anthill-cloud. Watch list: `frame-extraction` (now splits into
   a domain frame + a tooling frame), `contracts` (domain via fallback),
   `mcp`. Tuning loop: edit constants in `frame-kind.ts` → `npm test` (the
   fixture prints the agreement report) → look. Regenerate the fixture
   against the current 17-frame graph first
   (`npx tsx scripts/frame-extraction/dump-frame-kind-inputs.ts > tests/fixtures/frame-layers/cortex-frames.json`,
   relabel per the in-file judgment rules).
2. **Enable slice** (after observe verdict): kind-weight + layer-diversity in
   `rankFrames` behind `CORTEX_KIND_WEIGHT=1`. Weights per `frame-ranking.md`
   (domain 1.00 … ceremony 0.20). Mind the trap recorded in D-qn7z: `domain`
   is both the fallback layer and the highest weight.
3. **Layout slice**: layer-adjacency force in `frame-layout.ts` using
   *measured* adjacency from `rollupFrameFlows` (not categorical), then
   floating-entity placement (subsumes the `D-xwxj` promotion stopgap).
   End-state visual direction was previewed + approved in the 2026-06-12
   brainstorm (`.superpowers/brainstorm/` mockups).
4. **Co-change lens** (parallel, small): `FILE_CHANGES_WITH` minus structural
   edges = hidden coupling — a sibling row in the layers menu, dashed quiet
   style, ~55 edges of ink. The lens pattern (menu + deterministic + off =
   identical) is established; follow it.
5. **Agentic-experience P1–P8** (parallel): quick wins first — target-repo-
   aware grep hook (P3), search ranking (P2) — then `context_pack` (P1).
   **P6 (versioned HTTP contract + freshness header) should land before
   Mesh's viewer-adaptation milestone** consumes `/api/frames`/`/api/file-edges`.
6. **Push to origin** when ready — `main` is ~25 commits ahead, all local.
7. **Mesh side** (separate repo, waiting on Figma): faithful viewer
   adaptation + threads-to-top; keep pan/zoom. Mesh consumes the `layer`
   field for free once its sidecar runs ≥0.3.4.

---

_Previous handoff content (graph-DB transactional-swap publish, 2026-06-10,
decision `D-47xb`; freshness signal + auto-refresh, 2026-06-07, decision
`bbf0fce5`) is superseded-and-stable: shipped, verified, and documented in
[docs/architecture/graph-storage.md](docs/architecture/graph-storage.md) and
CLAUDE.md. progress.md's Known-issues section now reflects their resolution._

# Kind-Weight Ranking Enable Slice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiply a per-layer `kind_weight` into the frame ranking score, behind `CORTEX_KIND_WEIGHT` (default off, inert), so the ambient set tilts toward narrative layers.

**Architecture:** The weights table + `kindWeight(layer, fallback)` helper live in `frame-kind.ts` (next to the taxonomy). The pure ranker gains an optional `kind_weight?: number` it just multiplies in (omitted ≡ 1.0 ≡ unchanged). `frame-map.ts` reorders classification before ranking, reads the env flag, and threads the weight per record — `fallback` is used only to pick the weight, never serialized.

**Tech Stack:** TypeScript, Vitest, the corpus eval harness (`scripts/frame-extraction/eval-layers.ts`).

Spec: [docs/superpowers/specs/2026-06-13-kind-weight-enable-slice-design.md](../specs/2026-06-13-kind-weight-enable-slice-design.md)

---

### Task 1: Kind-weight table + helper in frame-kind.ts

**Files:**
- Modify: `src/frame-extraction/frame-kind.ts`
- Test: `tests/frame-extraction/frame-kind.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/frame-extraction/frame-kind.test.ts` (add `KIND_WEIGHT, kindWeight` to the existing import from `frame-kind.js`):

```typescript
describe("kind weight (enable slice)", () => {
  it("returns the taxonomy weight per layer", () => {
    expect(kindWeight("domain", false)).toBe(1.0);
    expect(kindWeight("interface", false)).toBe(0.9);
    expect(kindWeight("orchestration", false)).toBe(0.85);
    expect(kindWeight("data", false)).toBe(0.75);
    expect(kindWeight("infrastructure", false)).toBe(0.55);
    expect(kindWeight("ceremony", false)).toBe(0.2);
  });

  it("demotes fallback-domain to 0.5 (D-qn7z: earned nothing → not top weight)", () => {
    expect(kindWeight("domain", true)).toBe(0.5);
  });

  it("fallback flag only affects domain", () => {
    expect(kindWeight("interface", true)).toBe(0.9);
    expect(kindWeight("ceremony", true)).toBe(0.2);
  });

  it("KIND_WEIGHT covers every FrameLayer", () => {
    for (const layer of LAYER_ORDER) expect(typeof KIND_WEIGHT[layer]).toBe("number");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/frame-kind.test.ts -t "kind weight"`
Expected: FAIL — `kindWeight`/`KIND_WEIGHT` are not exported (`is not a function` / `undefined`).

- [ ] **Step 3: Implement the table + helper**

In `src/frame-extraction/frame-kind.ts`, after the `LAYER_ORDER` declaration, add:

```typescript
/** Per-layer ranking multiplier (frame-ranking.md taxonomy table). Used by the
 *  enable slice (kind-weight) to tilt the ambient set toward narrative layers. */
export const KIND_WEIGHT: Record<FrameLayer, number> = {
  interface: 0.9,
  orchestration: 0.85,
  domain: 1.0,
  data: 0.75,
  infrastructure: 0.55,
  ceremony: 0.2,
};

/** Kind-weight for a classified frame. Fallback-domain is demoted to 0.5: a
 *  frame that earned nothing (D-8vbv) must not carry domain's top weight — the
 *  D-qn7z trap. Total over the FrameLayer union. */
export function kindWeight(layer: FrameLayer, fallback: boolean): number {
  if (layer === "domain" && fallback) return 0.5;
  return KIND_WEIGHT[layer];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/frame-kind.test.ts`
Expected: PASS (all, including the existing classifier tests).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-kind.ts tests/frame-extraction/frame-kind.test.ts
git commit -m "feat(frame-kind): KIND_WEIGHT table + kindWeight(layer, fallback) helper

Per-layer ranking multiplier (frame-ranking.md), fallback-domain demoted to
0.5 (D-qn7z). Pure; consumed by the enable slice.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: kind_weight factor in the pure ranker

**Files:**
- Modify: `src/frame-extraction/frame-ranker.ts`
- Test: `tests/frame-extraction/frame-ranker.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/frame-extraction/frame-ranker.test.ts`. Use the file's existing `corpusFromPaths` helper (defined at the top: builds a corpus where each file's blob text is its path tokens, so a label matching the path scores nonzero nameability — required for the multiplier test to differentiate).

```typescript
describe("kind_weight factor (enable slice)", () => {
  it("omitted kind_weight is inert (≡ 1.0): identical ranks/scores to no field", () => {
    // Inert holds at any nameability — even 0 — since with×1 == without.
    const recs = [
      { frame_id: 1, frame_label: "auth", member_paths: ["a/auth.ts", "a/auth2.ts"] },
      { frame_id: 2, frame_label: "billing", member_paths: ["b/billing.ts", "b/billing2.ts"] },
    ];
    const corpus = corpusFromPaths(recs.flatMap((r) => r.member_paths));
    const withField = rankFrames(recs.map((r) => ({ ...r, kind_weight: 1 })), corpus);
    const without = rankFrames(recs, corpus);
    expect(withField.map((r) => [r.frame_id, r.score, r.rank]))
      .toEqual(without.map((r) => [r.frame_id, r.score, r.rank]));
  });

  it("a higher kind_weight outranks an equal-base-score frame", () => {
    // Identical labels + member counts → identical nameability×structural;
    // corpusFromPaths makes "auth" score nonzero, so kind_weight is the only
    // differentiator (0 scores would tie-break by frame_id and mask the effect).
    const recs = [
      { frame_id: 1, frame_label: "auth", member_paths: ["a/auth.ts", "a/auth2.ts"], kind_weight: 0.5 },
      { frame_id: 2, frame_label: "auth", member_paths: ["b/auth.ts", "b/auth2.ts"], kind_weight: 1.0 },
    ];
    const ranked = rankFrames(recs, corpusFromPaths(recs.flatMap((r) => r.member_paths)));
    expect(ranked[0].frame_id).toBe(2);
    expect(ranked[0].components.kind_weight).toBe(1.0);
    expect(ranked.find((r) => r.frame_id === 1)!.score)
      .toBeCloseTo(ranked.find((r) => r.frame_id === 2)!.score * 0.5, 10);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts -t "kind_weight factor"`
Expected: FAIL — `components.kind_weight` is undefined and scores ignore the field.

- [ ] **Step 3: Implement the factor**

In `src/frame-extraction/frame-ranker.ts`:

(a) Add to `FrameRecord`:
```typescript
  /** Per-layer ranking multiplier (taxonomy). Omitted (≡ 1) when the
   *  kind-weight feature is off → ranking is byte-identical to pre-slice. */
  kind_weight?: number;
```

(b) Add to `RankComponents`:
```typescript
  /** Per-layer multiplier applied to the score (1 when the feature is off). */
  kind_weight: number;
```

(c) In `rankFrames`'s `.map`, after `structural_weight`:
```typescript
    const kind_weight = r.kind_weight ?? 1;
    const score = nameability * structural_weight * kind_weight;
```
and add `kind_weight` to the returned `components` object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts`
Expected: PASS (new + existing — existing tests omit the field so `× 1`, scores unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-ranker.ts tests/frame-extraction/frame-ranker.test.ts
git commit -m "feat(frame-ranker): optional kind_weight factor (omitted ≡ 1, inert)

score = nameability × structural_weight × (kind_weight ?? 1). Ranker stays
pure — it multiplies a plain number; the table/flag live at the call site.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Reorder + gate in frame-map.ts

**Files:**
- Modify: `src/mcp-server/frame-map.ts`
- Test: `tests/mcp-server/frame-map-layer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mcp-server/frame-map-layer.test.ts` (reuses the file's existing `nodes`/`edges` fixture: `cli`→interface, `events`→data):

```typescript
describe("kind-weight gating", () => {
  it("flag OFF: scores identical to no kind-weight (inert by default)", () => {
    const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
    const dflt = buildFrameMap(nodes, edges); // env unset in test → off
    expect(off.frames.map((f) => [f.id, f.score])).toEqual(dflt.frames.map((f) => [f.id, f.score]));
  });

  it("flag ON: each frame's score is its off-score × kindWeight(layer)", () => {
    const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
    const on = buildFrameMap(nodes, edges, { applyKindWeight: true });
    const offById = new Map(off.frames.map((f) => [f.id, f]));
    for (const f of on.frames) {
      const base = offById.get(f.id)!;
      const w = f.layer === "interface" ? 0.9 : f.layer === "data" ? 0.75 : 1.0;
      expect(f.score).toBeCloseTo(base.score * w, 10);
    }
  });

  it("flag ON still serializes no classifier internals", () => {
    const json = JSON.stringify(buildFrameMap(nodes, edges, { applyKindWeight: true }));
    expect(json).not.toContain("fallback");
    expect(json).not.toContain("confidence");
    expect(json).not.toContain("contributions");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mcp-server/frame-map-layer.test.ts -t "kind-weight gating"`
Expected: FAIL — `buildFrameMap` takes no third arg; flag-on scores equal flag-off (no weighting yet).

- [ ] **Step 3: Reorder + gate in buildFrameMap**

In `src/mcp-server/frame-map.ts`:

(a) Update the import to use the internal classifier + the helper:
```typescript
import { classifyFramesInternal, kindWeight, type FrameLayer } from "../frame-extraction/frame-kind.js";
```
(remove the `classifyFrames` import if now unused).

(b) Change the signature:
```typescript
export function buildFrameMap(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  opts: { applyKindWeight?: boolean } = {},
): FrameMap {
  const applyKindWeight = opts.applyKindWeight ?? process.env.CORTEX_KIND_WEIGHT === "1";
```

(c) Move classification ABOVE `rankFrames` and thread `kind_weight` onto the records. Replace the current `const ranked = rankFrames(records, corpus);` + later classify block with:
```typescript
  const corpus = buildCorpusIndex(buildFileBlobs(nodes));
  const { stats } = rollupFrameFlows(nodes, edges);
  const statsById = new Map(stats.map((s) => [s.frame_id, s]));
  const kinds = classifyFramesInternal(
    records.map((r) => ({
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_paths: r.member_paths,
      fanIn: statsById.get(r.frame_id)?.fanIn ?? 0,
      fanOut: statsById.get(r.frame_id)?.fanOut ?? 0,
    })),
  );
  const kindById = new Map(kinds.map((k) => [k.frame_id, k]));
  const layerById = new Map<number, FrameLayer>(kinds.map((k) => [k.frame_id, k.layer]));

  const ranked = rankFrames(
    records.map((r) => {
      if (!applyKindWeight) return r;
      const k = kindById.get(r.frame_id);
      return k ? { ...r, kind_weight: kindWeight(k.layer, k.fallback) } : r;
    }),
    corpus,
  );
```
Delete the now-duplicated `rollupFrameFlows`/`classifyFrames`/`layerById` block that previously ran after `rankFrames` (the `layer` field still reads from `layerById`, now built above). Leave the `FrameMapEntry` construction and the `layer: layerById.get(...)` line as-is.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/mcp-server/`
Expected: PASS — including the existing `frame-map.test.ts` and the negative-internals test.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green. (No caller passes the new opt; env unset → off → unchanged.)

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/frame-map.ts tests/mcp-server/frame-map-layer.test.ts
git commit -m "feat(frame-map): gate kind-weight ranking behind CORTEX_KIND_WEIGHT

Classify before ranking; thread kindWeight(layer, fallback) per record when
the flag is on. Default off → ranking byte-identical. fallback used only to
pick the weight, never serialized.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Observe — ambient set before vs after, corpus-wide

**Files:**
- Modify: `scripts/frame-extraction/eval-layers.ts`

- [ ] **Step 1: Add an ambient-diff to the per-repo eval**

Reuse the real production path: after `injectFrames`, the DB nodes carry frame_id, so `buildFrameMap(nodes, edges, {applyKindWeight})` ranks with the correct corpus + nameability both ways. No reconstructed ranking, no empty-corpus pitfall. Add the import at the top of the file:

```typescript
import { buildFrameMap } from "../../src/mcp-server/frame-map.js";
```

In `evalRepo`, after `nodes`/`edges` are loaded (the same ones passed to `rollupFrameFlows`), compute and diff the two ambient sets:

```typescript
    const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
    const on = buildFrameMap(nodes, edges, { applyKindWeight: true });
    const offAmbient = new Set(off.frames.filter((f) => f.ambient).map((f) => f.id));
    const onFrames = new Map(on.frames.map((f) => [f.id, f]));
    const onAmbient = new Set(on.frames.filter((f) => f.ambient).map((f) => f.id));
    const desc = (id: number) => { const f = onFrames.get(id)!; return `${f.name}(${f.layer})`; };
    const entered = [...onAmbient].filter((id) => !offAmbient.has(id)).map(desc);
    const left = [...offAmbient].filter((id) => !onAmbient.has(id)).map(desc);
    const ambientLayerDist = (ids: Set<number>) => {
      const d: Record<string, number> = {};
      for (const id of ids) { const l = onFrames.get(id)!.layer; d[l] = (d[l] ?? 0) + 1; }
      return d;
    };
    const ambientOff = ambientLayerDist(offAmbient), ambientOn = ambientLayerDist(onAmbient);
```

Add `entered`, `left`, `ambientOff`, `ambientOn` to the returned `RepoRow` (extend the interface), and log a one-line per-repo summary:
```typescript
    console.log(`[eval-layers]   ambient Δ: +[${entered.join(", ")}] -[${left.join(", ")}]  off=${JSON.stringify(ambientOff)} on=${JSON.stringify(ambientOn)}`);
```

- [ ] **Step 2: Smoke-test on one repo**

Run: `npx tsx scripts/frame-extraction/eval-layers.ts --only TanStack 2>&1 | grep -E "ambient|✓|✗"`
Expected: an `ambient Δ:` line; the `on` distribution should carry equal-or-more domain/interface than `off` for a repo with earned-domain frames.

- [ ] **Step 3: Run the full corpus**

Run: `npx tsx scripts/frame-extraction/eval-layers.ts > .tmp/eval-layers-kindweight.log 2>&1` (background).
Expected: per-repo `ambient Δ` lines; corpus-wide, frames that ENTER should be domain/interface/orchestration and frames that LEAVE should be substrate/ceremony. **Watch:** any fallback-domain or tiny frame entering ambient — that is the regression the 0.50 weight is meant to prevent.

- [ ] **Step 4: Commit the eval extension**

```bash
git add scripts/frame-extraction/eval-layers.ts
git commit -m "test(eval): ambient-set before/after diff for kind-weight observe

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Decision capture + HANDOFF

**Files:**
- Modify: `HANDOFF.md`

- [ ] **Step 1: Capture the decision**

```
search_decisions({ query: "kind weight ranking enable ambient", repo_path: "/Users/rka/Development/cortex" })
create_decision({
  repo_path: "/Users/rka/Development/cortex",
  title: "Kind-weight ranking enable slice (flag-gated, pure-ranker)",
  description: "score ×= kind_weight (per-layer, earned domain 1.00 / fallback 0.50 / … / ceremony 0.20), behind CORTEX_KIND_WEIGHT (default off, inert). Ranker stays pure — kind_weight threaded as a plain number; weights table + flag live at the call site (frame-map). Diversity deferred to step 3b.",
  rationale: "Lets the architectural layer steer the ambient set toward narrative value without changing the ranker's purity or the default behavior. Static multiplier shipped first so its ambient-set effect is attributable; the stateful diversity term is a separate increment.",
  alternatives: [
    { name: "Ship kind-weight + diversity together", reason_rejected: "Couples a static score change with stateful selection; ambient-set changes become unattributable during observe." },
    { name: "Read the flag / own the table inside the ranker", reason_rejected: "Breaks the ranker's purity and testability; the flag + taxonomy weights belong at the orchestration layer." }
  ],
  governs: ["src/frame-extraction/frame-ranker.ts", "src/frame-extraction/frame-kind.ts", "src/mcp-server/frame-map.ts"]
})
link_decision({ decision_id: "<new id>", target: "D-8vbv", relation: "RELATED_TO", repo_path: "/Users/rka/Development/cortex" })
```

- [ ] **Step 2: Update HANDOFF.md**

Mark step 3 in progress: kind-weight shipped behind the flag (default off); record the observe verdict from Task 3's corpus run (does the ambient set tilt correctly? any junk entering?); note the two follow-ups — **flip the default on** (after a clean observe verdict) and **step 3b diversity** (the `× diversity` term).

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md
git commit -m "docs(handoff): kind-weight enable slice shipped (flag-gated); observe verdict

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Gate 2 + merge (user-gated)

Do **not** run without explicit user approval to merge.

- [ ] **Step 1: Full suite** — `npm test` → expect all green.
- [ ] **Step 2: Gate 0 visual QA** — flag off: viewer ambient set pixel-identical to current. Flag on (`CORTEX_KIND_WEIGHT=1` in the dev server env, anthill project): ambient set visibly tilts toward domain/interface. Screenshots to `.playwright-mcp/`.
- [ ] **Step 3: Merge protocol** — `git checkout main && git merge --no-ff feature/component/kind-weight-ranking`, bump `package.json`/`plugin.json`/`.claude-plugin/marketplace.json` to 0.8.9, `CHANGELOG.md` entry + link, commit `chore(release): 0.8.9`, delete the branch.
- [ ] **Step 4: Push** — only when the user explicitly asks.

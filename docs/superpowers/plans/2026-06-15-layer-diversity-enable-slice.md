# Layer-Diversity Enable Slice (taxonomy step 3b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the viewer's ambient frame-set selection layer-aware — guarantee coverage of domain/interface/data, cap ceremony at one, and decay repeats of an already-represented layer — behind a flag, default off.

**Architecture:** A new pure module `frame-diversity.ts` runs a deterministic two-phase greedy selection (Phase 1: greedy fill with geometric repeat-decay + ceremony cap; Phase 2: bounded coverage repair). `frame-map.ts` gates it on `CORTEX_LAYER_DIVERSITY` and, when on, overrides which ranked frames are `ambient` (and laid out). The pure `frame-ranker.ts` is untouched — it stays layer-free, exactly as slice 3a left it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest, Node. The codebase is at `/Users/rka/Development/cortex-wt-layer-diversity` (a git worktree on branch `feature/component/frame-layer-diversity`).

**Design spec:** [docs/superpowers/specs/2026-06-15-layer-diversity-enable-slice-design.md](../specs/2026-06-15-layer-diversity-enable-slice-design.md)

**Background you need:**
- `FrameLayer` is `'interface' | 'orchestration' | 'domain' | 'data' | 'infrastructure' | 'ceremony'`, exported from `src/frame-extraction/frame-kind.ts`.
- `rankFrames(records, corpus)` (in `src/frame-extraction/frame-ranker.ts`) returns `RankedFrame[]`, each with `{ frame_id, frame_label, member_count, score, rank, ambient, components }`. `rank` is 1-based raw-score order; `ambient` is `rank <= ambientBudget(n)`. **Do not change this module.**
- `ambientBudget(n)` (same file): `n<=0 → 0`, else `max(4, min(10, ceil(n*0.7)))`.
- The determinism tie-break used everywhere is: sort by score descending, then by `String(frame_id).localeCompare(String(other_frame_id))` ascending.
- `buildFrameMap(nodes, edges, opts)` (in `src/mcp-server/frame-map.ts`) already computes `ranked` and a `layerById: Map<number, FrameLayer>`, then derives `const ambient = ranked.filter((r) => r.ambient)` and lays those out. Each serialized frame carries `ambient: r.ambient`.
- Vitest tests: `import { describe, it, expect } from "vitest";` and import source with `.js` specifiers (e.g. `"../../src/frame-extraction/frame-diversity.js"`).

---

## File Structure

- **Create** `src/frame-extraction/frame-diversity.ts` — the pure greedy selector + constants + `DiversityInput` type. One responsibility: given scored frames with layers + a budget, return the set of ambient frame_ids.
- **Create** `tests/frame-extraction/frame-diversity.test.ts` — unit tests for the selector.
- **Modify** `src/mcp-server/frame-map.ts` — add `applyDiversity` opt + `CORTEX_LAYER_DIVERSITY` env gate; override `ambient` membership when on.
- **Modify** `tests/mcp-server/frame-map-layer.test.ts` — add a `layer-diversity gating` describe block (inert-when-off + diversity-on behavior).
- **Modify** `scripts/frame-extraction/eval-layers.ts` — add a diversity off-vs-on ambient comparison to the corpus report (observe harness).

---

## Task 1: `frame-diversity.ts` — Phase 1 (greedy fill + decay + ceremony cap)

**Files:**
- Create: `src/frame-extraction/frame-diversity.ts`
- Test: `tests/frame-extraction/frame-diversity.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/frame-extraction/frame-diversity.test.ts`:

```ts
// tests/frame-extraction/frame-diversity.test.ts
import { describe, it, expect } from "vitest";
import {
  selectAmbientByDiversity,
  DIVERSITY_DECAY,
  type DiversityInput,
} from "../../src/frame-extraction/frame-diversity.js";

const f = (frame_id: number, score: number, layer: DiversityInput["layer"]): DiversityInput =>
  ({ frame_id, score, layer });

describe("selectAmbientByDiversity — Phase 1 (fill, decay, ceremony cap)", () => {
  it("returns all ids when budget >= frame count", () => {
    const got = selectAmbientByDiversity([f(1, 5, "domain"), f(2, 3, "data")], 5);
    expect(got).toEqual(new Set([1, 2]));
  });

  it("returns empty for budget 0 or no frames", () => {
    expect(selectAmbientByDiversity([f(1, 5, "domain")], 0)).toEqual(new Set());
    expect(selectAmbientByDiversity([], 4)).toEqual(new Set());
  });

  it("caps ceremony at one when non-ceremony candidates exist", () => {
    // 3 ceremony frames score highest, but only 1 may be ambient; the
    // interface + data frames take the other two of a 3-slot budget.
    const frames = [
      f(1, 10, "ceremony"), f(2, 9, "ceremony"), f(3, 8, "ceremony"),
      f(4, 5, "interface"), f(5, 4, "data"),
    ];
    const got = selectAmbientByDiversity(frames, 3);
    const ceremonyCount = [...got].filter((id) => frames.find((x) => x.frame_id === id)!.layer === "ceremony").length;
    expect(ceremonyCount).toBe(1);
    expect(got).toEqual(new Set([1, 4, 5]));
  });

  it("relaxes the ceremony cap only when nothing else remains", () => {
    // budget 3, only ceremony frames exist → must fill to budget anyway.
    const frames = [f(1, 10, "ceremony"), f(2, 9, "ceremony"), f(3, 8, "ceremony")];
    const got = selectAmbientByDiversity(frames, 3);
    expect(got).toEqual(new Set([1, 2, 3]));
  });

  it("geometric decay evicts a 3rd same-layer frame for an unrepresented layer", () => {
    // Four interface frames + one data frame, budget 3.
    // Without decay: top-3 would be the three highest interface (10,9,8).
    // With DECAY=0.6: 1st interface ×1=10, 2nd ×0.6=5.4, data ×1=4,
    //   3rd interface ×0.36=2.88 → data (4) beats the 3rd interface (2.88).
    expect(DIVERSITY_DECAY).toBe(0.6);
    const frames = [
      f(1, 10, "interface"), f(2, 9, "interface"), f(3, 8, "interface"),
      f(4, 7, "interface"), f(5, 4, "data"),
    ];
    const got = selectAmbientByDiversity(frames, 3);
    expect(got).toEqual(new Set([1, 2, 5]));
  });

  it("first pick is always the top raw score (decay inert at count 0)", () => {
    const frames = [f(1, 3, "data"), f(2, 10, "interface"), f(3, 5, "domain")];
    const got = selectAmbientByDiversity(frames, 1);
    expect(got).toEqual(new Set([2]));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/rka/Development/cortex-wt-layer-diversity && npx vitest run tests/frame-extraction/frame-diversity.test.ts`
Expected: FAIL — `Failed to resolve import ".../frame-diversity.js"` (module doesn't exist yet).

- [ ] **Step 3: Write the module with Phase 1 only**

Create `src/frame-extraction/frame-diversity.ts`:

```ts
// src/frame-extraction/frame-diversity.ts
/**
 * Deterministic, stateful ambient-set selector (taxonomy step 3b — the
 * `× diversity` term). Given frames already scored by the ranker (with their
 * layer attached) and an ambient budget, returns the set of frame_ids that
 * should be ambient.
 *
 * Two phases:
 *   1. greedy fill with geometric repeat-decay + ceremony cap
 *   2. bounded coverage repair (added in a later task)
 *
 * Pure: same input + budget → same set. All tie-breaks are on the stringified
 * frame_id, matching frame-ranker.ts (spec §8.6). No I/O.
 */
import type { FrameLayer } from "./frame-kind.js";

/** One frame's input to diversity selection. */
export interface DiversityInput {
  frame_id: number;
  /** Raw ranker score (nameability × structural × kind_weight). */
  score: number;
  layer: FrameLayer;
}

/** Per-repeat multiplier: effective = score × DECAY ^ (same-layer count already selected). */
export const DIVERSITY_DECAY = 0.6;
/** At most this many `ceremony` frames may be ambient (relaxed only to fill budget). */
export const CEREMONY_CAP = 1;
/** Phase 2: promote a coverage candidate only if its score ≥ FLOOR × displaced score. */
export const PROMOTION_FLOOR = 0.5;
/** Layers whose presence the ambient set guarantees (when the repo has them).
 *  Also the canonical coverage-repair order. */
export const REQUIRED_LAYERS: readonly FrameLayer[] = ["domain", "interface", "data"];

/** Ascending tie-break on stringified frame_id (matches the ranker). */
function byIdAsc(a: DiversityInput, b: DiversityInput): number {
  return String(a.frame_id).localeCompare(String(b.frame_id));
}

export function selectAmbientByDiversity(
  frames: readonly DiversityInput[],
  budget: number,
): Set<number> {
  if (budget <= 0 || frames.length === 0) return new Set();
  if (budget >= frames.length) return new Set(frames.map((x) => x.frame_id));

  // Deterministic working order: raw score desc, then id asc.
  const byScore = [...frames].sort((a, b) => b.score - a.score || byIdAsc(a, b));

  const selected: DiversityInput[] = [];
  const counts = new Map<FrameLayer, number>();
  const used = new Set<number>();

  // Phase 1 — greedy fill with decay + ceremony cap.
  while (selected.length < budget) {
    let best: DiversityInput | null = null;
    let bestEff = -Infinity;
    for (const cand of byScore) {
      if (used.has(cand.frame_id)) continue;
      if (cand.layer === "ceremony" && (counts.get("ceremony") ?? 0) >= CEREMONY_CAP) continue;
      const k = counts.get(cand.layer) ?? 0;
      const eff = cand.score * DIVERSITY_DECAY ** k;
      if (eff > bestEff || (best !== null && eff === bestEff && byIdAsc(cand, best) < 0)) {
        bestEff = eff;
        best = cand;
      }
    }
    // Only capped ceremony candidates remain → relax the cap to fill the budget.
    if (best === null) best = byScore.find((x) => !used.has(x.frame_id)) ?? null;
    if (best === null) break;
    selected.push(best);
    used.add(best.frame_id);
    counts.set(best.layer, (counts.get(best.layer) ?? 0) + 1);
  }

  return new Set(selected.map((x) => x.frame_id));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/frame-diversity.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-diversity.ts tests/frame-extraction/frame-diversity.test.ts
git commit -m "feat(frames): greedy ambient selector — Phase 1 (decay + ceremony cap)"
```

---

## Task 2: `frame-diversity.ts` — Phase 2 (bounded coverage repair)

**Files:**
- Modify: `src/frame-extraction/frame-diversity.ts` (add Phase 2 after the Phase 1 loop)
- Test: `tests/frame-extraction/frame-diversity.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing tests**

Append to `tests/frame-extraction/frame-diversity.test.ts`:

```ts
describe("selectAmbientByDiversity — Phase 2 (bounded coverage repair)", () => {
  it("promotes a below-cut data frame when it clears the floor, displacing the weakest", () => {
    // budget 2. Phase 1: interface#1 ×1=10 (slot 1); then interface#2 ×0.6=5.4
    //   beats data ×1=5 → interface#2 takes slot 2. data is left OUT despite the
    //   repo having it — so Phase 2 must repair coverage.
    // Phase 2: data candidate (5). Both interface frames are displaceable
    //   (interface has 2 reps); weakest = interface#2 (9). floor: 5 >= 0.5*9=4.5
    //   → swap data in for interface#2.
    const frames = [
      { frame_id: 1, score: 10, layer: "interface" as const },
      { frame_id: 2, score: 9, layer: "interface" as const },
      { frame_id: 3, score: 5, layer: "data" as const },
    ];
    const got = selectAmbientByDiversity(frames, 2);
    expect(got).toEqual(new Set([1, 3]));
  });

  it("refuses promotion when the candidate is below the floor (coverage not guaranteed)", () => {
    // data(2) vs weakest displaceable interface(6): 2 >= 0.5*6=3 is FALSE → no swap.
    const frames = [
      { frame_id: 1, score: 10, layer: "interface" as const },
      { frame_id: 2, score: 6, layer: "interface" as const },
      { frame_id: 3, score: 2, layer: "data" as const },
    ];
    const got = selectAmbientByDiversity(frames, 2);
    expect(got).toEqual(new Set([1, 2])); // data NOT injected
  });

  it("skips a required layer the repo does not have", () => {
    // No data frame anywhere → coverage skips data, no error.
    const frames = [
      { frame_id: 1, score: 10, layer: "interface" as const },
      { frame_id: 2, score: 6, layer: "interface" as const },
      { frame_id: 3, score: 5, layer: "domain" as const },
    ];
    const got = selectAmbientByDiversity(frames, 2);
    // Phase 1 (budget 2): interface(10), then interface ×0.6=3.6 vs domain ×1=5
    //   → domain(5) wins slot 2. Both interface+domain present; no repair needed.
    expect(got).toEqual(new Set([1, 3]));
  });

  it("never displaces the sole representative of another required layer", () => {
    // budget 2, frames span domain, interface, data — all required, all wanted.
    // Phase 1 fills 2 slots (domain 10, interface 8). data(7) is missing but the
    // only displaceable candidates (domain, interface) are each a sole required
    // rep → no safe displacement → data stays out (bounded, not forced).
    const frames = [
      { frame_id: 1, score: 10, layer: "domain" as const },
      { frame_id: 2, score: 8, layer: "interface" as const },
      { frame_id: 3, score: 7, layer: "data" as const },
    ];
    const got = selectAmbientByDiversity(frames, 2);
    expect(got).toEqual(new Set([1, 2]));
  });

  it("displaces an over-represented required layer to make room for coverage", () => {
    // budget 3. Phase 1: domain(10), domain ×0.6=4.8 ... let's force a 2nd domain
    // into the set then require data coverage by displacing the weaker domain.
    const frames = [
      { frame_id: 1, score: 10, layer: "domain" as const },
      { frame_id: 2, score: 9, layer: "domain" as const },
      { frame_id: 3, score: 8, layer: "interface" as const },
      { frame_id: 4, score: 5, layer: "data" as const },
    ];
    // Phase 1 (budget 3): domain(10) ×1; then domain#2 ×0.6=5.4 vs interface(8) ×1=8
    //   → interface(8); then domain#2 ×0.6=5.4 vs data(5) ×1=5 → domain#2(5.4).
    //   selected = {1(domain), 3(interface), 2(domain)}. data missing.
    // Phase 2: data candidate (5). Displaceable required reps with count≥2: domain
    //   has 2 reps → weakest domain = id2(score 9). 5 >= 0.5*9=4.5 → swap.
    const got = selectAmbientByDiversity(frames, 3);
    expect(got).toEqual(new Set([1, 3, 4]));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/frame-extraction/frame-diversity.test.ts`
Expected: FAIL — the new Phase 2 tests fail (coverage repair not implemented; e.g. first test gets `{1,2}` instead of `{1,3}`).

- [ ] **Step 3: Implement Phase 2**

In `src/frame-extraction/frame-diversity.ts`, replace the final `return new Set(selected.map((x) => x.frame_id));` line with the Phase 2 block followed by the return:

```ts
  // Phase 2 — bounded coverage repair. For each required layer the repo HAS but
  // Phase 1 left out, promote its best omitted candidate by displacing the
  // weakest safely-displaceable selected frame — only if it clears the floor.
  const present = new Set(frames.map((x) => x.layer));
  for (const layer of REQUIRED_LAYERS) {
    if (!present.has(layer)) continue; // repo doesn't have this layer
    if (selected.some((s) => s.layer === layer)) continue; // already covered

    const candidate = byScore.find((x) => x.layer === layer && !used.has(x.frame_id));
    if (!candidate) continue;

    // Displaceable = a selected frame whose removal won't drop another required
    // layer to zero (non-required layer, or a required layer with ≥2 reps).
    const displaceable = selected
      .filter((s) => {
        if (!REQUIRED_LAYERS.includes(s.layer)) return true;
        return selected.filter((x) => x.layer === s.layer).length >= 2;
      })
      .sort((a, b) => a.score - b.score || byIdAsc(a, b));
    const weakest = displaceable[0];
    if (!weakest) continue; // nothing safe to displace
    if (candidate.score < PROMOTION_FLOOR * weakest.score) continue; // below floor — refuse

    const idx = selected.findIndex((s) => s.frame_id === weakest.frame_id);
    selected.splice(idx, 1);
    used.delete(weakest.frame_id);
    counts.set(weakest.layer, (counts.get(weakest.layer) ?? 1) - 1);
    selected.push(candidate);
    used.add(candidate.frame_id);
    counts.set(candidate.layer, (counts.get(candidate.layer) ?? 0) + 1);
  }

  return new Set(selected.map((x) => x.frame_id));
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/frame-extraction/frame-diversity.test.ts`
Expected: PASS (all Phase 1 + Phase 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-diversity.ts tests/frame-extraction/frame-diversity.test.ts
git commit -m "feat(frames): greedy ambient selector — Phase 2 (bounded coverage repair)"
```

---

## Task 3: Determinism guard

**Files:**
- Test: `tests/frame-extraction/frame-diversity.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `tests/frame-extraction/frame-diversity.test.ts`:

```ts
describe("selectAmbientByDiversity — determinism", () => {
  it("returns the same set regardless of input order", () => {
    const frames: DiversityInput[] = [
      f(1, 10, "interface"), f(2, 9, "interface"), f(3, 8, "ceremony"),
      f(4, 7, "data"), f(5, 6, "domain"), f(6, 5, "ceremony"), f(7, 4, "infrastructure"),
    ];
    const shuffled = [frames[3], frames[6], frames[0], frames[5], frames[2], frames[4], frames[1]];
    const a = selectAmbientByDiversity(frames, 5);
    const b = selectAmbientByDiversity(shuffled, 5);
    expect([...a].sort()).toEqual([...b].sort());
  });

  it("breaks score ties on stringified frame_id (lower id wins the slot)", () => {
    // budget 1, two equal-score interface frames → id 2 < id 10 → pick 2.
    const got = selectAmbientByDiversity([f(10, 5, "interface"), f(2, 5, "interface")], 1);
    expect(got).toEqual(new Set([2]));
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (or fails meaningfully)**

Run: `npx vitest run tests/frame-extraction/frame-diversity.test.ts`
Expected: PASS — the selector is already deterministic by construction; this test locks it in. If it FAILS, the tie-break logic regressed — fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add tests/frame-extraction/frame-diversity.test.ts
git commit -m "test(frames): determinism guard for diversity selector"
```

---

## Task 4: Wire the selector into `frame-map.ts` behind the flag

**Files:**
- Modify: `src/mcp-server/frame-map.ts`
- Test: `tests/mcp-server/frame-map-layer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mcp-server/frame-map-layer.test.ts` (it already imports `buildFrameMap`, `NodeRow`, `EdgeRow` and defines `fileNode`/`symNode`/`edge` helpers — reuse them):

```ts
describe("layer-diversity gating", () => {
  it("default OFF: no opts (env unset) matches explicit applyDiversity:false", () => {
    const prev = process.env.CORTEX_LAYER_DIVERSITY;
    delete process.env.CORTEX_LAYER_DIVERSITY;
    try {
      const off = buildFrameMap(nodes, edges, { applyDiversity: false });
      const dflt = buildFrameMap(nodes, edges); // env unset → default OFF
      expect(dflt.frames.map((f) => [f.id, f.ambient])).toEqual(off.frames.map((f) => [f.id, f.ambient]));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_LAYER_DIVERSITY;
      else process.env.CORTEX_LAYER_DIVERSITY = prev;
    }
  });

  it("CORTEX_LAYER_DIVERSITY=1 matches explicit applyDiversity:true", () => {
    const prev = process.env.CORTEX_LAYER_DIVERSITY;
    process.env.CORTEX_LAYER_DIVERSITY = "1";
    try {
      const envOn = buildFrameMap(nodes, edges);
      const on = buildFrameMap(nodes, edges, { applyDiversity: true });
      expect(envOn.frames.map((f) => [f.id, f.ambient])).toEqual(on.frames.map((f) => [f.id, f.ambient]));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_LAYER_DIVERSITY;
      else process.env.CORTEX_LAYER_DIVERSITY = prev;
    }
  });

  it("flag ON caps ceremony in the ambient set end-to-end (OFF does not)", () => {
    // NOTE: kind-weight is OFF here (applyKindWeight:false) on BOTH sides — with
    // kind-weight on, ceremony is already demoted by its 0.2 multiplier and the
    // cap rarely binds. Disabling it isolates the diversity ceremony-cap as the
    // sole intervention so the test is robust to scoring details.
    //
    // 4 ceremony frames (scripts/, high member counts) outscore 8 interface
    // frames (cli/, fewer members) on raw nameability×structural. Budget for 12
    // frames = ceil(12·0.7)=9. OFF: the top-9 includes all 4 ceremony. ON: the
    // cap holds — exactly 1 ceremony, and the 8 interface fill the rest (8+1=9,
    // so the cap never relaxes).
    const big: NodeRow[] = [];
    for (let fr = 0; fr < 4; fr++) {
      const n = 12 - fr; // 12,11,10,9 members → high structural weight
      for (let m = 0; m < n; m++) big.push(fileNode(`c${fr}_${m}`, `src/scripts/f${fr}/m${m}.ts`, fr, `scripts${fr}`));
    }
    for (let fr = 4; fr < 12; fr++) {
      for (let m = 0; m < 5; m++) big.push(fileNode(`u${fr}_${m}`, `src/cli/f${fr}/m${m}.ts`, fr, `cli${fr}`));
    }
    const opts = { applyKindWeight: false as const };
    const off = buildFrameMap(big, [], { ...opts, applyDiversity: false });
    const on = buildFrameMap(big, [], { ...opts, applyDiversity: true });
    const ceremonyAmbient = (m: ReturnType<typeof buildFrameMap>) =>
      m.frames.filter((f) => f.ambient && f.layer === "ceremony").length;
    // Sanity: the fixture really did classify the scripts frames as ceremony.
    expect(off.frames.some((f) => f.layer === "ceremony")).toBe(true);
    expect(ceremonyAmbient(off)).toBeGreaterThan(1);
    expect(ceremonyAmbient(on)).toBeLessThanOrEqual(1);
    expect(on.frames.filter((f) => f.ambient).length).toBeLessThanOrEqual(9);
  });

  it("flag ON is deterministic across repeated builds", () => {
    const a = buildFrameMap(nodes, edges, { applyDiversity: true });
    const b = buildFrameMap(nodes, edges, { applyDiversity: true });
    expect(a.frames.map((f) => [f.id, f.ambient])).toEqual(b.frames.map((f) => [f.id, f.ambient]));
  });

  it("flag ON still serializes no classifier internals", () => {
    const json = JSON.stringify(buildFrameMap(nodes, edges, { applyDiversity: true }));
    expect(json).not.toContain("fallback");
    expect(json).not.toContain("confidence");
    expect(json).not.toContain("contributions");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/mcp-server/frame-map-layer.test.ts`
Expected: FAIL — `buildFrameMap` does not yet accept `applyDiversity` (TypeScript error on the opt), and the ceremony-cap test fails because nothing caps ceremony yet.

- [ ] **Step 3: Read the current frame-map wiring**

Open `src/mcp-server/frame-map.ts`. Confirm the imports near the top include the ranker import line:

```ts
import { rankFrames, type FrameRecord } from "../frame-extraction/frame-ranker.js";
```

and that `buildFrameMap` computes `ranked`, then `const ambient = ranked.filter((r) => r.ambient);`, lays out `ambient`, and maps each entry with `ambient: r.ambient`.

- [ ] **Step 4: Edit the imports**

Change the ranker import to also bring in `ambientBudget`, and add the diversity import:

```ts
import { rankFrames, ambientBudget, type FrameRecord } from "../frame-extraction/frame-ranker.js";
import { selectAmbientByDiversity } from "../frame-extraction/frame-diversity.js";
```

(`classifyFramesInternal`, `kindWeight`, `FrameLayer` are already imported from `frame-kind.js` — leave that line as-is.)

- [ ] **Step 5: Edit the `buildFrameMap` signature**

Change:

```ts
  opts: { applyKindWeight?: boolean } = {},
```

to:

```ts
  opts: { applyKindWeight?: boolean; applyDiversity?: boolean } = {},
```

- [ ] **Step 6: Compute the ambient set with the gate**

Find:

```ts
  const ambient = ranked.filter((r) => r.ambient);
```

Replace it with:

```ts
  // Layer-diversity ambient selection (taxonomy step 3b). Default OFF — when off
  // the ambient flag is exactly what the ranker set, so output is byte-identical
  // to pre-slice. When on, a greedy layer-aware selection overrides membership.
  const applyDiversity = opts.applyDiversity ?? process.env.CORTEX_LAYER_DIVERSITY === "1";
  const ambientIds = applyDiversity
    ? selectAmbientByDiversity(
        ranked.map((r) => ({
          frame_id: r.frame_id,
          score: r.score,
          layer: layerById.get(r.frame_id) ?? "domain",
        })),
        ambientBudget(ranked.length),
      )
    : new Set(ranked.filter((r) => r.ambient).map((r) => r.frame_id));

  const ambient = ranked.filter((r) => ambientIds.has(r.frame_id));
```

- [ ] **Step 7: Use the selected set for the serialized `ambient` flag**

Find the per-entry mapping line:

```ts
      ambient: r.ambient,
```

Replace with:

```ts
      ambient: ambientIds.has(r.frame_id),
```

(Leave `rank: r.rank` and `score: r.score` unchanged — `rank` stays raw-score order, the honest explainability signal.)

- [ ] **Step 8: Run the layer-map tests**

Run: `npx vitest run tests/mcp-server/frame-map-layer.test.ts`
Expected: PASS — all existing kind-weight tests plus the five new diversity tests.

- [ ] **Step 9: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS — full suite green (the pre-existing count was 1131/1131; the new tests add to it). If any pre-existing frame-map test fails, it is because it asserted `ambient` under the default — verify the default is OFF and the flag env is unset in that test.

- [ ] **Step 10: Commit**

```bash
git add src/mcp-server/frame-map.ts tests/mcp-server/frame-map-layer.test.ts
git commit -m "feat(frames): gate layer-diversity ambient selection on CORTEX_LAYER_DIVERSITY"
```

---

## Task 5: Observe — diversity off-vs-on in the corpus eval

**Files:**
- Modify: `scripts/frame-extraction/eval-layers.ts`

The harness already reports a kind-weight off-vs-on ambient delta. Add a parallel **diversity** off-vs-on comparison (both with kind-weight at its default ON), so the observe run shows what diversity changes on top of the shipped baseline.

- [ ] **Step 1: Extend the `RepoRow` interface**

Find (around line 53):

```ts
  entered?: string[]; left?: string[]; ambientOff?: Record<string, number>; ambientOn?: Record<string, number>;
```

Add a second line right after it:

```ts
  divEntered?: string[]; divLeft?: string[]; divAmbientOff?: Record<string, number>; divAmbientOn?: Record<string, number>;
```

- [ ] **Step 2: Compute the diversity comparison in `evalRepo`**

Find (around line 126):

```ts
    const ambientOff = ambientLayerDist(offAmbient), ambientOn = ambientLayerDist(onAmbient);
```

Add immediately after it:

```ts
    // Diversity off-vs-on (kind-weight at its default ON in both — this isolates
    // the `× diversity` effect on top of the shipped baseline).
    const divOff = buildFrameMap(nodes, edges, { applyDiversity: false });
    const divOn = buildFrameMap(nodes, edges, { applyDiversity: true });
    const divOffAmbient = new Set(divOff.frames.filter((f) => f.ambient).map((f) => f.id));
    const divOnFrames = new Map(divOn.frames.map((f) => [f.id, f]));
    const divOnAmbient = new Set(divOn.frames.filter((f) => f.ambient).map((f) => f.id));
    const divDesc = (id: number) => { const f = divOnFrames.get(id)!; return `${f.name}(${f.layer})`; };
    const divEntered = [...divOnAmbient].filter((id) => !divOffAmbient.has(id)).map(divDesc);
    const divLeft = [...divOffAmbient].filter((id) => !divOnAmbient.has(id)).map(divDesc);
    const divDist = (ids: Set<number>) => {
      const d: Record<string, number> = {};
      for (const id of ids) { const l = divOnFrames.get(id)!.layer; d[l] = (d[l] ?? 0) + 1; }
      return d;
    };
    const divAmbientOff = divDist(divOffAmbient), divAmbientOn = divDist(divOnAmbient);
```

- [ ] **Step 3: Add the new fields to the returned row**

Find the return (around line 128):

```ts
    return { ...base, ok: true, project, frames: inputs.length, dist, earnedDomain, fallbackDomain, midbandFrames, entered, left, ambientOff, ambientOn };
```

Replace with:

```ts
    return { ...base, ok: true, project, frames: inputs.length, dist, earnedDomain, fallbackDomain, midbandFrames, entered, left, ambientOff, ambientOn, divEntered, divLeft, divAmbientOff, divAmbientOn };
```

- [ ] **Step 4: Print the diversity delta**

Find the per-repo logging (around line 154):

```ts
    console.log(`[eval-layers]   ambient Δ: +[${(row.entered ?? []).join(", ")}] -[${(row.left ?? []).join(", ")}]  off=${JSON.stringify(row.ambientOff ?? {})} on=${JSON.stringify(row.ambientOn ?? {})}`);
```

Add right after it:

```ts
    console.log(`[eval-layers]   diversity Δ: +[${(row.divEntered ?? []).join(", ")}] -[${(row.divLeft ?? []).join(", ")}]  off=${JSON.stringify(row.divAmbientOff ?? {})} on=${JSON.stringify(row.divAmbientOn ?? {})}`);
```

- [ ] **Step 5: Type-check the script compiles**

Run: `npx tsc --noEmit`
Expected: no errors (the script is included in the project's typecheck). If `tsc --noEmit` is not the project's check, run `npm run build` and confirm exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/eval-layers.ts
git commit -m "feat(eval): report layer-diversity off-vs-on ambient delta in corpus eval"
```

- [ ] **Step 7: (Optional, requires Python venv) Run the observe pass and record the verdict**

Run (if a venv exists — `cortex setup frames` provisions it): `npx tsx scripts/frame-extraction/eval-layers.ts`
Read the `diversity Δ` lines per repo. Capture into the spec's Observe section / HANDOFF: which required layers became covered, ceremony stayed ≤1, and crucially that **no fallback-domain or tiny frame was promoted on coverage alone** (the regression to watch). If the venv is unavailable in this environment, note that the observe run is **deferred to a hand-run before the default flip** — do not claim it ran.

---

## Task 6: Gate 0 — visual QA

**Files:** none (verification only). This is required because the ambient set drives what the viewer renders.

- [ ] **Step 1: Start the dev server**

Run (background): `npm run dev`
Wait for it to come up; the viewer is at `http://localhost:3334/viewer`.

- [ ] **Step 2: Baseline — flag OFF**

With `CORTEX_LAYER_DIVERSITY` unset (default), load the viewer for the cortex project. Capture a screenshot to `.tmp/diversity-off.png` (or `.playwright-mcp/`). Confirm the ambient frame set + console are clean. This must match the current viewer (diversity is off by default).

- [ ] **Step 3: Flag ON**

Restart the dev server with `CORTEX_LAYER_DIVERSITY=1 npm run dev`. Reload the viewer (try cortex and, if available, a multi-layer repo like anthill via the project switcher). Capture `.tmp/diversity-on.png`.

- [ ] **Step 4: Verify and report**

Confirm: ambient set visibly spans layers (domain/interface/data present where the repo has them), at most one ceremony box is ambient, no runtime errors in the console, layout renders without overlap pathology. Report findings:
- Runtime errors / broken rendering → block, fix before review.
- Ambient set spans layers as designed → pass.
If Playwright/display is unavailable, state so explicitly and flag the slice as **needing user-driven hand-verify before merge** (per the workflow rules' honest-reporting clause). Do not claim QA that wasn't run.

- [ ] **Step 5: Stop the dev server.**

---

## Task 7: Decision capture

**Files:** none (uses the Cortex MCP decision tools against `repo_path: /Users/rka/Development/cortex-wt-layer-diversity`).

- [ ] **Step 1: Check for an existing/duplicate decision**

Call `search_decisions({ repo_path: "/Users/rka/Development/cortex-wt-layer-diversity", query: "layer diversity ambient selection greedy coverage" })`. Confirm none already covers this.

- [ ] **Step 2: Create the decision**

Call `create_decision` with:
- **title:** "Layer-diversity ambient selection (taxonomy step 3b)"
- **description:** Greedy two-phase ambient-set selector in a separate pure module `frame-diversity.ts` (keeps `frame-ranker.ts` layer-free). Phase 1: greedy fill with geometric repeat-decay (`× DECAY^k`, DECAY=0.6) + ceremony cap (1, relaxed only to fill budget). Phase 2: bounded coverage repair — promote a present-but-uncovered required layer (domain/interface/data) by displacing the weakest safely-displaceable frame, only if the candidate clears `PROMOTION_FLOOR=0.5 × displaced`. Gated on `CORTEX_LAYER_DIVERSITY`, default off (inert: ambient flag = ranker output when off). `rank` stays raw-score order; `ambient` reflects the selection.
- **rationale:** Diversity is stateful selection (depends on what's already chosen), so it cannot be a static score multiplier and does not belong in the pure ranker — its own module keeps both pure and independently testable. Bounded promotion (not a hard guarantee) respects the D-qn7z junk-leapfrogging trap: coverage is a goal, not an absolute. Geometric decay is the natural reading of the `× diversity` term and tunes via one constant. Default-off + observe matches the arc's walk-before-run discipline (mirrors slice 3a / D-g4qb).
- **alternatives:** (a) fold diversity into `rankFrames` by threading `layer` — rejected, pollutes the pure ranker with stateful logic; (b) hard coverage guarantee (always inject a missing layer's best frame) — rejected, can promote junk to fill a slot; (c) flat or tiebreak-only repeat penalty — rejected in favor of geometric for stronger, single-constant spread; (d) ship on by default — rejected, breaks attribution during observe.
- **governs:** `["src/frame-extraction/frame-diversity.ts", "src/mcp-server/frame-map.ts", "docs/superpowers/specs/2026-06-15-layer-diversity-enable-slice-design.md"]`

- [ ] **Step 3: Link relationships**

`link_decision` the new decision related to `D-g4qb` (kind-weight enable) and `D-qn7z` (junk-leapfrogging trap). Use `link_decision({ repo_path, decision_id, target, relation })` with the appropriate relation (e.g. `RELATES_TO`).

- [ ] **Step 4: Refresh the index so the decision links resolve**

Run: `detect_changes` then incremental `index_repository` against `repo_path: /Users/rka/Development/cortex-wt-layer-diversity` (per CLAUDE.md's after-commit guidance).

---

## Done criteria

- `frame-diversity.ts` is pure, deterministic, and fully unit-tested (Phases 1+2, edge cases, determinism).
- `buildFrameMap` overrides ambient membership only when `CORTEX_LAYER_DIVERSITY=1` (or `applyDiversity:true`); default-off output is byte-identical to pre-slice (golden-guarded).
- `npx vitest run` is fully green.
- The eval harness reports a diversity off-vs-on delta; the observe verdict is captured (or explicitly deferred to a hand-run if no venv).
- Gate 0 visual QA passed (or flagged for hand-verify).
- The decision is captured and linked.
- **Not in this slice:** flipping the default on (a follow-up after the observe verdict), the layout slice, version bump/merge (handled at merge time per the workflow rules).

---

## Self-review notes

- **Spec coverage:** Phase 1 (decay + ceremony cap) → Task 1; Phase 2 (bounded coverage repair) → Task 2; determinism → Task 3; flag gate + inert guarantee + ambient override → Task 4. Note: coverage/decay *algorithm* correctness is proven by the pure unit tests (Tasks 1–3) where scores are explicit; the Task 4 integration tests assert only the robust wiring contract (gate equivalence, the ceremony cap exercised with kind-weight disabled, determinism, no internals) — they deliberately avoid asserting membership outcomes that depend on label nameability. Observe harness → Task 5; Gate 0 → Task 6; decision capture → Task 7. All spec sections map to a task.
- **Type consistency:** `DiversityInput { frame_id, score, layer }`, `selectAmbientByDiversity(frames, budget): Set<number>`, constants `DIVERSITY_DECAY`/`CEREMONY_CAP`/`PROMOTION_FLOOR`/`REQUIRED_LAYERS`, and the `opts.applyDiversity` / `CORTEX_LAYER_DIVERSITY` names are used identically across all tasks and the spec.
- **No placeholders:** every code step shows complete code; every run step shows the command + expected result.

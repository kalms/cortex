# Layer-Adjacency Layout Force — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vertical stratification force to the frame layout so ambient frames settle into a surface→substrate slice (sources high, sinks low), driven by each frame's measured flow ratio — behind a flag, default off.

**Architecture:** A new `forceY(yTarget(sink))` is added to the pure d3-force layout in `frame-layout.ts`, alongside the existing pair-link clustering / charge / collide. The pure layout module stays layer-agnostic — it receives a plain `sink: number` per frame; `frame-map.ts` reads the env flag and computes each frame's effective sink (measured from `FrameFlowStats`, or a per-layer nominal for flowless frames). When no frame carries `sink` (flag off), the layout takes the exact current `forceCenter` path → positions byte-identical to today.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), d3-force, Vitest, Node. Worktree: `/Users/rka/Development/cortex-wt-layer-layout` on branch `feature/layout/layer-adjacency-force`.

**Design spec:** [docs/superpowers/specs/2026-06-16-layer-adjacency-layout-force-design.md](../specs/2026-06-16-layer-adjacency-layout-force-design.md)

**Background you need:**
- `src/mcp-server/frame-layout.ts` exports `layoutFrames(frames: LayoutInputFrame[], pairs: FramePairWeight[]): PositionedFrame[]`. It's a pure deterministic d3-force sim: mulberry32 PRNG seeded from a SHA-256 of the sorted frames drives the scatter + d3's jiggle; 300 fixed ticks with mass-inertia damping; a collision-relaxation AABB tail; integer-pixel quantize; `STAGE_W=1000`, `STAGE_H=800`. **Determinism is sacred** — same input → byte-identical output.
- Current force set (registration order matters — d3 applies forces in insertion order each tick): `charge` (forceManyBody -320), `center` (forceCenter at stage center), `link` (forceLink over `pairs`), `collide` (forceCollide).
- `LayoutInputFrame = { frame_id, frame_label, member_count }`; `PositionedFrame = { id, name, count, x, y, w, h }` (integer px).
- `src/mcp-server/frame-map.ts::buildFrameMap(nodes, edges, opts)` already computes `const { stats } = rollupFrameFlows(nodes, edges)` → `statsById` (each `{frame_id, fanIn, fanOut}`), and `layerById` (frame_id → FrameLayer). It calls `layoutFrames(ambient.map(...), pairs)` at the section shown in Task 2.
- `FrameLayer = 'interface'|'orchestration'|'domain'|'data'|'infrastructure'|'ceremony'`.
- Vitest: `import { describe, it, expect } from "vitest"`; import source with `.js` specifiers.

---

## File Structure

- **Modify** `src/mcp-server/frame-layout.ts` — add optional `sink` to `LayoutInputFrame`, the `yTargetFor` helper + constants, the `forceX`/`forceY` imports, and the stratify branch in the sim. The pure force module; one new responsibility (vertical axis).
- **Modify** `tests/mcp-server/frame-layout.test.ts` — inert golden + on-path (vertical-ordering, determinism, bounds) tests.
- **Modify** `src/mcp-server/frame-map.ts` — `applyLayout` opt + `CORTEX_LAYER_LAYOUT` env gate; `NOMINAL_SINK` table + `effectiveSink`; attach `sink` to the `layoutFrames` input when on.
- **Modify** `tests/mcp-server/frame-map-layer.test.ts` — layout gating + stratification-through-the-pipeline tests.
- **Modify** `scripts/frame-extraction/eval-layers.ts` — corpus layout off-vs-on Spearman(y, sink) report.

---

## Task 1: Vertical stratification force in `frame-layout.ts`

**Files:**
- Modify: `src/mcp-server/frame-layout.ts`
- Test: `tests/mcp-server/frame-layout.test.ts`

- [ ] **Step 1: Capture the inert golden from the CURRENT (unmodified) layout**

Before editing any source, run the current `layoutFrames` on the standard fixture and capture its exact output — this is the byte-identical baseline the flag-off path must reproduce.

Run:
```bash
cd /Users/rka/Development/cortex-wt-layer-layout && npx tsx -e "import {layoutFrames} from './src/mcp-server/frame-layout.js'; const F=[{frame_id:0,frame_label:'checkout',member_count:30},{frame_id:1,frame_label:'viewer',member_count:10},{frame_id:2,frame_label:'graph',member_count:5}]; const P=[{a:0,b:1,weight:12}]; console.log(JSON.stringify(layoutFrames(F,P)));"
```
Copy the printed JSON array verbatim — it is `GOLDEN` in the next step. (It will look like `[{"id":0,"name":"checkout","count":30,"x":...,"y":...,"w":...,"h":...}, ...]`.)

- [ ] **Step 2: Write the failing tests**

Append to `tests/mcp-server/frame-layout.test.ts` (inside the file, after the existing `describe("layoutFrames", …)` block — a new describe). Paste the captured array as `GOLDEN`:

```ts
describe("layoutFrames — vertical stratification (layer-adjacency force)", () => {
  // The exact output of the PRE-CHANGE layoutFrames on this fixture (captured via
  // the tsx one-liner in the plan). The flag-off path (no `sink`) must reproduce
  // it byte-for-byte — proof the new force is inert when off.
  const GOLD_FRAMES = [
    { frame_id: 0, frame_label: "checkout", member_count: 30 },
    { frame_id: 1, frame_label: "viewer", member_count: 10 },
    { frame_id: 2, frame_label: "graph", member_count: 5 },
  ];
  const GOLD_PAIRS = [{ a: 0, b: 1, weight: 12 }];
  const GOLDEN = /* PASTE captured JSON array here */;

  it("is byte-identical to pre-slice output when no frame carries a sink (inert guard)", () => {
    expect(layoutFrames(GOLD_FRAMES, GOLD_PAIRS)).toEqual(GOLDEN);
  });

  const stratFrames: LayoutInputFrame[] = [
    { frame_id: 0, frame_label: "surface", member_count: 10, sink: 0.0 },
    { frame_id: 1, frame_label: "substrate", member_count: 10, sink: 1.0 },
  ];

  it("places a low-sink (source) frame above a high-sink (substrate) frame", () => {
    const out = layoutFrames(stratFrames, []);
    const surface = out.find((f) => f.id === 0)!;
    const substrate = out.find((f) => f.id === 1)!;
    expect(surface.y).toBeLessThan(substrate.y);
  });

  it("is deterministic with the sink force on (byte-identical across runs)", () => {
    expect(layoutFrames(stratFrames, [])).toEqual(layoutFrames(stratFrames, []));
  });

  it("keeps stratified frames within the virtual stage", () => {
    for (const f of layoutFrames(stratFrames, [])) {
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w / 2).toBeLessThanOrEqual(STAGE_W);
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(0);
      expect(f.y + f.h / 2).toBeLessThanOrEqual(STAGE_H);
    }
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/rka/Development/cortex-wt-layer-layout && npx vitest run tests/mcp-server/frame-layout.test.ts`
Expected: FAIL — TypeScript error that `sink` is not a property of `LayoutInputFrame` (the on-path tests reference it). (The inert golden test would pass on its own, but the file won't compile until `sink` exists.)

- [ ] **Step 4: Add `sink` to the type, the constants, and the helper**

In `src/mcp-server/frame-layout.ts`, add `forceX, forceY` to the d3-force import:

```ts
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
} from "d3-force";
```

Extend `LayoutInputFrame`:

```ts
export interface LayoutInputFrame {
  frame_id: number;
  frame_label: string;
  member_count: number;
  /** Effective sink ratio in [0,1] (surface 0 → substrate 1). When present on
   *  ANY frame, the vertical stratification force is applied; omitted (default)
   *  → layout takes the exact pre-slice forceCenter path (byte-identical). */
  sink?: number;
}
```

Add these constants near the existing `FRAME_MIN`/`COLLIDE_PAD` block:

```ts
/** Vertical band the stratification force targets (px), inside stage margins. */
const TOP_Y = STAGE_H * 0.14;     // 112
const BOTTOM_Y = STAGE_H * 0.86;  // 688
/** forceY pull strength — stratifies vertically while the pair-link force still
 *  groups connected frames horizontally. */
const STRENGTH_Y = 0.18;

/** Target y for a frame from its sink ratio (clamped to [0,1]). */
function yTargetFor(sink: number): number {
  const s = Math.max(0, Math.min(1, sink));
  return TOP_Y + s * (BOTTOM_Y - TOP_Y);
}
```

Add `sink: number` to the `SimNode` interface:

```ts
interface SimNode extends SimulationNodeDatum {
  id: number;
  name: string;
  count: number;
  size: number;
  mass: number;
  /** Effective sink ratio carried from the input (default 0.5). */
  sink: number;
}
```

In the `nodes` map, carry sink through (add the field to the existing object literal):

```ts
  const nodes: SimNode[] = frames.map((f) => ({
    id: f.frame_id,
    name: f.frame_label,
    count: f.member_count,
    size: sizeFor(f.member_count, minC, maxC),
    mass: maxC <= minC ? 0.5 : (f.member_count - minC) / (maxC - minC),
    sink: f.sink ?? 0.5,
    x: STAGE_W / 2 + (init() - 0.5) * STAGE_W * 0.5,
    y: STAGE_H / 2 + (init() - 0.5) * STAGE_H * 0.5,
  }));
```

- [ ] **Step 5: Branch the simulation force set (preserve off-path order exactly)**

Replace the current single-expression sim construction:

```ts
  const sim = forceSimulation<SimNode>(nodes)
    // Inject the deterministic PRNG so d3's coincident-node jiggle is reproducible.
    .randomSource(mulberry32((seed ^ 0x9e3779b9) >>> 0))
    .force("charge", forceManyBody<SimNode>().strength(-320))
    .force("center", forceCenter(STAGE_W / 2, STAGE_H / 2))
    .force(
      "link",
      forceLink<SimNode, (typeof links)[number]>(links)
        .id((d) => d.id)
        // Heavier pair weight → shorter target distance, stronger spring.
        .distance((l) => 220 - 150 * (l.weight / maxW))
        .strength((l) => 0.1 + 0.8 * (l.weight / maxW)),
    )
    .force("collide", forceCollide<SimNode>((d) => d.size / 2 + COLLIDE_PAD).strength(1).iterations(4))
    .stop();
```

with this branched version (the off path registers forces in the IDENTICAL order — `charge, center, link, collide` — so output stays byte-identical; the on path swaps `center` for `x`+`y`):

```ts
  // Stratify when the caller attached sink data (the CORTEX_LAYER_LAYOUT gate is
  // read at the call site, not here — this module stays layer-agnostic).
  const stratify = frames.some((f) => f.sink !== undefined);

  const sim = forceSimulation<SimNode>(nodes)
    // Inject the deterministic PRNG so d3's coincident-node jiggle is reproducible.
    .randomSource(mulberry32((seed ^ 0x9e3779b9) >>> 0))
    .force("charge", forceManyBody<SimNode>().strength(-320));

  if (stratify) {
    // Vertical axis owned by the sink force; centering becomes horizontal-only so
    // forceCenter's mean-recentering doesn't fight the vertical distribution.
    sim
      .force("x", forceX<SimNode>(STAGE_W / 2).strength(0.05))
      .force("y", forceY<SimNode>((d) => yTargetFor(d.sink)).strength(STRENGTH_Y));
  } else {
    sim.force("center", forceCenter(STAGE_W / 2, STAGE_H / 2));
  }

  sim
    .force(
      "link",
      forceLink<SimNode, (typeof links)[number]>(links)
        .id((d) => d.id)
        // Heavier pair weight → shorter target distance, stronger spring.
        .distance((l) => 220 - 150 * (l.weight / maxW))
        .strength((l) => 0.1 + 0.8 * (l.weight / maxW)),
    )
    .force("collide", forceCollide<SimNode>((d) => d.size / 2 + COLLIDE_PAD).strength(1).iterations(4))
    .stop();
```

Leave the 300-tick damping loop and the collision-relaxation AABB tail **unchanged**.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/mcp-server/frame-layout.test.ts`
Expected: PASS — the inert golden matches (off path unchanged), and the stratification/determinism/bounds tests pass. If the inert golden FAILS, the off-path force order or node shape changed — fix so `charge, center, link, collide` is registered in that exact order and no force references `sink` when off.

- [ ] **Step 7: Commit**

```bash
git add src/mcp-server/frame-layout.ts tests/mcp-server/frame-layout.test.ts
git commit -m "feat(layout): vertical stratification force from measured sink (frame-layout)"
```

---

## Task 2: Gate + effective sink in `frame-map.ts`

**Files:**
- Modify: `src/mcp-server/frame-map.ts`
- Test: `tests/mcp-server/frame-map-layer.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/mcp-server/frame-map-layer.test.ts` (it already imports `buildFrameMap`, `NodeRow`, `EdgeRow` and defines `fileNode`/`symNode`/`edge` helpers). Add a new describe:

```ts
describe("layer-layout gating + stratification", () => {
  it("default OFF: no opts (env unset) matches explicit applyLayout:false", () => {
    const prev = process.env.CORTEX_LAYER_LAYOUT;
    delete process.env.CORTEX_LAYER_LAYOUT;
    try {
      const off = buildFrameMap(nodes, edges, { applyLayout: false });
      const dflt = buildFrameMap(nodes, edges); // env unset → default OFF
      expect(dflt.frames.map((f) => [f.id, f.x, f.y])).toEqual(off.frames.map((f) => [f.id, f.x, f.y]));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_LAYER_LAYOUT;
      else process.env.CORTEX_LAYER_LAYOUT = prev;
    }
  });

  it("CORTEX_LAYER_LAYOUT=1 matches explicit applyLayout:true", () => {
    const prev = process.env.CORTEX_LAYER_LAYOUT;
    process.env.CORTEX_LAYER_LAYOUT = "1";
    try {
      const envOn = buildFrameMap(nodes, edges);
      const on = buildFrameMap(nodes, edges, { applyLayout: true });
      expect(envOn.frames.map((f) => [f.id, f.x, f.y])).toEqual(on.frames.map((f) => [f.id, f.x, f.y]));
    } finally {
      if (prev === undefined) delete process.env.CORTEX_LAYER_LAYOUT;
      else process.env.CORTEX_LAYER_LAYOUT = prev;
    }
  });

  it("layout ON: a measured pure-source frame sits above a pure-sink frame", () => {
    // frame 0 (src/cli) imports frame 1 (src/events) → fanOut(0), fanIn(1).
    // sink(0)=0 → top band; sink(1)=1 → bottom band. Both ambient (budget floor 4).
    const srcSink: NodeRow[] = [
      fileNode("a1", "src/cli/run.ts", 0, "cli"),
      symNode("sa", "src/cli/run.ts"),
      fileNode("b1", "src/events/log.ts", 1, "events"),
      symNode("sb", "src/events/log.ts"),
    ];
    const e: EdgeRow[] = [edge("sa", "sb", "CALLS")]; // cli → events
    const on = buildFrameMap(srcSink, e, { applyLayout: true });
    const source = on.frames.find((f) => f.id === 0)!;
    const sink = on.frames.find((f) => f.id === 1)!;
    expect(source.y!).toBeLessThan(sink.y!);
  });

  it("layout ON: flowless frames stratify by their layer's nominal sink", () => {
    // No inter-frame edges → both flowless → NOMINAL_SINK[layer].
    // cli=interface(0.10) must sit above mcp-server=infrastructure(0.90).
    const flowless: NodeRow[] = [
      fileNode("c1", "src/cli/a.ts", 0, "cli"),
      fileNode("c2", "src/cli/b.ts", 0, "cli"),
      fileNode("m1", "src/mcp-server/x.ts", 1, "mcp-server"),
      fileNode("m2", "src/mcp-server/y.ts", 1, "mcp-server"),
    ];
    const on = buildFrameMap(flowless, [], { applyLayout: true });
    const iface = on.frames.find((f) => f.id === 0)!;
    const infra = on.frames.find((f) => f.id === 1)!;
    expect(iface.layer).toBe("interface");
    expect(infra.layer).toBe("infrastructure");
    expect(iface.y!).toBeLessThan(infra.y!);
  });

  it("layout ON serializes no extra internals (only x/y/w/h positions change)", () => {
    const json = JSON.stringify(buildFrameMap(nodes, edges, { applyLayout: true }));
    expect(json).not.toContain("sink");
    expect(json).not.toContain("fanIn");
    expect(json).not.toContain("fanOut");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/rka/Development/cortex-wt-layer-layout && npx vitest run tests/mcp-server/frame-map-layer.test.ts`
Expected: FAIL — `buildFrameMap` doesn't accept `applyLayout` (TS error), and the stratification tests fail because no sink is passed to the layout yet.

- [ ] **Step 3: Add the `NOMINAL_SINK` table near the top of `frame-map.ts`**

After the imports in `src/mcp-server/frame-map.ts`, add:

```ts
/** Per-layer nominal sink for the layout's vertical force, used ONLY for frames
 *  with no measured inter-frame flow (the categorical fallback). Surface→substrate
 *  order; domain mid-band. Frames that HAVE flows use their measured sink ratio. */
const NOMINAL_SINK: Record<FrameLayer, number> = {
  interface: 0.1,
  orchestration: 0.3,
  domain: 0.5,
  data: 0.7,
  infrastructure: 0.9,
  ceremony: 0.97,
};
```

(`FrameLayer` is already imported from `../frame-extraction/frame-kind.js`.)

- [ ] **Step 4: Extend the `buildFrameMap` signature**

Change:
```ts
  opts: { applyKindWeight?: boolean; applyDiversity?: boolean } = {},
```
to:
```ts
  opts: { applyKindWeight?: boolean; applyDiversity?: boolean; applyLayout?: boolean } = {},
```

- [ ] **Step 5: Compute the gate + attach effective sink at the `layoutFrames` call**

Find this block:
```ts
  const ambient = ranked.filter((r) => ambientIds.has(r.frame_id));
  const pairs = rollupFramePairs(nodes, edges);
  const positioned = layoutFrames(
    ambient.map((r) => ({
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_count: r.member_count,
    })),
    pairs,
  );
```

Replace it with:
```ts
  const ambient = ranked.filter((r) => ambientIds.has(r.frame_id));
  const pairs = rollupFramePairs(nodes, edges);

  // Layer-adjacency layout force (taxonomy layout slice). Default OFF — when off,
  // no `sink` is attached, so layoutFrames takes the pre-slice forceCenter path
  // and positions are byte-identical. When on, each ambient frame gets an
  // effective sink: measured (fanIn/(fanIn+fanOut)) when it has flows, else the
  // layer's NOMINAL_SINK. The env read lives here; the layout module stays
  // layer-agnostic (it only sees a number).
  const applyLayout = opts.applyLayout ?? process.env.CORTEX_LAYER_LAYOUT === "1";
  const effectiveSink = (frame_id: number): number => {
    const st = statsById.get(frame_id);
    const flow = (st?.fanIn ?? 0) + (st?.fanOut ?? 0);
    if (flow > 0) return st!.fanIn / flow;
    return NOMINAL_SINK[layerById.get(frame_id) ?? "domain"];
  };

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

(`statsById` and `layerById` are already defined earlier in `buildFrameMap`.)

- [ ] **Step 6: Run the layer-map tests**

Run: `npx vitest run tests/mcp-server/frame-map-layer.test.ts`
Expected: PASS — all existing kind-weight + diversity tests plus the five new layout tests.

- [ ] **Step 7: Run the full suite to confirm no regressions**

Run: `npx vitest run`
Expected: PASS — full suite green. If a pre-existing `frame-map`/`frame-layout` test fails, confirm `applyLayout` defaults OFF and the env is unset in that test (the inert path must be unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/mcp-server/frame-map.ts tests/mcp-server/frame-map-layer.test.ts
git commit -m "feat(layout): gate vertical force on CORTEX_LAYER_LAYOUT + effective sink"
```

---

## Task 3: Observe — layout off-vs-on stratification in the corpus eval

**Files:**
- Modify: `scripts/frame-extraction/eval-layers.ts`

Add a per-repo Spearman rank correlation between each ambient frame's `y` (from `buildFrameMap` with layout on) and its sink. High positive correlation ⇒ frames stratify by surface→substrate as intended.

- [ ] **Step 1: Add a `spearman` helper near the top of `eval-layers.ts`**

After the existing imports / helper functions (e.g. near `runtimeFracOf`), add:

```ts
/** Spearman rank correlation between two equal-length numeric series. Returns 0
 *  for n < 2. Pure; ties get average ranks. */
function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return 0;
  const rank = (v: number[]): number[] => {
    const idx = v.map((val, i) => [val, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array(n).fill(0);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1; // average rank (1-based)
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = rx[i] - mx, ay = ry[i] - my;
    num += ax * ay; dx += ax * ax; dy += ay * ay;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}
```

- [ ] **Step 2: Add a `layoutSpearman` field to the `RepoRow` interface**

Find the `RepoRow` interface (the line ending with `divEntered?: …; divAmbientOn?: …;`) and add a new line after it:

```ts
  layoutSpearman?: number;
```

- [ ] **Step 3: Compute the layout correlation in `evalRepo`**

Find the diversity-comparison block added previously (it ends with `const divAmbientOff = divDist(divOffAmbient), divAmbientOn = divDist(divOnAmbient);`). Add immediately after it:

```ts
    // Layout off-vs-on: Spearman(y, sink) of the ambient set with the vertical
    // force ON. A strong positive value = frames stratify by surface→substrate.
    const layoutOn = buildFrameMap(nodes, edges, { applyLayout: true });
    const sinkOf = (id: number) => {
      const s = statsById.get(id);
      const flow = (s?.fanIn ?? 0) + (s?.fanOut ?? 0);
      return flow > 0 ? s!.fanIn / flow : 0.5;
    };
    const ambientOnLayout = layoutOn.frames.filter((f) => f.ambient && f.y != null);
    const layoutSpearman = spearman(
      ambientOnLayout.map((f) => f.y as number),
      ambientOnLayout.map((f) => sinkOf(f.id)),
    );
```

**Note on `statsById`:** if `evalRepo` does not already have a `statsById` map in scope, build one where flows are computed. Find where `rollupFrameFlows` is called in `evalRepo` (it provides the `stats` used for the midband analysis) and add, right after that call: `const statsById = new Map(stats.map((s) => [s.frame_id, s]));` (only if not already present — do not duplicate).

- [ ] **Step 4: Add the field to the returned row and the log line**

Add `layoutSpearman` to the `evalRepo` return object (append it to the existing `return { ...base, …, divAmbientOff, divAmbientOn }` → add `, layoutSpearman`).

Then find the per-repo `diversity Δ` `console.log` and add after it:
```ts
    console.log(`[eval-layers]   layout: Spearman(y, sink) on = ${(row.layoutSpearman ?? 0).toFixed(3)} (→1 = clean surface→substrate stratification)`);
```

- [ ] **Step 5: Type-check the script compiles**

Run: `cd /Users/rka/Development/cortex-wt-layer-layout && npx tsc --noEmit`
Expected: exit 0, no errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/frame-extraction/eval-layers.ts
git commit -m "feat(eval): report layout Spearman(y, sink) stratification in corpus eval"
```

- [ ] **Step 7: (Optional, requires Python venv) Run the observe pass**

Run (if `~/.cache/cortex-indexer/python-venv` exists): `npx tsx scripts/frame-extraction/eval-layers.ts`
Read the per-repo `layout: Spearman(y, sink)` lines — expect strongly positive values on repos with real flow structure. If the venv is unavailable, note the observe run is **deferred to a hand-run before the default flip** — do not claim it ran.

---

## Task 4: Gate 0 — visual QA

**Files:** none (verification only). Required — the layout drives rendered frame positions.

- [ ] **Step 1: Start the dev server with the flag ON**

The worktree needs `node_modules` + `bin/cortex-indexer`; if absent, symlink from the main checkout: `ln -s /Users/rka/Development/cortex/node_modules node_modules` and `mkdir -p bin && ln -sf /Users/rka/Development/cortex/bin/cortex-indexer bin/cortex-indexer`. The MCP server shuts down on stdin-close, so keep stdin open:
```bash
cd /Users/rka/Development/cortex-wt-layer-layout && tail -f /dev/null | CORTEX_LAYER_LAYOUT=1 npm run dev > .tmp-dev.log 2>&1 &
```
Wait for `http://localhost:3334/viewer` to return 200.

- [ ] **Step 2: Drive the viewer**

Navigate to `http://localhost:3334/viewer`, wait ~3s for the canvas, capture a screenshot to `.tmp/` (or `.playwright-mcp/`), and check the browser console for errors.

- [ ] **Step 3: Verify and report**

Confirm: frames visibly stratify into a vertical slice (surface/interface high, substrate/infrastructure low), connected frames still cluster horizontally, no overlap or edge-clamp pathology, console clean. Also capture a flag-OFF render (restart without the env var) and confirm it's the current layout. Report findings; runtime errors or broken layout → block + fix. If Playwright/display is unavailable, state so and flag for user-driven hand-verify before merge. Stop the dev server when done.

---

## Task 5: Decision capture

**Files:** none (Cortex MCP decision tools against `repo_path: /Users/rka/Development/cortex`, so the decision is durable after the worktree is removed).

- [ ] **Step 1: Check for duplicates**

`search_decisions({ repo_path: "/Users/rka/Development/cortex", query: "layout vertical stratification sink force frame layout" })`.

- [ ] **Step 2: Create the decision**

`create_decision` with:
- **title:** "Layer-adjacency layout force — vertical stratification from measured sink"
- **description:** A new `forceY(yTarget(sink))` in `src/mcp-server/frame-layout.ts` stratifies ambient frames vertically (surface→substrate) on the proven d3-force base; the existing pair-link clustering, charge, and collide/AABB tail are unchanged. The layout module stays layer-agnostic — it receives a plain `sink: number`; `frame-map.ts` reads `CORTEX_LAYER_LAYOUT` and computes each frame's effective sink (measured `fanIn/(fanIn+fanOut)`, or `NOMINAL_SINK[layer]` for flowless frames). `forceCenter` is swapped for a horizontal-only `forceX` only when stratifying. Default OFF (inert — positions byte-identical when off, golden-tested); `yTarget = lerp(TOP_Y, BOTTOM_Y, sink)`, `STRENGTH_Y=0.18`.
- **rationale:** The spec directs measured adjacency from `rollupFrameFlows`, not categorical bands; the sink ratio is the already-computed surface↔substrate signal, so vertical position is earned from data while visually approximating the bands. One new positional force on a proven base keeps the change attributable (mirrors 3a/3b threading a plain number to keep the core module layer-free). `forceCenter`→`forceX` avoids the mean-recentering fighting the vertical distribution. Default-off + observe matches the arc's walk-before-run discipline.
- **alternatives:** (a) categorical layer bands — rejected, the "categorical adjacency" the spec warns against, ignores measured flows; (b) replace pair-links with directed flow links + vertical force — rejected, rewrites the proven clustering and couples two new mechanisms; (c) hybrid band-anchor + flow-refine — rejected, half-keeps categorical and couples signals; (d) ship default-on — rejected, breaks observe attribution.
- **governs:** `["src/mcp-server/frame-layout.ts", "src/mcp-server/frame-map.ts", "docs/superpowers/specs/2026-06-16-layer-adjacency-layout-force-design.md"]`

- [ ] **Step 3: Link relationships**

`link_decision` the new decision `RELATED_TO` `D-wvsz` (layer-diversity) and `D-g4qb` (kind-weight).

---

## Done criteria

- `frame-layout.ts` gains a measured-sink vertical force; flag-off output byte-identical to pre-slice (golden-tested); flag-on stratifies, deterministic, in-bounds.
- `buildFrameMap` attaches effective sink only when `CORTEX_LAYER_LAYOUT=1` / `applyLayout:true`; default off; no internals serialized.
- `npx vitest run` fully green; `npx tsc --noEmit` clean.
- Eval reports layout Spearman(y, sink); observe captured (or deferred with a note).
- Gate 0 passed (or flagged for hand-verify).
- Decision captured + linked.
- **Not in this slice:** floating-entity placement / D-xwxj retirement (next slice), flipping the default on, version bump/merge (handled at merge time).

---

## Self-review notes

- **Spec coverage:** vertical force + `sink` type + constants + branch → Task 1; flag gate + `NOMINAL_SINK` + effectiveSink + plumbing → Task 2; observe (Spearman) → Task 3; Gate 0 → Task 4; decision → Task 5. Inert guarantee covered by the Task 1 golden + Task 2 default-off test. Determinism covered in Task 1.
- **Type consistency:** `LayoutInputFrame.sink?: number`, `SimNode.sink: number`, `yTargetFor(sink)`, `TOP_Y`/`BOTTOM_Y`/`STRENGTH_Y`, `NOMINAL_SINK: Record<FrameLayer, number>`, `effectiveSink(frame_id)`, `opts.applyLayout` / `CORTEX_LAYER_LAYOUT`, `RepoRow.layoutSpearman` — used identically across tasks and the spec.
- **No placeholders:** every code step shows complete code; the only intentional fill-in is the `GOLDEN` array, which Step 1 of Task 1 captures via the given command before the test is written.
- **Force-order caveat** (spec's determinism note) is enforced in Task 1 Step 5 (off path registers `charge, center, link, collide` in the exact current order) and verified by the inert golden test.

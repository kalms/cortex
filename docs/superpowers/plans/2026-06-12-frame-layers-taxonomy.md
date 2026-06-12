# Frame Layers Taxonomy (Milestone 1: Classify + Observe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deterministically classify every extracted frame into one of six architectural layers and surface it as a quiet, toggleable lens in the 2D viewer — with zero change to ranking, ambient selection, or layout.

**Architecture:** Two new pure modules (`frame-flow-rollup.ts` for directed frame-level flows, `frame-kind.ts` for the agreement-based classifier) orchestrated at read time by the existing `buildFrameMap` behind `/api/frames`, which gains exactly one field per frame: `layer`. The viewer gains a `layers` toolbar menu (switch + legend, legend nowhere else); when on, frame fill/border/label take a per-layer hue; when off, rendering is pixel-identical to today. Internals (`confidence`, contributions) never serialize.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest (`npm test`), plain-JS canvas viewer (`src/viewer/`), Playwright MCP for Gate-0 visual QA.

**Spec:** [docs/superpowers/specs/2026-06-12-frame-layers-taxonomy-design.md](../specs/2026-06-12-frame-layers-taxonomy-design.md)

**Branch:** `feature/frame/layers-taxonomy` (already created; spec committed on it).

**Repo conventions you must follow:**
- Tests live in `tests/<area>/<module>.test.ts`, mirroring `src/<area>/<module>.ts`. Import with `../../src/...js` suffix.
- Run a single test file: `npx vitest run tests/mcp-server/frame-flow-rollup.test.ts`
- Run everything: `npm test`
- Commit format: `<type>(<scope>): <description>`, e.g. `feat(frame): add directed frame flow rollup`.

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `src/mcp-server/frame-flow-rollup.ts` | create | Directed frame-level flow rollup + per-frame fan-in/fan-out stats |
| `tests/mcp-server/frame-flow-rollup.test.ts` | create | Unit tests for the above |
| `src/frame-extraction/frame-kind.ts` | create | The 6-layer classifier (pure, deterministic) |
| `tests/frame-extraction/frame-kind.test.ts` | create | Unit tests incl. determinism + tie-break |
| `src/mcp-server/frame-map.ts` | modify | Call rollup+classifier, add `layer` to `FrameMapEntry` |
| `tests/mcp-server/frame-map-layer.test.ts` | create | `layer` present, internals absent (negative assertion) |
| `tests/fixtures/frame-layers/cortex-frames.json` | create (generated) | Frozen FrameKindInput snapshot of cortex's own frames |
| `tests/frame-extraction/expected-layers.test.ts` | create | Hand-labeled regression over the frozen snapshot |
| `src/viewer/index.html` | modify | `layers` menu markup in the toolbar |
| `src/viewer/style.css` | modify | Menu styles (viewer chrome vocabulary) |
| `src/viewer/viewer.js` | modify | Layer palette, menu wiring + localStorage, tint in draw path |
| `docs/architecture/graph-ui.md` | modify | One paragraph documenting the layers lens |

---

### Task 1: Directed frame flow rollup

The existing `rollupFramePairs` (`src/mcp-server/frame-pair-rollup.ts`) is undirected — it normalizes pairs to `(lo, hi)` keys for the layout's gravity force. Layer classification needs **direction** (who depends on whom), so this task adds a directed sibling in a new file. It reuses `buildNodeFrameIndex` from `frame-pair-rollup.ts` (already exported).

**Files:**
- Create: `src/mcp-server/frame-flow-rollup.ts`
- Test: `tests/mcp-server/frame-flow-rollup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp-server/frame-flow-rollup.test.ts
import { describe, it, expect } from "vitest";
import { rollupFrameFlows } from "../../src/mcp-server/frame-flow-rollup.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

function fileNode(id: string, path: string, frameId?: number): NodeRow {
  return {
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: frameId === undefined ? "{}" : JSON.stringify({ frame_id: frameId, frame_label: `f${frameId}` }),
    tier: "tier1", created_at: "", updated_at: "",
  };
}
function symNode(id: string, path: string): NodeRow {
  return {
    id, kind: "function", name: id, qualified_name: `${path}::${id}`, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}
function edge(source: string, target: string, relation: string): EdgeRow {
  return { id: `${source}->${target}`, source_id: source, target_id: target, relation, data: "{}", created_at: "" };
}

const nodes = [
  fileNode("fileA", "a.ts", 0), symNode("symA", "a.ts"),
  fileNode("fileB", "b.ts", 1), symNode("symB", "b.ts"),
  fileNode("fileC", "c.ts", 0), symNode("symC", "c.ts"),
  fileNode("fileD", "d.ts"),    symNode("symD", "d.ts"), // frameless
];

describe("rollupFrameFlows", () => {
  it("preserves direction: source frame → target frame", () => {
    const edges = [edge("symA", "symB", "CALLS")]; // frame 0 → frame 1
    const { flows } = rollupFrameFlows(nodes, edges);
    expect(flows).toEqual([{ from: 0, to: 1, weight: 1 }]);
  });

  it("keeps opposite directions as separate flows", () => {
    const edges = [
      edge("symA", "symB", "CALLS"),   // 0 → 1
      edge("symB", "symA", "IMPORTS"), // 1 → 0
      edge("symC", "symB", "CALLS"),   // 0 → 1 again
    ];
    const { flows } = rollupFrameFlows(nodes, edges);
    expect(flows).toEqual([
      { from: 0, to: 1, weight: 2 },
      { from: 1, to: 0, weight: 1 },
    ]);
  });

  it("computes per-frame fanIn/fanOut stats over inter-frame flows", () => {
    const edges = [
      edge("symA", "symB", "CALLS"),   // 0 → 1
      edge("symB", "symA", "IMPORTS"), // 1 → 0
      edge("symC", "symB", "USAGE"),   // 0 → 1
    ];
    const { stats } = rollupFrameFlows(nodes, edges);
    expect(stats).toEqual([
      { frame_id: 0, fanIn: 1, fanOut: 2 },
      { frame_id: 1, fanIn: 2, fanOut: 1 },
    ]);
  });

  it("stats include every framed file's frame, even with zero flows", () => {
    const { stats } = rollupFrameFlows(nodes, []);
    expect(stats).toEqual([
      { frame_id: 0, fanIn: 0, fanOut: 0 },
      { frame_id: 1, fanIn: 0, fanOut: 0 },
    ]);
  });

  it("skips intra-frame edges, frameless files, and non-rollup relations", () => {
    const edges = [
      edge("symA", "symC", "CALLS"),   // intra frame 0
      edge("symA", "symD", "CALLS"),   // frameless target
      edge("symA", "symB", "DEFINES"), // not a rollup relation
    ];
    const { flows } = rollupFrameFlows(nodes, edges);
    expect(flows).toEqual([]);
  });

  it("is deterministic: flows sorted by weight desc then from,to asc; stats by frame_id", () => {
    const edges = [
      edge("symB", "symA", "CALLS"),   // 1 → 0
      edge("symA", "symB", "CALLS"),   // 0 → 1
    ];
    const { flows } = rollupFrameFlows(nodes, edges);
    expect(flows).toEqual([
      { from: 0, to: 1, weight: 1 },
      { from: 1, to: 0, weight: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/mcp-server/frame-flow-rollup.test.ts`
Expected: FAIL — `Cannot find module '../../src/mcp-server/frame-flow-rollup.js'`

- [ ] **Step 3: Implement the module**

```ts
// src/mcp-server/frame-flow-rollup.ts
/**
 * Directed counterpart to frame-pair-rollup: roll symbol-level CALLS/USAGE/
 * IMPORTS edges up to DIRECTED frame→frame flows plus per-frame fan-in/fan-out
 * totals. The undirected rollup feeds the layout's gravity force; this one
 * feeds layer classification (frame-kind.ts), where direction is the signal —
 * a frame that is mostly imported is substrate, a frame that mostly imports
 * is surface. Spec: docs/superpowers/specs/2026-06-12-frame-layers-taxonomy-design.md.
 *
 * PURE — no I/O.
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";
import { buildNodeFrameIndex } from "./frame-pair-rollup.js";

/** Same relation set as the undirected rollup. */
const ROLLUP_RELATIONS = new Set(["CALLS", "USAGE", "IMPORTS"]);

export interface FrameFlow {
  from: number;
  to: number;
  /** Count of underlying symbol-level edges in this direction. */
  weight: number;
}

export interface FrameFlowStats {
  frame_id: number;
  /** Σ inbound inter-frame edge weight. */
  fanIn: number;
  /** Σ outbound inter-frame edge weight. */
  fanOut: number;
}

export function rollupFrameFlows(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
): { flows: FrameFlow[]; stats: FrameFlowStats[] } {
  const frameById = buildNodeFrameIndex(nodes);

  // Every frame that exists gets a stats row, flows or not.
  const statsById = new Map<number, FrameFlowStats>();
  for (const fid of frameById.values()) {
    if (!statsById.has(fid)) statsById.set(fid, { frame_id: fid, fanIn: 0, fanOut: 0 });
  }

  const flowByKey = new Map<string, FrameFlow>();
  for (const e of edges) {
    if (!ROLLUP_RELATIONS.has(e.relation)) continue;
    const from = frameById.get(e.source_id);
    const to = frameById.get(e.target_id);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}:${to}`;
    let flow = flowByKey.get(key);
    if (!flow) {
      flow = { from, to, weight: 0 };
      flowByKey.set(key, flow);
    }
    flow.weight += 1;
    statsById.get(from)!.fanOut += 1;
    statsById.get(to)!.fanIn += 1;
  }

  const flows = [...flowByKey.values()].sort(
    (x, y) => y.weight - x.weight || x.from - y.from || x.to - y.to,
  );
  const stats = [...statsById.values()].sort((x, y) => x.frame_id - y.frame_id);
  return { flows, stats };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run tests/mcp-server/frame-flow-rollup.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/frame-flow-rollup.ts tests/mcp-server/frame-flow-rollup.test.ts
git commit -m "feat(frame): directed frame flow rollup with fan-in/fan-out stats"
```

---

### Task 2: The frame-kind classifier

Pure module. Every source always runs and emits weight contributions over the six layers; contributions sum; argmax wins; ties break by canonical layer order; below `MIN_SIGNAL` falls back to `domain`. The internal record (`confidence`, `contributions`) is exported **only** for tests/eval via `classifyFramesInternal`; production consumers use `classifyFrames`, which strips internals.

**Files:**
- Create: `src/frame-extraction/frame-kind.ts`
- Test: `tests/frame-extraction/frame-kind.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/frame-extraction/frame-kind.test.ts
import { describe, it, expect } from "vitest";
import {
  classifyFrames,
  classifyFramesInternal,
  type FrameKindInput,
} from "../../src/frame-extraction/frame-kind.js";

function input(partial: Partial<FrameKindInput> & { frame_id: number }): FrameKindInput {
  return {
    frame_label: `frame:${partial.frame_id}`,
    member_paths: [],
    fanIn: 0,
    fanOut: 0,
    ...partial,
  };
}

describe("graph-position source", () => {
  it("low sink ratio (source-heavy) proposes the surface pair; lexical silence leaves the canonical-order winner", () => {
    // fanIn 2 / fanOut 8 → sink 0.2 ≤ 0.35 → interface + orchestration get
    // (0.5-0.2)*2*W_GRAPH = 0.6 each; tie → canonical order → interface.
    const [r] = classifyFrames([input({ frame_id: 1, fanIn: 2, fanOut: 8 })]);
    expect(r).toEqual({ frame_id: 1, layer: "interface" });
  });

  it("high sink ratio (imported-heavy) proposes the substrate pair; tie resolves to data by canonical order", () => {
    // fanIn 8 / fanOut 2 → sink 0.8 ≥ 0.65 → data + infrastructure 0.6 each.
    const [r] = classifyFrames([input({ frame_id: 2, fanIn: 8, fanOut: 2 })]);
    expect(r.layer).toBe("data");
  });

  it("is silent in the middle band", () => {
    // sink 0.5 → no graph contribution, no other signals → domain fallback.
    const [r] = classifyFrames([input({ frame_id: 3, fanIn: 5, fanOut: 5 })]);
    expect(r.layer).toBe("domain");
  });

  it("treats zero flows as sink 0.5 (silent)", () => {
    const [r] = classifyFrames([input({ frame_id: 4 })]);
    expect(r.layer).toBe("domain");
  });
});

describe("path-pattern source", () => {
  it("maps member directory segments to layers", () => {
    const [r] = classifyFrames([
      input({ frame_id: 5, member_paths: ["src/cli/run.ts", "src/cli/args.ts"] }),
    ]);
    expect(r.layer).toBe("interface");
  });

  it("lexical signal breaks the topological surface tie toward orchestration", () => {
    // sink 0.2 → interface+orchestration 0.6 each; 'seed' paths add W_PATH to orchestration.
    const [r] = classifyFrames([
      input({
        frame_id: 6,
        fanIn: 2, fanOut: 8,
        member_paths: ["src/decisions/seed/commit-clustering.ts", "src/decisions/seed/doc-discovery.ts"],
      }),
    ]);
    expect(r.layer).toBe("orchestration");
  });

  it("accumulates fractions per layer when members span tables", () => {
    const [r] = classifyFrames([
      input({
        frame_id: 7,
        member_paths: ["src/events/log.ts", "src/events/bus.ts", "src/events/store.ts", "x/misc.ts"],
      }),
    ]);
    expect(r.layer).toBe("data"); // 3/4 members match data tokens
  });
});

describe("content signals", () => {
  it("near-all-tests frames are ceremony (fraction ≥ 0.8)", () => {
    const [r] = classifyFrames([
      input({
        frame_id: 8,
        member_paths: ["a/x.test.ts", "a/y.test.ts", "a/z.spec.ts", "a/w.test.ts", "a/v.test.ts"],
      }),
    ]);
    expect(r.layer).toBe("ceremony");
  });

  it("mixed frames (65% tests) do NOT become ceremony by content", () => {
    const [r] = classifyFrames([
      input({
        frame_id: 9,
        member_paths: ["a/x.test.ts", "a/y.test.ts", "a/z.test.ts", "a/svc.ts", "a/types.ts"],
      }),
    ]);
    expect(r.layer).toBe("domain"); // testFrac 0.6 < 0.8 → silent → fallback
  });

  it("non-runtime-extension majority is ceremony", () => {
    const [r] = classifyFrames([
      input({ frame_id: 10, member_paths: ["h/check.sh", "h/run.sh", "h/conf.yml"] }),
    ]);
    expect(r.layer).toBe("ceremony");
  });

  it("frame_label tokens run through the path table", () => {
    const [r] = classifyFrames([
      input({ frame_id: 11, frame_label: "events/worker", member_paths: ["x/a.ts"] }),
    ]);
    expect(r.layer).toBe("data"); // label token 'events' → data via W_LABEL
  });
});

describe("combination + contract", () => {
  it("returns one result per input, sorted by frame_id", () => {
    const out = classifyFrames([input({ frame_id: 9 }), input({ frame_id: 1 })]);
    expect(out.map((r) => r.frame_id)).toEqual([1, 9]);
  });

  it("is deterministic under input order shuffles", () => {
    const a = input({ frame_id: 1, fanIn: 2, fanOut: 8 });
    const b = input({ frame_id: 2, member_paths: ["src/cli/x.ts"] });
    const c = input({ frame_id: 3, member_paths: ["a/x.test.ts", "a/y.test.ts"] });
    expect(classifyFrames([a, b, c])).toEqual(classifyFrames([c, a, b]));
  });

  it("classifyFrames exposes ONLY frame_id and layer", () => {
    const [r] = classifyFrames([input({ frame_id: 12, fanIn: 8, fanOut: 2 })]);
    expect(Object.keys(r).sort()).toEqual(["frame_id", "layer"]);
  });

  it("classifyFramesInternal carries confidence and contributions for the eval harness", () => {
    const [r] = classifyFramesInternal([input({ frame_id: 13, member_paths: ["src/cli/x.ts"] })]);
    expect(r.layer).toBe("interface");
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.contributions.interface).toBeGreaterThan(0);
  });

  it("empty input → empty output", () => {
    expect(classifyFrames([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/frame-extraction/frame-kind.test.ts`
Expected: FAIL — `Cannot find module '../../src/frame-extraction/frame-kind.js'`

- [ ] **Step 3: Implement the classifier**

```ts
// src/frame-extraction/frame-kind.ts
/**
 * Deterministic 6-layer frame classifier (taxonomy milestone 1: classify+observe).
 *
 * Agreement-based combination (NOT the original spec's first-match-wins chain):
 * every source always runs and emits weight contributions over the six layers;
 * contributions sum; argmax wins; ties break by canonical LAYER_ORDER; a summed
 * max below MIN_SIGNAL falls back to 'domain'. Rationale: measurement on the
 * cortex graph showed topology is authoritative at the surface↔substrate ENDS
 * of the layer axis and silent in the middle, while lexical signals refine the
 * middle — so sources must combine, not chain. The original chain's #1 source
 * (ACDC dominator symbol) is unbuildable: the shipped tfidf+hdbscan pipeline
 * produces no dominator data. is_entry_point is deliberately unused (measured
 * too loose: 72 "entry points" in frame-extraction alone).
 *
 * Determinism contract (spec, non-negotiable): no randomness, no timestamps,
 * named constants, stable sorts, canonical tie-break. Internal machinery
 * (confidence, contributions) exists for the eval harness ONLY — production
 * consumers use classifyFrames, which strips it.
 *
 * Spec: docs/superpowers/specs/2026-06-12-frame-layers-taxonomy-design.md
 * PURE — no I/O.
 */

export type FrameLayer =
  | "interface"
  | "orchestration"
  | "domain"
  | "data"
  | "infrastructure"
  | "ceremony";

/** Canonical order — fixed tie-break, also the legend order. */
export const LAYER_ORDER: readonly FrameLayer[] = [
  "interface",
  "orchestration",
  "domain",
  "data",
  "infrastructure",
  "ceremony",
];

export interface FrameKindInput {
  frame_id: number;
  frame_label: string;
  member_paths: string[];
  /** Σ inbound inter-frame edge weight (frame-flow-rollup stats). */
  fanIn: number;
  /** Σ outbound inter-frame edge weight. */
  fanOut: number;
}

/** Public result — the ONLY shape that leaves the module for serialization. */
export interface FrameKind {
  frame_id: number;
  layer: FrameLayer;
}

/** Internal result — eval harness + tests only. Never serialize. */
export interface FrameKindInternal extends FrameKind {
  /** argmax margin over runner-up, 0–1; 0 for fallback. */
  confidence: number;
  contributions: Record<FrameLayer, number>;
}

/* ── Constants (tuned during the observation phase; committed code) ── */
const SINK_SURFACE = 0.35;
const SINK_SUBSTRATE = 0.65;
const W_GRAPH = 1.0;
const W_PATH = 0.8;
const W_TEST = 0.9;
const W_CEREMONY_EXT = 0.5;
const W_LABEL = 0.4;
const MIN_SIGNAL = 0.25;
/** 0.8, not 0.5: clustering co-locates tests with their subjects (the
 *  `decisions` frame is 65% tests yet is the product's subject). Only a
 *  near-all-tests frame is ceremony BY CONTENT. */
const TEST_FRACTION_MIN = 0.8;
const EXT_FRACTION_MIN = 0.5;

/** Curated path-segment → layer table (frame-ranking.md §classification-sources,
 *  v1). No tokens map to 'domain': domain is what remains when a frame is
 *  neither surface plumbing, substrate plumbing, nor ceremony. */
const PATH_LAYER_TABLE: ReadonlyArray<[FrameLayer, ReadonlySet<string>]> = [
  ["interface", new Set(["routes", "pages", "views", "components", "cli", "ui"])],
  ["orchestration", new Set(["handlers", "controllers", "services", "workflows", "seed"])],
  ["data", new Set(["models", "schemas", "db", "store", "persistence", "events"])],
  ["infrastructure", new Set(["transport", "infra", "mcp-server", "server", "cache", "queue", "indexer"])],
  ["ceremony", new Set(["test", "tests", "__tests__", "evals", "scripts", "build", "hooks", "config", "integration"])],
];

const TEST_PATH_RE = /\.test\.|\.spec\.|(^|\/)tests?\//;
const NON_RUNTIME_EXT_RE = /\.(sh|ya?ml|json|md)$/;

/** Lowercased directory segments + basename sans extension. */
function pathSegments(path: string): string[] {
  const parts = path.toLowerCase().split("/");
  const base = parts.pop() ?? "";
  const dot = base.lastIndexOf(".");
  parts.push(dot > 0 ? base.slice(0, dot) : base);
  return parts;
}

function zeroContributions(): Record<FrameLayer, number> {
  return {
    interface: 0,
    orchestration: 0,
    domain: 0,
    data: 0,
    infrastructure: 0,
    ceremony: 0,
  };
}

function classifyOne(input: FrameKindInput): FrameKindInternal {
  const c = zeroContributions();
  const members = input.member_paths;

  // ── Source A: graph position (authoritative at the ends, silent in the middle)
  const total = input.fanIn + input.fanOut;
  const sink = total > 0 ? input.fanIn / total : 0.5;
  if (sink <= SINK_SURFACE) {
    const s = (0.5 - sink) * 2 * W_GRAPH;
    c.interface += s;
    c.orchestration += s;
  } else if (sink >= SINK_SUBSTRATE) {
    const s = (sink - 0.5) * 2 * W_GRAPH;
    c.data += s;
    c.infrastructure += s;
  }

  // ── Source B: path patterns (fraction of members matching each layer's tokens)
  if (members.length > 0) {
    for (const [layer, tokens] of PATH_LAYER_TABLE) {
      let matching = 0;
      for (const p of members) {
        if (pathSegments(p).some((seg) => tokens.has(seg))) matching++;
      }
      if (matching > 0) c[layer] += W_PATH * (matching / members.length);
    }
  }

  // ── Source C: content signals
  if (members.length > 0) {
    const testFrac = members.filter((p) => TEST_PATH_RE.test(p)).length / members.length;
    if (testFrac >= TEST_FRACTION_MIN) c.ceremony += W_TEST * testFrac;
    const extFrac = members.filter((p) => NON_RUNTIME_EXT_RE.test(p)).length / members.length;
    if (extFrac >= EXT_FRACTION_MIN) c.ceremony += W_CEREMONY_EXT;
  }
  const labelSegs = new Set(input.frame_label.toLowerCase().split(/[/\s:_-]+/));
  for (const [layer, tokens] of PATH_LAYER_TABLE) {
    for (const seg of labelSegs) {
      if (tokens.has(seg)) {
        c[layer] += W_LABEL;
        break; // once per layer
      }
    }
  }

  // ── Combine: argmax, canonical tie-break, domain fallback below MIN_SIGNAL
  let best: FrameLayer = "domain";
  let bestScore = -1;
  for (const layer of LAYER_ORDER) {
    if (c[layer] > bestScore) {
      best = layer;
      bestScore = c[layer];
    }
  }
  if (bestScore < MIN_SIGNAL) {
    return { frame_id: input.frame_id, layer: "domain", confidence: 0, contributions: c };
  }
  let second = 0;
  for (const layer of LAYER_ORDER) {
    if (layer !== best && c[layer] > second) second = c[layer];
  }
  const confidence = bestScore > 0 ? (bestScore - second) / bestScore : 0;
  return { frame_id: input.frame_id, layer: best, confidence, contributions: c };
}

/** Eval harness + tests only — never serialize this shape. */
export function classifyFramesInternal(inputs: readonly FrameKindInput[]): FrameKindInternal[] {
  return inputs.map(classifyOne).sort((a, b) => a.frame_id - b.frame_id);
}

/** Production surface: one layer per frame, nothing else. */
export function classifyFrames(inputs: readonly FrameKindInput[]): FrameKind[] {
  return classifyFramesInternal(inputs).map(({ frame_id, layer }) => ({ frame_id, layer }));
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run tests/frame-extraction/frame-kind.test.ts`
Expected: PASS (14 tests). If the seed-path test fails because `decisions` also matches: note `src/decisions/seed/...` contains segment `seed` (orchestration) only — `decisions` is not in any table; the expected result stands.

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-kind.ts tests/frame-extraction/frame-kind.test.ts
git commit -m "feat(frame): deterministic 6-layer frame-kind classifier"
```

---

### Task 3: Orchestrate in frame-map; `layer` rides `/api/frames`

`buildFrameMap` (`src/mcp-server/frame-map.ts`) already loads everything needed. Wire rollup + classifier in and add exactly one field to `FrameMapEntry`. The `/api/frames` endpoint serializes `buildFrameMap`'s return value as-is, so no endpoint change is needed.

**Files:**
- Modify: `src/mcp-server/frame-map.ts`
- Test: `tests/mcp-server/frame-map-layer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mcp-server/frame-map-layer.test.ts
import { describe, it, expect } from "vitest";
import { buildFrameMap } from "../../src/mcp-server/frame-map.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

function fileNode(id: string, path: string, frameId: number, label: string): NodeRow {
  return {
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: JSON.stringify({ frame_id: frameId, frame_label: label }),
    tier: "tier1", created_at: "", updated_at: "",
  };
}
function symNode(id: string, path: string): NodeRow {
  return {
    id, kind: "function", name: id, qualified_name: `${path}::${id}`, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}
function edge(source: string, target: string, relation: string): EdgeRow {
  return { id: `${source}->${target}`, source_id: source, target_id: target, relation, data: "{}", created_at: "" };
}

const nodes: NodeRow[] = [
  fileNode("f1", "src/cli/run.ts", 0, "cli"),
  fileNode("f2", "src/cli/args.ts", 0, "cli"),
  symNode("s1", "src/cli/run.ts"),
  fileNode("f3", "src/events/log.ts", 1, "events"),
  symNode("s2", "src/events/log.ts"),
];
const edges: EdgeRow[] = [edge("s1", "s2", "CALLS")]; // cli → events

describe("buildFrameMap layer field", () => {
  it("attaches a layer to every frame entry", () => {
    const map = buildFrameMap(nodes, edges);
    expect(map.frames.length).toBe(2);
    for (const f of map.frames) {
      expect(["interface", "orchestration", "domain", "data", "infrastructure", "ceremony"])
        .toContain(f.layer);
    }
    const cli = map.frames.find((f) => f.name === "cli")!;
    expect(cli.layer).toBe("interface");
    const events = map.frames.find((f) => f.name === "events")!;
    expect(events.layer).toBe("data");
  });

  it("NEVER serializes classifier internals (negative assertion)", () => {
    const json = JSON.stringify(buildFrameMap(nodes, edges));
    expect(json).not.toContain("confidence");
    expect(json).not.toContain("contributions");
  });

  it("classifies frames with zero flows too", () => {
    const map = buildFrameMap(nodes, []); // no edges at all
    for (const f of map.frames) expect(typeof f.layer).toBe("string");
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/mcp-server/frame-map-layer.test.ts`
Expected: FAIL — `f.layer` is `undefined` (property does not exist yet)

- [ ] **Step 3: Wire the classifier into `buildFrameMap`**

In `src/mcp-server/frame-map.ts`, add the imports:

```ts
import { rollupFrameFlows } from "./frame-flow-rollup.js";
import { classifyFrames, type FrameLayer } from "../frame-extraction/frame-kind.js";
```

Add `layer` to `FrameMapEntry`:

```ts
export interface FrameMapEntry {
  id: number;
  name: string;
  count: number;
  /** Integer px in virtual-stage coords; null for non-ambient (unpositioned). */
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  ambient: boolean;
  rank: number;
  score: number;
  /** Architectural layer (taxonomy milestone 1). Deterministic; no internals exposed. */
  layer: FrameLayer;
}
```

In `buildFrameMap`, after `const ranked = rankFrames(records, corpus);` add:

```ts
  const { stats } = rollupFrameFlows(nodes, edges);
  const statsById = new Map(stats.map((s) => [s.frame_id, s]));
  const kinds = classifyFrames(
    records.map((r) => ({
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_paths: r.member_paths,
      fanIn: statsById.get(r.frame_id)?.fanIn ?? 0,
      fanOut: statsById.get(r.frame_id)?.fanOut ?? 0,
    })),
  );
  const layerById = new Map(kinds.map((k) => [k.frame_id, k.layer]));
```

And in the `frames` mapping at the bottom, add the field:

```ts
  const frames: FrameMapEntry[] = ranked.map((r) => {
    const p = posById.get(r.frame_id);
    return {
      id: r.frame_id,
      name: r.frame_label,
      count: r.member_count,
      x: p ? p.x : null,
      y: p ? p.y : null,
      w: p ? p.w : null,
      h: p ? p.h : null,
      ambient: r.ambient,
      rank: r.rank,
      score: r.score,
      layer: layerById.get(r.frame_id) ?? "domain",
    };
  });
```

- [ ] **Step 4: Run the new test, then the full suite**

Run: `npx vitest run tests/mcp-server/frame-map-layer.test.ts`
Expected: PASS (3 tests)

Run: `npm test`
Expected: PASS — in particular any existing `frame-map` tests must still pass (the new field is additive). If an existing test asserts exact object shape with `toEqual`, update that assertion to include `layer`.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/frame-map.ts tests/mcp-server/frame-map-layer.test.ts
git commit -m "feat(frame): /api/frames carries a deterministic layer per frame"
```

---

### Task 4: Frozen cortex fixture + hand-labeled layer regression

Freeze cortex's own frame inputs into a committed JSON fixture and assert hand-labeled expected layers over it. Contested frames assert a *set* of acceptable layers. This is the regression net for the observation phase: every classifier tweak runs against it via `npm test`.

**Files:**
- Create: `scripts/frame-extraction/dump-frame-kind-inputs.ts` (one-shot generator)
- Create: `tests/fixtures/frame-layers/cortex-frames.json` (generated, committed)
- Test: `tests/frame-extraction/expected-layers.test.ts`

- [ ] **Step 1: Write the generator script**

```ts
// scripts/frame-extraction/dump-frame-kind-inputs.ts
/**
 * One-shot fixture generator: pull nodes+edges from a RUNNING cortex viewer's
 * /api/graph, derive FrameKindInput[] exactly the way buildFrameMap does, and
 * print JSON to stdout. Usage:
 *   npx tsx scripts/frame-extraction/dump-frame-kind-inputs.ts \
 *     > tests/fixtures/frame-layers/cortex-frames.json
 * Requires `npm run dev` (or the MCP plugin server) serving localhost:3334/3333.
 */
import { rollupFrameFlows } from "../../src/mcp-server/frame-flow-rollup.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

const BASE = process.env.CORTEX_API ?? "http://localhost:3333";

async function main() {
  const r = await fetch(`${BASE}/api/graph`);
  if (!r.ok) throw new Error(`GET /api/graph → ${r.status}`);
  const { nodes, edges } = (await r.json()) as { nodes: NodeRow[]; edges: EdgeRow[] };

  const byFrame = new Map<number, { frame_id: number; frame_label: string; member_paths: string[] }>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    let d: { frame_id?: number; frame_label?: string };
    try { d = typeof n.data === "string" ? JSON.parse(n.data) : (n.data as object); } catch { continue; }
    if (typeof d.frame_id !== "number") continue;
    let rec = byFrame.get(d.frame_id);
    if (!rec) {
      rec = {
        frame_id: d.frame_id,
        frame_label: typeof d.frame_label === "string" ? d.frame_label : `frame:${d.frame_id}`,
        member_paths: [],
      };
      byFrame.set(d.frame_id, rec);
    }
    rec.member_paths.push(n.file_path);
  }

  const { stats } = rollupFrameFlows(nodes, edges);
  const statsById = new Map(stats.map((s) => [s.frame_id, s]));
  const inputs = [...byFrame.values()]
    .sort((a, b) => a.frame_id - b.frame_id)
    .map((rec) => ({
      ...rec,
      member_paths: [...rec.member_paths].sort(),
      fanIn: statsById.get(rec.frame_id)?.fanIn ?? 0,
      fanOut: statsById.get(rec.frame_id)?.fanOut ?? 0,
    }));
  process.stdout.write(JSON.stringify(inputs, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Generate and commit the fixture**

With the dev server running (`npm run dev` in another shell, or the plugin server on :3333):

```bash
mkdir -p tests/fixtures/frame-layers
npx tsx scripts/frame-extraction/dump-frame-kind-inputs.ts > tests/fixtures/frame-layers/cortex-frames.json
head -20 tests/fixtures/frame-layers/cortex-frames.json
```

Expected: a JSON array of ~15 objects, each `{frame_id, frame_label, member_paths: [...], fanIn, fanOut}`. If the fetch fails, confirm which port serves `/api/graph` (`curl -s localhost:3333/api/graph | head -c 200`) and set `CORTEX_API`.

- [ ] **Step 3: Write the regression test (failing first only if labels mismatch — that's the point)**

Hand labels below reflect the measured analysis (2026-06-12). `anyOf` marks contested frames — the observation phase's watch list. **If the actual fixture's labels differ from the names below (frames drift as the repo evolves), relabel against the actual fixture content using the same judgment, and note contested ones.**

```ts
// tests/frame-extraction/expected-layers.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFramesInternal,
  type FrameKindInput,
  type FrameLayer,
} from "../../src/frame-extraction/frame-kind.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../fixtures/frame-layers/cortex-frames.json");

/** Hand-labeled ground truth over cortex's own frames (2026-06-12).
 *  `anyOf` = contested; the observation phase decides. Keyed by frame_label
 *  (stable across reindexes where frame_id is not). */
const EXPECTED: Record<string, { anyOf: FrameLayer[] }> = {
  "cli":               { anyOf: ["interface"] },
  "mcp":               { anyOf: ["interface", "infrastructure"] },          // contested
  "decisions/seed":    { anyOf: ["orchestration"] },
  "decisions":         { anyOf: ["domain"] },
  "frame-extraction":  { anyOf: ["data", "infrastructure", "domain"] },     // contested (substrate vs core domain)
  "events/worker":     { anyOf: ["data"] },
  "contracts":         { anyOf: ["data", "infrastructure"] },               // substrate pair tie
  "server/frame":      { anyOf: ["infrastructure"] },
  "mcp-server":        { anyOf: ["infrastructure"] },
  "hooks":             { anyOf: ["ceremony"] },
  "evals/assertions":  { anyOf: ["ceremony"] },
  "integration":       { anyOf: ["ceremony"] },
};

describe("expected layers — cortex regression fixture", () => {
  const inputs: FrameKindInput[] = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const results = classifyFramesInternal(inputs);
  const byLabel = new Map(inputs.map((i, idx) => [i.frame_label, results[idx]]));

  for (const [label, exp] of Object.entries(EXPECTED)) {
    it(`${label} → ${exp.anyOf.join(" | ")}`, () => {
      const r = byLabel.get(label);
      if (!r) return; // frame no longer exists on this graph — skip, don't fail
      expect(exp.anyOf).toContain(r.layer);
    });
  }

  it("every frame in the fixture gets a layer (no throws, full coverage)", () => {
    expect(results.length).toBe(inputs.length);
    for (const r of results) expect(typeof r.layer).toBe("string");
  });

  it("agreement report (eval visibility — internals allowed HERE only)", () => {
    // Not an assertion: prints the per-frame verdicts for the observe loop.
    for (const i of inputs) {
      const r = byLabel.get(i.frame_label)!;
      // eslint-disable-next-line no-console
      console.log(
        `${i.frame_label.padEnd(22)} → ${r.layer.padEnd(14)} conf=${r.confidence.toFixed(2)}`,
      );
    }
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: Run it; reconcile labels**

Run: `npx vitest run tests/frame-extraction/expected-layers.test.ts`
Expected: PASS. If a non-contested label fails, inspect the printed agreement report: either the hand label is wrong (fix `EXPECTED`) or the classifier has a genuine bug (fix it — Task 2's unit tests must stay green). Do not widen `anyOf` just to go green; widen only with a written justification in the test comment.

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/dump-frame-kind-inputs.ts \
        tests/fixtures/frame-layers/cortex-frames.json \
        tests/frame-extraction/expected-layers.test.ts
git commit -m "test(frame): frozen cortex fixture + hand-labeled layer regression"
```

---

### Task 5: Viewer — `layers` menu + tint

The viewer change has three parts: menu markup (`index.html`), menu styles (`style.css`), and behavior + tint (`viewer.js`). The legend exists ONLY in the menu. Off (default) = today's exact draw constants. State persists in `localStorage` key `cortex.viewer.layers`.

**Files:**
- Modify: `src/viewer/index.html` (toolbar block, lines 16–21)
- Modify: `src/viewer/style.css` (append menu styles)
- Modify: `src/viewer/viewer.js` (palette + state near color helpers ~line 12–20; FRAMES mapping ~line 117–127; frameMeta ~line 153–158; initToolbar ~line 168–199; frame draw block ~line 925–977)

- [ ] **Step 1: Menu markup in `index.html`**

Replace the toolbar block:

```html
<div class="toolbar">
  <select id="project-select" title="Project">
    <option value="">(loading…)</option>
  </select>
  <div class="layers-wrap">
    <button id="layers-toggle" title="Layer lens">layers</button>
    <div class="layers-menu" id="layers-menu" hidden>
      <div class="lm-toggle" id="layers-switch"><span class="sw"></span>show layers</div>
      <div class="lm-sep"></div>
      <div class="lm-row"><i data-layer="interface"></i>interface</div>
      <div class="lm-row"><i data-layer="orchestration"></i>orchestration</div>
      <div class="lm-row"><i data-layer="domain"></i>domain</div>
      <div class="lm-row"><i data-layer="data"></i>data</div>
      <div class="lm-row"><i data-layer="infrastructure"></i>infrastructure</div>
      <div class="lm-row"><i data-layer="ceremony"></i>ceremony</div>
    </div>
  </div>
  <button id="theme-toggle" title="Toggle light/dark">◐</button>
</div>
```

- [ ] **Step 2: Menu styles in `style.css`** (append at end of file)

```css
/* ── Layers menu (taxonomy milestone 1). Legend lives HERE only. ── */
.layers-wrap { position: relative; }
.layers-menu {
  position: absolute;
  top: 30px;
  right: 0;
  z-index: 40;
  min-width: 148px;
  background: var(--bg-card);
  border: 1px solid var(--border-2);
  border-radius: 4px;
  padding: 5px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-2);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
body.light .layers-menu { box-shadow: 0 8px 20px rgba(0, 0, 0, 0.10); }
.lm-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 7px;
  border-radius: 3px;
  cursor: pointer;
  color: var(--text);
}
.lm-toggle:hover { background: rgba(255, 255, 255, 0.04); }
body.light .lm-toggle:hover { background: rgba(0, 0, 0, 0.04); }
.lm-toggle .sw {
  width: 22px; height: 12px; border-radius: 6px;
  background: var(--border-3);
  position: relative; flex: 0 0 auto;
  transition: background 0.12s;
}
.lm-toggle .sw::after {
  content: '';
  position: absolute; top: 2px; left: 2px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--text-3);
  transition: left 0.12s, background 0.12s;
}
.lm-toggle.on .sw { background: #2f4f3a; }
.lm-toggle.on .sw::after { left: 12px; background: #4ade80; }
.lm-sep { height: 1px; background: var(--border); margin: 5px 2px; }
.lm-row { display: flex; align-items: center; gap: 8px; padding: 4px 7px; color: var(--text-3); }
.lm-row i { width: 6px; height: 6px; border-radius: 1.5px; flex: 0 0 auto; }
.lm-row i[data-layer="interface"]      { background: rgb(92, 161, 237); }
.lm-row i[data-layer="orchestration"]  { background: rgb(171, 130, 237); }
.lm-row i[data-layer="domain"]         { background: rgb(234, 186, 95); }
.lm-row i[data-layer="data"]           { background: rgb(92, 204, 167); }
.lm-row i[data-layer="infrastructure"] { background: rgb(131, 141, 163); }
.lm-row i[data-layer="ceremony"]       { background: rgb(99, 105, 121); }
```

- [ ] **Step 3: `viewer.js` — palette, state, data pass-through**

(a) Near the color helpers (after line ~20, the `countIdleRGB` helper), add:

```js
  // ── Layer lens (taxonomy milestone 1). Palette softened ~20% toward
  // neutral; values pinned by the approved design spec. Off = the exact
  // pre-existing draw constants (pixel-identical).
  const LAYER_RGB = {
    interface:      [92, 161, 237],
    orchestration:  [171, 130, 237],
    domain:         [234, 186, 95],
    data:           [92, 204, 167],
    infrastructure: [131, 141, 163],
    ceremony:       [99, 105, 121],
  };
  const LAYERS_LS_KEY = 'cortex.viewer.layers';
  let layersOn = false;
  try { layersOn = localStorage.getItem(LAYERS_LS_KEY) === '1'; } catch { /* sandboxed */ }
```

(b) In the `FRAMES` mapping (line ~117–127), carry `layer` through:

```js
    FRAMES = (frameMap.frames || [])
      .filter((f) => f.ambient && f.x !== null && f.y !== null)
      .map((f) => ({
        id: String(f.id),
        name: f.name,
        x: f.x / stage.w,
        y: f.y / stage.h,
        w: f.w,
        h: f.h,
        count: f.count,
        layer: f.layer,
      }));
```

(c) In the `frameMeta` map for promoted frames (line ~153–158), carry `layer` so promoted frames tint too — and in `adapters.js` `withGovernedFramesRendered`, pass it through:

```js
    const frameMeta = new Map(
      (frameMap.frames || []).map((f) => [
        String(f.id),
        { name: f.name, w: f.w, h: f.h, count: f.count, layer: f.layer },
      ]),
    );
```

In `src/viewer/adapters.js`, inside `withGovernedFramesRendered`'s `promoted` mapping, add `layer: m.layer,` after `count: m.count || 0,`.

- [ ] **Step 4: `viewer.js` — menu wiring in `initToolbar`** (after the `themeToggle` listener, line ~188)

```js
    const layersBtn = document.getElementById('layers-toggle');
    const layersMenu = document.getElementById('layers-menu');
    const layersSwitch = document.getElementById('layers-switch');
    layersSwitch.classList.toggle('on', layersOn);
    layersBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      layersMenu.hidden = !layersMenu.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!layersMenu.hidden && !layersMenu.contains(e.target) && e.target !== layersBtn) {
        layersMenu.hidden = true;
      }
    });
    layersSwitch.addEventListener('click', () => {
      layersOn = !layersOn;
      layersSwitch.classList.toggle('on', layersOn);
      try { localStorage.setItem(LAYERS_LS_KEY, layersOn ? '1' : '0'); } catch { /* sandboxed */ }
    });
```

(The render loop is a rAF loop reading module state each frame — no explicit re-render call is needed; confirm by reading the `draw()`/`requestAnimationFrame` tail of viewer.js. If draw only runs on demand, call the existing redraw entry point after toggling.)

- [ ] **Step 5: `viewer.js` — tint in the frame draw block** (lines ~928–975)

Replace the three constants ONLY when `layersOn && frame.layer` is set; otherwise the original expressions run untouched:

```js
      const lc = layersOn && frame.layer ? LAYER_RGB[frame.layer] : null;

      const baseFillAlpha = 0.25 * (1 - dimLevel * 0.4);
      const fillAlpha = baseFillAlpha + hoverLevel * 0.18;
      const ff = frameFillRGB();
      const fillAlphaActual = isLight() ? fillAlpha * 0.45 : fillAlpha;
      if (lc) {
        // Layer tint: hue at fixed quiet alpha, scaled by the same dim/hover factors.
        ctx.fillStyle = `rgba(${lc[0]}, ${lc[1]}, ${lc[2]}, ${0.032 * (fillAlphaActual / (isLight() ? 0.25 * 0.45 : 0.25))})`;
      } else {
        ctx.fillStyle = `rgba(${ff[0]}, ${ff[1]}, ${ff[2]}, ${fillAlphaActual})`;
      }
      ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h);
```

For the border (existing `borderAlpha` math stays as the scale factor):

```js
      const fb = frameBorderRGB();
      if (lc) {
        ctx.strokeStyle = `rgba(${lc[0]}, ${lc[1]}, ${lc[2]}, ${0.22 * (borderAlpha / (0.08 * borderAlphaMult))})`;
      } else {
        ctx.strokeStyle = `rgba(${fb[0]}, ${fb[1]}, ${fb[2]}, ${borderAlpha})`;
      }
```

For the label name fill (the `pathText` draw at the end of the block; count keeps its idle color):

```js
      const pl = primaryLabelRGB();
      if (lc) {
        ctx.fillStyle = `rgba(${lc[0]}, ${lc[1]}, ${lc[2]}, ${Math.min(1, 0.55 * (labelAlphaFinal / 0.5))})`;
      } else {
        ctx.fillStyle = `rgba(${pl[0]}, ${pl[1]}, ${pl[2]}, ${labelAlphaFinal})`;
      }
      ctx.fillText(pathText, -f.w / 2, primaryY);
```

The ratio-scaling (`borderAlpha / base`) preserves the existing dim/hover/focus dynamics so focus mode and hover behave identically under the lens. **Nothing else in the draw path changes** — dots, edges, decision pills, marginalia, hover badges all untouched.

- [ ] **Step 6: Quick smoke + full suite**

```bash
npm test
```
Expected: PASS (viewer is plain JS — no unit coverage here; correctness is Task 6's visual QA).

- [ ] **Step 7: Commit**

```bash
git add src/viewer/index.html src/viewer/style.css src/viewer/viewer.js src/viewer/adapters.js
git commit -m "feat(viewer): layers menu — quiet per-layer tint, legend in menu only"
```

---

### Task 6: Gate 0 visual QA + docs

Per `.claude/rules/workflow.md` Gate 0 — this change is render-path-touching, so visual QA is mandatory before review.

**Files:**
- Modify: `docs/architecture/graph-ui.md` (add a short "Layer lens" paragraph)
- Screenshots: `.playwright-mcp/` (gitignored — never the repo root)

- [ ] **Step 1: Baseline screenshot BEFORE checking out the feature build** is impossible mid-branch — instead use the off-state-identity property: capture `layers-off.png` and diff against the pre-change visual (the off path runs the literal original expressions; any visible diff means the guard leaked). Procedure:

```text
1. npm run dev (background); wait for the viewer URL (3334) to respond.
2. Playwright: navigate http://localhost:3334/viewer
3. Screenshot → .playwright-mcp/layers-off.png
4. Assert browser console has no errors.
```

- [ ] **Step 2: Exercise the menu + tint**

```text
5. Click #layers-toggle → menu visible; screenshot → .playwright-mcp/layers-menu.png
   (verify: switch row + 6 legend rows, nothing about confidence/scores)
6. Click #layers-switch → tint on; screenshot → .playwright-mcp/layers-on.png
   (verify: frame borders/fills/labels hued; canvas has NO new elements — no
   legend outside the menu; dots/edges/pills unchanged)
7. Click elsewhere on the canvas → menu closes.
8. Reload the page → tint still on (localStorage). Screenshot → .playwright-mcp/layers-persist.png
9. Open the layers menu, switch off → rendering returns to baseline; compare
   against layers-off.png (must be visually identical).
10. Toggle theme (◐) with layers on → no console errors, tint legible in light mode.
```

Block completion on: console errors, any canvas element added outside the menu, off-state visual drift, or focus/hover regressions (focus a frame with layers on — marginalia pills must render unchanged).

- [ ] **Step 3: API spot-check against the live server**

```bash
curl -s "http://localhost:3334/api/frames" | python3 -c "
import json,sys
d = json.load(sys.stdin)
assert all('layer' in f for f in d['frames']), 'layer missing'
assert not any('confidence' in f or 'contributions' in f for f in d['frames']), 'internals leaked'
print('layers:', sorted({f['layer'] for f in d['frames']}))
"
```
Expected: prints a subset of the six layer names; no assertion errors.

- [ ] **Step 4: Document the lens**

In `docs/architecture/graph-ui.md`, in the frames-viewer section, add:

```markdown
### Layer lens (taxonomy milestone 1)

Every frame carries a deterministic architectural `layer`
(`interface | orchestration | domain | data | infrastructure | ceremony`),
classified at read time in `buildFrameMap` by
[`frame-kind.ts`](../../src/frame-extraction/frame-kind.ts) from directed
frame flows ([`frame-flow-rollup.ts`](../../src/mcp-server/frame-flow-rollup.ts)),
path patterns, and content signals. The viewer's `layers` toolbar menu holds a
show-layers switch and the only legend; when on, frame fill/border/label take
a quiet per-layer hue — when off, rendering is pixel-identical to the lens-less
viewer. Classifier internals (confidence, per-source contributions) are
deliberately never serialized or rendered; they exist only in the eval
harness (`tests/frame-extraction/expected-layers.test.ts`). Ranking and layout
are NOT affected by layers in this milestone (classify → observe → enable;
see the design spec, 2026-06-12).
```

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/graph-ui.md
git commit -m "docs(architecture): document the viewer layer lens"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS, zero regressions.

- [ ] **Step 2: Re-run the layer regression with the agreement report and eyeball it**

Run: `npx vitest run tests/frame-extraction/expected-layers.test.ts`
Expected: PASS; the printed report is the observe-phase watch list — confirm contested frames (`frame-extraction`, `mcp`, `contracts`) read sensibly.

- [ ] **Step 3: Controller hand-off notes (not subagent work)**

After merge, the controller must:
1. Capture the three decisions per the spec's "Decision capture" section (agreement-based combination; read-time placement; no-internals determinism contract), linking `src/frame-extraction/frame-kind.ts` and the spec.
2. Follow the merge protocol: Gate 2 QA, patch version bump + CHANGELOG entry.
3. Restart the MCP server before any post-merge reindex (known dev-reload footgun).

---

## Self-review notes

- **Spec coverage:** determinism contract → Task 2 (constants, canonical order, shuffle test) + Task 3 (negative serialization test) + Task 6 step 3 (live API assert). Architecture units 1–4 → Tasks 1, 2, 3, 5. Eval fixture → Task 4. Gate 0 → Task 6. Out-of-scope slices: untouched by any task ✓.
- **Spec deviation handled:** `TEST_FRACTION_MIN` is 0.8 per the spec amendment (2026-06-12) — the 0.5 draft value misclassified `decisions` as ceremony.
- **Type consistency:** `FrameFlowStats {frame_id, fanIn, fanOut}` (Task 1) ↔ classifier input mapping (Task 3) ✓; `FrameLayer` union spelled identically in Tasks 2/3/4 ✓; viewer reads `f.layer` which Task 3 emits ✓; `classifyFramesInternal` used by Tasks 2 & 4 only ✓.
- **Known judgment point for the implementer:** Task 4's hand labels are keyed by `frame_label` and the live graph may have drifted — the task says relabel against actual fixture content, never widen `anyOf` silently.

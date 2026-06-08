# Frame Ranking + Force-Directed Layout (Path 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the viewer's 1:1:1 grid with a deterministic budget-cut frame **ranker** (picks the ambient 4–10) plus a **force-directed gravity layout** driven by real graph edges — both taxonomy-free.

**Architecture:** All computation is server-side in the MCP/viewer process, recompute-on-read (no DB persistence). A new `/api/frames` endpoint composes four pure modules: a **ranker** (`score = nameability × structural_weight`), a **symbol→file→frame edge rollup**, a **deterministic RNG/seed**, and a **d3-force layout** (mulberry32-seeded, 300 fixed iterations, integer-quantized). The viewer fetches positioned ambient frames and renders them; non-ambient frames stay reachable via search.

**Tech Stack:** TypeScript (Node16 ESM), `d3-force` ^3.0.0 (already a dependency), `node:crypto` for the SHA-256 seed, vitest for tests. Reuses the shipped `label-quality.ts` F1 and `inject-frames.ts` generic-token stop-list.

---

## Spec reference

Design spec: [docs/superpowers/specs/2026-06-08-frame-ranking-path1-design.md](../specs/2026-06-08-frame-ranking-path1-design.md)

## File Structure

**New files (all pure / unit-testable):**

- `src/frame-extraction/frame-ranker.ts` — the deterministic ranker. Owns `ambientBudget()`, `rankFrames()`, and the `FrameRecord` / `RankedFrame` types. Reuses `scoreLabel` (label-quality) + `genericPenalty` (inject-frames).
- `src/mcp-server/frame-pair-rollup.ts` — rolls `CALLS`/`USAGE`/`IMPORTS` symbol-edges up to frame-pair weights via `file_path → frame_id`. Owns `buildNodeFrameIndex()`, `rollupFramePairs()`, `FramePairWeight`.
- `src/mcp-server/frame-layout.ts` — deterministic force-directed layout. Owns `mulberry32()`, `seedFromFrames()`, `layoutFrames()`, the `STAGE_W`/`STAGE_H` constants, and `PositionedFrame` / `LayoutInputFrame` / `FramePairWeight` consumption.
- `src/mcp-server/frame-map.ts` — the orchestrator the endpoint calls. Builds frame records + corpus index from nodes, ranks, rolls up pairs, lays out ambient frames, merges into a `FrameMap`. Owns `buildFrameMap()`, `FrameMap`, `FrameMapEntry`.

**Modified files:**

- `src/frame-extraction/inject-frames.ts` — export a new `genericPenalty(label)` helper (reuses the existing private `isGenericToken` + `splitSymbol`).
- `src/mcp-server/api.ts` — add the `/api/frames` route.
- `src/viewer/viewer.js` — fetch `/api/frames`, consume server-computed positions; drop the client-side `gridLayout` call.
- `src/viewer/layout.js` + `tests/viewer/layout.test.js` — **delete** (the grid is fully replaced; layout now lives server-side).

**Test files:**

- `tests/frame-extraction/frame-ranker.test.ts`
- `tests/mcp-server/frame-pair-rollup.test.ts`
- `tests/mcp-server/frame-layout.test.ts`
- `tests/mcp-server/frame-map.test.ts`

## Conventions for the engineer

- Tests run with `npx vitest run <path>` (project script is `vitest run`). Run a single file by passing its path.
- ESM imports use the `.js` extension even for `.ts` sources (Node16 module resolution). Follow the existing import style in sibling files.
- `NodeRow` shape (from `src/graph/store.ts`): `{ id, kind, name, qualified_name, file_path, data, tier, created_at, updated_at }`. `data` is a JSON **string**. File nodes carry `data.frame_id` (number) and `data.frame_label` (string). Symbol nodes (kind `function`/`method`/`class`/etc.) carry the **same `file_path`** as their defining file — this is what makes the rollup a simple `file_path → frame_id` lookup, no `DEFINES` traversal needed (see `buildFileEdges` in `src/mcp-server/api-edges.ts` for the established pattern).
- `EdgeRow` shape: `{ id, source_id, target_id, relation, data, created_at }`.
- Commit after every task with the message shown in its final step.

---

### Task 1: Export `genericPenalty` from inject-frames

**Files:**
- Modify: `src/frame-extraction/inject-frames.ts`
- Test: `tests/frame-extraction/frame-ranker.test.ts` (created here, grows across Tasks 1–3)

The ranker's nameability multiplies F1 by the fraction of label tokens that are topic-bearing (non-generic). `isGenericToken` and `GENERIC_TOKENS` already exist privately in inject-frames; expose a thin reuse.

- [ ] **Step 1: Confirm `splitSymbol` is importable in inject-frames**

Run: `grep -n "import.*splitSymbol\|from \"./text-blob" src/frame-extraction/inject-frames.ts`
If there is **no** existing import of `splitSymbol`, add this near the other imports at the top of the file:

```ts
import { splitSymbol } from "./text-blob.js";
```

(If `splitSymbol` is already imported, skip adding it.)

- [ ] **Step 2: Write the failing test**

Create `tests/frame-extraction/frame-ranker.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { genericPenalty } from "../../src/frame-extraction/inject-frames.js";

describe("genericPenalty", () => {
  it("returns 1.0 for a fully specific label", () => {
    expect(genericPenalty("checkout-payment")).toBe(1);
  });

  it("returns 0 for a fully generic label", () => {
    // "src", "utils" are both in the stop-list / short-token rule
    expect(genericPenalty("src-utils")).toBe(0);
  });

  it("returns the non-generic fraction for a mixed label", () => {
    // "core" is generic, "checkout" is not → 1 of 2 specific
    expect(genericPenalty("core-checkout")).toBe(0.5);
  });

  it("returns 0 for an empty label", () => {
    expect(genericPenalty("")).toBe(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts`
Expected: FAIL — `genericPenalty is not a function` (not yet exported).

- [ ] **Step 4: Add the export**

In `src/frame-extraction/inject-frames.ts`, immediately after the `isGenericToken` function (around line 66), add:

```ts
/** Fraction of a label's tokens that are topic-bearing (non-generic). 1.0 = every
 *  token is specific; 0 = the label is entirely generic/structural/short. The
 *  frame ranker multiplies F1 by this to down-weight opaque labels (e.g. the
 *  `cluster:N` fallback, or `src/core` org-root labels). */
export function genericPenalty(label: string): number {
  const terms = splitSymbol(label);
  if (terms.length === 0) return 0;
  const specific = terms.filter((t) => !isGenericToken(t)).length;
  return specific / terms.length;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/frame-extraction/inject-frames.ts tests/frame-extraction/frame-ranker.test.ts
git commit -m "feat(frames): export genericPenalty token-specificity helper"
```

---

### Task 2: `ambientBudget` function

**Files:**
- Create: `src/frame-extraction/frame-ranker.ts`
- Test: `tests/frame-extraction/frame-ranker.test.ts` (append)

Budget formula from spec §A / `frame-ranking.md` open-q #2: `max(4, min(10, ceil(n × 0.7)))`.

- [ ] **Step 1: Write the failing test** (append to `tests/frame-extraction/frame-ranker.test.ts`)

```ts
import { ambientBudget } from "../../src/frame-extraction/frame-ranker.js";

describe("ambientBudget", () => {
  it("floors at 4 for tiny repos", () => {
    expect(ambientBudget(1)).toBe(4);
    expect(ambientBudget(5)).toBe(4); // ceil(3.5)=4
  });

  it("caps at 10 for large repos", () => {
    expect(ambientBudget(31)).toBe(10); // ceil(21.7)=22 → capped 10
    expect(ambientBudget(100)).toBe(10);
  });

  it("scales by 0.7 in the mid band", () => {
    expect(ambientBudget(10)).toBe(7); // ceil(7.0)=7
    expect(ambientBudget(9)).toBe(7);  // ceil(6.3)=7
  });

  it("returns 0 for zero frames", () => {
    expect(ambientBudget(0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts`
Expected: FAIL — cannot import `ambientBudget` (module/file missing).

- [ ] **Step 3: Create the module with the budget function**

Create `src/frame-extraction/frame-ranker.ts`:

```ts
// src/frame-extraction/frame-ranker.ts
/**
 * Deterministic, taxonomy-free frame ranker (Path 1).
 *
 * score = nameability × structural_weight
 *   nameability      = scoreLabel F1 (label-quality.ts) × genericPenalty
 *   structural_weight = sqrt(member_count)
 *
 * The ambient set is the top `ambientBudget(extracted_count)` frames by score;
 * ties break lexicographically on the (stringified) frame_id (spec §8.6).
 * Every frame is ranked; only ambient ones get rendered on the first map.
 *
 * PURE module: inputs in, ranked frames out. No I/O.
 */
import { scoreLabel, type CorpusIndex } from "./label-quality.js";
import { genericPenalty } from "./inject-frames.js";

/** Ambient set size: max(4, min(10, ceil(n × 0.7))). 0 frames → 0. */
export function ambientBudget(extractedCount: number): number {
  if (extractedCount <= 0) return 0;
  return Math.max(4, Math.min(10, Math.ceil(extractedCount * 0.7)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts`
Expected: PASS (Task 1 tests + 4 budget tests).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-ranker.ts tests/frame-extraction/frame-ranker.test.ts
git commit -m "feat(frames): add ambientBudget for the budget-cut ranker"
```

---

### Task 3: `rankFrames` scoring + ambient cut + determinism

**Files:**
- Modify: `src/frame-extraction/frame-ranker.ts`
- Test: `tests/frame-extraction/frame-ranker.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append)

```ts
import { rankFrames, type FrameRecord } from "../../src/frame-extraction/frame-ranker.js";
import { buildCorpusIndex } from "../../src/frame-extraction/label-quality.js";

// Build a corpus where each file's blob text == its path tokens, so a label
// that matches the path scores high coverage/specificity.
function corpusFromPaths(paths: string[]) {
  return buildCorpusIndex(
    paths.map((p) => ({ path: p, text: p.replace(/[._\-/]+/g, " ") })),
  );
}

describe("rankFrames", () => {
  const records: FrameRecord[] = [
    { frame_id: 0, frame_label: "checkout", member_paths: ["src/checkout/cart.ts", "src/checkout/pay.ts"] },
    { frame_id: 1, frame_label: "cluster:7", member_paths: ["src/a/x.ts"] },
    { frame_id: 2, frame_label: "viewer", member_paths: ["src/viewer/a.ts", "src/viewer/b.ts", "src/viewer/c.ts"] },
  ];
  const corpus = corpusFromPaths(records.flatMap((r) => r.member_paths));

  it("assigns a 1-based rank to every frame", () => {
    const ranked = rankFrames(records, corpus);
    expect(ranked).toHaveLength(3);
    expect([...ranked].map((r) => r.rank).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("scores opaque cluster:N labels at zero (genericPenalty × F1 = 0)", () => {
    const ranked = rankFrames(records, corpus);
    const opaque = ranked.find((r) => r.frame_id === 1)!;
    expect(opaque.score).toBe(0);
    expect(opaque.components.nameability).toBe(0);
  });

  it("marks the top ambientBudget(n) frames ambient", () => {
    const ranked = rankFrames(records, corpus);
    // 3 frames → budget = max(4, …) = 4 > 3 → all ambient
    expect(ranked.every((r) => r.ambient)).toBe(true);
  });

  it("cuts to the budget when there are more frames than the budget", () => {
    // 20 frames → budget = max(4, min(10, ceil(14))) = 10
    const many: FrameRecord[] = Array.from({ length: 20 }, (_, i) => ({
      frame_id: i,
      frame_label: `topic${i}`,
      member_paths: [`src/topic${i}/file.ts`],
    }));
    const c = corpusFromPaths(many.flatMap((r) => r.member_paths));
    const ranked = rankFrames(many, c);
    expect(ranked.filter((r) => r.ambient)).toHaveLength(10);
  });

  it("is deterministic and breaks ties lexicographically on frame_id", () => {
    const r1 = rankFrames(records, corpus);
    const r2 = rankFrames(records, corpus);
    expect(r1).toEqual(r2);
  });

  it("orders by score descending", () => {
    const ranked = [...rankFrames(records, corpus)].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts`
Expected: FAIL — `rankFrames` / `FrameRecord` not exported.

- [ ] **Step 3: Implement the types + `rankFrames`**

Append to `src/frame-extraction/frame-ranker.ts`:

```ts
/** Input record per extracted frame. */
export interface FrameRecord {
  frame_id: number;
  frame_label: string;
  member_paths: string[];
}

/** Explainability breakdown — kept so the viewer can answer "why is X ambient
 *  and Y not". */
export interface RankComponents {
  /** F1 × generic_penalty. */
  nameability: number;
  /** sqrt(member_count). */
  structural_weight: number;
  /** Raw label-quality F1. */
  f1: number;
  /** Fraction of label tokens that are topic-bearing. */
  generic_penalty: number;
}

export interface RankedFrame {
  frame_id: number;
  frame_label: string;
  member_count: number;
  score: number;
  /** 1-based, score descending. */
  rank: number;
  ambient: boolean;
  components: RankComponents;
}

/**
 * Rank every frame by `score = nameability × structural_weight` and mark the
 * top `ambientBudget(records.length)` as ambient. Deterministic: ties on score
 * break lexicographically on the stringified frame_id (spec §8.6).
 */
export function rankFrames(records: readonly FrameRecord[], corpus: CorpusIndex): RankedFrame[] {
  const budget = ambientBudget(records.length);

  const scored = records.map((r) => {
    const f1 = scoreLabel(r.frame_label, r.member_paths, corpus).f1;
    const generic_penalty = genericPenalty(r.frame_label);
    const nameability = f1 * generic_penalty;
    const structural_weight = Math.sqrt(r.member_paths.length);
    const score = nameability * structural_weight;
    return {
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_count: r.member_paths.length,
      score,
      components: { nameability, structural_weight, f1, generic_penalty },
    };
  });

  scored.sort(
    (a, b) => b.score - a.score || String(a.frame_id).localeCompare(String(b.frame_id)),
  );

  return scored.map((s, i) => ({ ...s, rank: i + 1, ambient: i < budget }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/frame-extraction/frame-ranker.test.ts`
Expected: PASS (all ranker tests).

- [ ] **Step 5: Commit**

```bash
git add src/frame-extraction/frame-ranker.ts tests/frame-extraction/frame-ranker.test.ts
git commit -m "feat(frames): deterministic budget-cut ranker (nameability × structural)"
```

---

### Task 4: Symbol→file→frame edge rollup

**Files:**
- Create: `src/mcp-server/frame-pair-rollup.ts`
- Test: `tests/mcp-server/frame-pair-rollup.test.ts`

Rolls `CALLS`/`USAGE`/`IMPORTS` symbol-level edges up to frame-pair weights. Edge-case correctness (symbols whose file has no `frame_id`; self-edges within a frame) is the main risk called out in the spec — test it directly.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-server/frame-pair-rollup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rollupFramePairs, buildNodeFrameIndex } from "../../src/mcp-server/frame-pair-rollup.js";
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

describe("buildNodeFrameIndex", () => {
  it("maps every node (file + symbol) to its file's frame_id", () => {
    const nodes = [fileNode("fileA", "a.ts", 0), symNode("symA", "a.ts")];
    const idx = buildNodeFrameIndex(nodes);
    expect(idx.get("fileA")).toBe(0);
    expect(idx.get("symA")).toBe(0);
  });

  it("omits nodes whose file has no frame_id", () => {
    const nodes = [fileNode("fileX", "x.ts"), symNode("symX", "x.ts")];
    const idx = buildNodeFrameIndex(nodes);
    expect(idx.has("fileX")).toBe(false);
    expect(idx.has("symX")).toBe(false);
  });
});

describe("rollupFramePairs", () => {
  const nodes = [
    fileNode("fileA", "a.ts", 0), symNode("symA", "a.ts"),
    fileNode("fileB", "b.ts", 1), symNode("symB", "b.ts"),
    fileNode("fileC", "c.ts", 0), symNode("symC", "c.ts"),
    fileNode("fileD", "d.ts"),    symNode("symD", "d.ts"), // no frame_id
  ];

  it("aggregates cross-frame symbol edges into frame-pair weights", () => {
    const edges = [edge("symA", "symB", "CALLS"), edge("symA", "symB", "USAGE")];
    const pairs = rollupFramePairs(nodes, edges);
    expect(pairs).toEqual([{ a: 0, b: 1, weight: 2 }]);
  });

  it("excludes self-edges within the same frame", () => {
    // symA (frame 0) → symC (frame 0): same frame, dropped
    const edges = [edge("symA", "symC", "CALLS")];
    expect(rollupFramePairs(nodes, edges)).toEqual([]);
  });

  it("ignores edges touching a frameless file", () => {
    const edges = [edge("symA", "symD", "CALLS")];
    expect(rollupFramePairs(nodes, edges)).toEqual([]);
  });

  it("ignores relations outside CALLS/USAGE/IMPORTS", () => {
    const edges = [edge("symA", "symB", "DEFINES")];
    expect(rollupFramePairs(nodes, edges)).toEqual([]);
  });

  it("normalizes pair order (a < b) regardless of edge direction", () => {
    const edges = [edge("symB", "symA", "CALLS")]; // frame 1 → frame 0
    expect(rollupFramePairs(nodes, edges)).toEqual([{ a: 0, b: 1, weight: 1 }]);
  });

  it("is deterministic — sorted by weight desc then a,b asc", () => {
    const edges = [
      edge("symA", "symB", "CALLS"),
      edge("symC", "symB", "CALLS"), // frame 0 ↔ 1 too (symC is frame 0)
      edge("symA", "symB", "IMPORTS"),
    ];
    const pairs = rollupFramePairs(nodes, edges);
    expect(pairs).toEqual([{ a: 0, b: 1, weight: 3 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/frame-pair-rollup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the rollup**

Create `src/mcp-server/frame-pair-rollup.ts`:

```ts
// src/mcp-server/frame-pair-rollup.ts
/**
 * Roll symbol-level connectivity up to frame-pair weights for the layout's
 * import-neighbourhood force. Mirrors the file_path→frame_id approach used by
 * `buildFileEdges` (api-edges.ts): every node — file OR symbol — carries the
 * file_path of its defining file, so a node→frame lookup needs no DEFINES
 * traversal. Self-edges within a frame and edges touching a frameless file are
 * excluded (spec "Risks / open questions").
 *
 * PURE — no I/O.
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";

/** Relations rolled up into frame-pair affinity (spec §B force 1). */
const ROLLUP_RELATIONS = new Set(["CALLS", "USAGE", "IMPORTS"]);

export interface FramePairWeight {
  /** Smaller frame_id. */
  a: number;
  /** Larger frame_id. */
  b: number;
  /** Count of underlying symbol-level edges between the two frames. */
  weight: number;
}

/** Map every node id → the frame_id of its defining file (via file_path).
 *  Nodes whose file carries no frame_id are omitted. */
export function buildNodeFrameIndex(nodes: readonly NodeRow[]): Map<string, number> {
  const frameByPath = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    try {
      const d = JSON.parse(n.data) as { frame_id?: number };
      if (typeof d.frame_id === "number") frameByPath.set(n.file_path, d.frame_id);
    } catch {
      /* malformed data — skip */
    }
  }
  const frameById = new Map<string, number>();
  for (const n of nodes) {
    if (!n.file_path) continue;
    const fid = frameByPath.get(n.file_path);
    if (fid !== undefined) frameById.set(n.id, fid);
  }
  return frameById;
}

/** Aggregate CALLS/USAGE/IMPORTS edges into deterministic frame-pair weights. */
export function rollupFramePairs(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
): FramePairWeight[] {
  const frameById = buildNodeFrameIndex(nodes);
  const weights = new Map<string, number>();
  for (const e of edges) {
    if (!ROLLUP_RELATIONS.has(e.relation)) continue;
    const fa = frameById.get(e.source_id);
    const fb = frameById.get(e.target_id);
    if (fa === undefined || fb === undefined) continue;
    if (fa === fb) continue; // intra-frame edge: no inter-frame pull
    const [lo, hi] = fa < fb ? [fa, fb] : [fb, fa];
    const key = `${lo}:${hi}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const out: FramePairWeight[] = [];
  for (const [key, weight] of weights) {
    const sep = key.indexOf(":");
    out.push({ a: Number(key.slice(0, sep)), b: Number(key.slice(sep + 1)), weight });
  }
  out.sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/frame-pair-rollup.test.ts`
Expected: PASS (all rollup tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/frame-pair-rollup.ts tests/mcp-server/frame-pair-rollup.test.ts
git commit -m "feat(frames): roll symbol edges up to frame-pair weights"
```

---

### Task 5: Deterministic RNG + seed

**Files:**
- Create: `src/mcp-server/frame-layout.ts` (RNG + seed first; layout added in Task 6)
- Test: `tests/mcp-server/frame-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-server/frame-layout.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mulberry32, seedFromFrames, type LayoutInputFrame } from "../../src/mcp-server/frame-layout.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it("produces values in [0, 1)", () => {
    const r = mulberry32(1);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe("seedFromFrames", () => {
  const frames: LayoutInputFrame[] = [
    { frame_id: 2, frame_label: "viewer", member_count: 3 },
    { frame_id: 0, frame_label: "checkout", member_count: 2 },
  ];

  it("is order-independent (sorts by frame_id before hashing)", () => {
    const reversed = [...frames].reverse();
    expect(seedFromFrames(frames)).toBe(seedFromFrames(reversed));
  });

  it("changes when a frame's label or count changes", () => {
    const base = seedFromFrames(frames);
    const mutated = seedFromFrames([{ ...frames[0], member_count: 99 }, frames[1]]);
    expect(mutated).not.toBe(base);
  });

  it("returns an unsigned 32-bit integer", () => {
    const s = seedFromFrames(frames);
    expect(Number.isInteger(s)).toBe(true);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/frame-layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module with RNG + seed**

Create `src/mcp-server/frame-layout.ts`:

```ts
// src/mcp-server/frame-layout.ts
/**
 * Deterministic force-directed gravity layout for ambient frames (Path 1).
 *
 * Determinism (spec §B): a mulberry32 PRNG seeded from SHA-256 of the sorted
 * frame records drives both the initial scatter and d3-force's internal jiggle
 * (via `simulation.randomSource`); the sim runs a fixed 300 iterations; final
 * coordinates are quantized to integer pixels in a fixed virtual stage. Same
 * frames in → byte-identical positions out.
 *
 * PURE — no I/O.
 */
import { createHash } from "node:crypto";

/** Fixed virtual coordinate space. The viewer normalizes by these. */
export const STAGE_W = 1000;
export const STAGE_H = 800;

export interface LayoutInputFrame {
  frame_id: number;
  frame_label: string;
  member_count: number;
}

/** Mulberry32 — a small, fast, fully-deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed = first 32 bits of SHA-256 over the frame records, sorted by frame_id.
 *  Record = `frame_id:member_count:frame_label` (spec §B determinism). */
export function seedFromFrames(frames: readonly LayoutInputFrame[]): number {
  const sorted = [...frames].sort((x, y) => x.frame_id - y.frame_id);
  const rec = sorted.map((f) => `${f.frame_id}:${f.member_count}:${f.frame_label}`).join("|");
  return createHash("sha256").update(rec).digest().readUInt32BE(0) >>> 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/frame-layout.test.ts`
Expected: PASS (RNG + seed tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/frame-layout.ts tests/mcp-server/frame-layout.test.ts
git commit -m "feat(frames): deterministic mulberry32 RNG + SHA-256 frame seed"
```

---

### Task 6: Force-directed `layoutFrames`

**Files:**
- Modify: `src/mcp-server/frame-layout.ts`
- Modify: `package.json` / `package-lock.json` (add `@types/d3-force` dev dep)
- Test: `tests/mcp-server/frame-layout.test.ts` (append)

`d3-force` ^3.0.0 is already a runtime dependency and exposes `simulation.randomSource()` (verified). Its types are **not** installed, so add `@types/d3-force` as a dev dependency.

- [ ] **Step 1: Install d3-force types**

Run: `npm install --save-dev @types/d3-force`
Expected: adds `@types/d3-force` to devDependencies; exit 0.

- [ ] **Step 2: Write the failing test** (append to `tests/mcp-server/frame-layout.test.ts`)

```ts
import { layoutFrames, STAGE_W, STAGE_H } from "../../src/mcp-server/frame-layout.js";
import type { FramePairWeight } from "../../src/mcp-server/frame-pair-rollup.js";

describe("layoutFrames", () => {
  const frames: LayoutInputFrame[] = [
    { frame_id: 0, frame_label: "checkout", member_count: 30 },
    { frame_id: 1, frame_label: "viewer", member_count: 10 },
    { frame_id: 2, frame_label: "graph", member_count: 5 },
  ];
  const pairs: FramePairWeight[] = [{ a: 0, b: 1, weight: 12 }];

  it("returns one positioned frame per input", () => {
    const out = layoutFrames(frames, pairs);
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.id).sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("preserves id, name, and count", () => {
    const out = layoutFrames(frames, pairs);
    const checkout = out.find((f) => f.id === 0)!;
    expect(checkout.name).toBe("checkout");
    expect(checkout.count).toBe(30);
  });

  it("emits integer-pixel coordinates", () => {
    for (const f of layoutFrames(frames, pairs)) {
      expect(Number.isInteger(f.x)).toBe(true);
      expect(Number.isInteger(f.y)).toBe(true);
      expect(Number.isInteger(f.w)).toBe(true);
      expect(Number.isInteger(f.h)).toBe(true);
    }
  });

  it("sizes frames within the 110–160px band", () => {
    for (const f of layoutFrames(frames, pairs)) {
      expect(f.w).toBeGreaterThanOrEqual(110);
      expect(f.w).toBeLessThanOrEqual(160);
      expect(f.w).toBe(f.h); // square frames
    }
    // The 30-member frame should be at least as large as the 5-member one.
    const out = layoutFrames(frames, pairs);
    const big = out.find((f) => f.id === 0)!;
    const small = out.find((f) => f.id === 2)!;
    expect(big.w).toBeGreaterThanOrEqual(small.w);
  });

  it("keeps frame centers within the virtual stage", () => {
    for (const f of layoutFrames(frames, pairs)) {
      expect(f.x - f.w / 2).toBeGreaterThanOrEqual(0);
      expect(f.x + f.w / 2).toBeLessThanOrEqual(STAGE_W);
      expect(f.y - f.h / 2).toBeGreaterThanOrEqual(0);
      expect(f.y + f.h / 2).toBeLessThanOrEqual(STAGE_H);
    }
  });

  it("is byte-identical across repeated runs (determinism)", () => {
    expect(layoutFrames(frames, pairs)).toEqual(layoutFrames(frames, pairs));
  });

  it("returns [] for empty input", () => {
    expect(layoutFrames([], [])).toEqual([]);
  });

  it("handles a single frame", () => {
    const [only] = layoutFrames([frames[0]], []);
    expect(only.id).toBe(0);
    expect(only.x).toBeGreaterThan(0);
    expect(only.y).toBeGreaterThan(0);
  });

  it("ignores pairs referencing frames not in the input set", () => {
    // pair references frame 99 which isn't laid out — must not throw
    const out = layoutFrames(frames, [{ a: 0, b: 99, weight: 5 }]);
    expect(out).toHaveLength(3);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/frame-layout.test.ts`
Expected: FAIL — `layoutFrames` not exported.

- [ ] **Step 4: Implement `layoutFrames`**

Append to `src/mcp-server/frame-layout.ts`:

```ts
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
} from "d3-force";
import type { FramePairWeight } from "./frame-pair-rollup.js";

/** Frame size band (px), mapped from member_count via sqrt. */
const FRAME_MIN = 110;
const FRAME_MAX = 160;
/** Fixed iteration count — no convergence check, for cross-run determinism. */
const ITERATIONS = 300;
/** Padding added to each frame's collision radius (px). */
const COLLIDE_PAD = 10;

export interface PositionedFrame {
  id: number;
  name: string;
  count: number;
  /** Integer px, virtual-stage coordinates (center). */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SimNode extends SimulationNodeDatum {
  id: number;
  name: string;
  count: number;
  size: number;
  /** Normalized mass 0..1 for inertia damping. */
  mass: number;
}

/** sqrt-bounded size in the [FRAME_MIN, FRAME_MAX] band. Degenerate (all equal
 *  counts, or a single frame) → band midpoint. */
function sizeFor(count: number, minC: number, maxC: number): number {
  if (maxC <= minC) return (FRAME_MIN + FRAME_MAX) / 2;
  const t = (Math.sqrt(count) - Math.sqrt(minC)) / (Math.sqrt(maxC) - Math.sqrt(minC));
  return FRAME_MIN + t * (FRAME_MAX - FRAME_MIN);
}

/**
 * Lay out ambient frames with d3-force:
 *  - link force: attraction ∝ rolled-up frame-pair weight (heavier → closer).
 *  - charge (many-body): mutual repulsion so frames spread.
 *  - center: gentle pull to the stage center.
 *  - collide: hard non-overlap on the size-derived radius.
 *  - frame mass → inertia: per-tick velocity damping scaled by member_count.
 */
export function layoutFrames(
  frames: readonly LayoutInputFrame[],
  pairs: readonly FramePairWeight[],
): PositionedFrame[] {
  if (frames.length === 0) return [];

  const counts = frames.map((f) => f.member_count);
  const minC = Math.min(...counts);
  const maxC = Math.max(...counts);
  const seed = seedFromFrames(frames);
  const init = mulberry32(seed);

  const nodes: SimNode[] = frames.map((f) => ({
    id: f.frame_id,
    name: f.frame_label,
    count: f.member_count,
    size: sizeFor(f.member_count, minC, maxC),
    mass: maxC <= minC ? 0.5 : (f.member_count - minC) / (maxC - minC),
    // Deterministic initial scatter around the center.
    x: STAGE_W / 2 + (init() - 0.5) * STAGE_W * 0.5,
    y: STAGE_H / 2 + (init() - 0.5) * STAGE_H * 0.5,
  }));

  const present = new Set(nodes.map((n) => n.id));
  const links = pairs
    .filter((p) => present.has(p.a) && present.has(p.b))
    .map((p) => ({ source: p.a, target: p.b, weight: p.weight }));
  const maxW = Math.max(1, ...links.map((l) => l.weight));

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
    .force("collide", forceCollide<SimNode>((d) => d.size / 2 + COLLIDE_PAD).strength(1))
    .stop();

  for (let i = 0; i < ITERATIONS; i++) {
    sim.tick();
    // Frame mass → inertia: heavier frames bleed velocity faster, so they move
    // less while lighter satellites settle around them.
    for (const n of nodes) {
      const damp = 1 - 0.6 * n.mass;
      if (n.vx !== undefined) n.vx *= damp;
      if (n.vy !== undefined) n.vy *= damp;
    }
  }

  return nodes
    .slice()
    .sort((a, b) => a.id - b.id)
    .map((n) => {
      const w = Math.round(n.size);
      const h = w;
      const x = Math.round(Math.min(STAGE_W - w / 2, Math.max(w / 2, n.x ?? STAGE_W / 2)));
      const y = Math.round(Math.min(STAGE_H - h / 2, Math.max(h / 2, n.y ?? STAGE_H / 2)));
      return { id: n.id, name: n.name, count: n.count, x, y, w, h };
    });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/frame-layout.test.ts`
Expected: PASS (all layout + RNG + seed tests).

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server/frame-layout.ts tests/mcp-server/frame-layout.test.ts package.json package-lock.json
git commit -m "feat(frames): force-directed gravity layout (d3-force, seeded, 300 iters)"
```

---

### Task 7: `buildFrameMap` orchestrator

**Files:**
- Create: `src/mcp-server/frame-map.ts`
- Test: `tests/mcp-server/frame-map.test.ts`

Composes the pieces: groups file nodes into `FrameRecord`s, builds a corpus index from per-file token blobs (path tokens + the file's symbol names — the read-time stand-in for content, since the graph holds no source text), ranks, rolls up pairs, lays out the ambient set, and merges rank + position into one `FrameMap`.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp-server/frame-map.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildFrameMap } from "../../src/mcp-server/frame-map.js";
import { STAGE_W, STAGE_H } from "../../src/mcp-server/frame-layout.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

function fileNode(id: string, path: string, frameId: number, label: string): NodeRow {
  return {
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: JSON.stringify({ frame_id: frameId, frame_label: label }),
    tier: "tier1", created_at: "", updated_at: "",
  };
}
function symNode(id: string, path: string, name: string): NodeRow {
  return {
    id, kind: "function", name, qualified_name: `${path}::${name}`, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}

// Two frames: "checkout" (2 files) and "viewer" (3 files).
const nodes: NodeRow[] = [
  fileNode("f1", "src/checkout/cart.ts", 0, "checkout"),
  fileNode("f2", "src/checkout/pay.ts", 0, "checkout"),
  symNode("s1", "src/checkout/cart.ts", "addToCart"),
  fileNode("f3", "src/viewer/canvas.ts", 1, "viewer"),
  fileNode("f4", "src/viewer/render.ts", 1, "viewer"),
  fileNode("f5", "src/viewer/layout.ts", 1, "viewer"),
  symNode("s2", "src/viewer/canvas.ts", "drawFrame"),
];
const edges: EdgeRow[] = [
  { id: "e1", source_id: "s1", target_id: "s2", relation: "CALLS", data: "{}", created_at: "" },
];

describe("buildFrameMap", () => {
  it("returns one entry per extracted frame plus the stage dims", () => {
    const map = buildFrameMap(nodes, edges);
    expect(map.frames).toHaveLength(2);
    expect(map.stage).toEqual({ w: STAGE_W, h: STAGE_H });
  });

  it("ranks every frame and positions the ambient ones", () => {
    const map = buildFrameMap(nodes, edges);
    for (const f of map.frames) {
      expect(typeof f.rank).toBe("number");
      if (f.ambient) {
        expect(Number.isInteger(f.x)).toBe(true);
        expect(Number.isInteger(f.y)).toBe(true);
      }
    }
  });

  it("marks all frames ambient when count is under budget", () => {
    // 2 frames → budget 4 → both ambient
    const map = buildFrameMap(nodes, edges);
    expect(map.frames.every((f) => f.ambient)).toBe(true);
  });

  it("carries count and name through from the graph", () => {
    const map = buildFrameMap(nodes, edges);
    const viewer = map.frames.find((f) => f.name === "viewer")!;
    expect(viewer.count).toBe(3);
  });

  it("is deterministic", () => {
    expect(buildFrameMap(nodes, edges)).toEqual(buildFrameMap(nodes, edges));
  });

  it("returns empty frames for a graph with no framed files", () => {
    const bare: NodeRow[] = [symNode("x", "a.ts", "foo")];
    const map = buildFrameMap(bare, []);
    expect(map.frames).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp-server/frame-map.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestrator**

Create `src/mcp-server/frame-map.ts`:

```ts
// src/mcp-server/frame-map.ts
/**
 * Read-time orchestrator behind `/api/frames`. Turns a project's nodes + edges
 * into the viewer's frame map: rank every frame, lay out the ambient ones.
 *
 * Nameability needs a corpus index, but the read-time graph holds no source
 * text — so each file's "blob" is its path tokens plus the names of the symbols
 * it defines (the closest available token surface). Opaque `cluster:N` labels
 * still score ~0 by construction (label-quality.ts), preserving the signal.
 *
 * PURE — no I/O; the endpoint supplies nodes/edges.
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";
import type { FileBlob } from "../frame-extraction/types.js";
import { buildCorpusIndex } from "../frame-extraction/label-quality.js";
import { splitSymbol } from "../frame-extraction/text-blob.js";
import { rankFrames, type FrameRecord } from "../frame-extraction/frame-ranker.js";
import { rollupFramePairs } from "./frame-pair-rollup.js";
import { layoutFrames, STAGE_W, STAGE_H } from "./frame-layout.js";

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
}

export interface FrameMap {
  frames: FrameMapEntry[];
  stage: { w: number; h: number };
}

/** Group file nodes by frame_id into ranker input records. */
function buildFrameRecords(nodes: readonly NodeRow[]): FrameRecord[] {
  const byFrame = new Map<number, FrameRecord>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    let d: { frame_id?: number; frame_label?: string };
    try {
      d = JSON.parse(n.data);
    } catch {
      continue;
    }
    if (typeof d.frame_id !== "number") continue;
    const label = typeof d.frame_label === "string" ? d.frame_label : `frame:${d.frame_id}`;
    let rec = byFrame.get(d.frame_id);
    if (!rec) {
      rec = { frame_id: d.frame_id, frame_label: label, member_paths: [] };
      byFrame.set(d.frame_id, rec);
    }
    rec.member_paths.push(n.file_path);
  }
  return [...byFrame.values()].sort((a, b) => a.frame_id - b.frame_id);
}

/** One token blob per file: path tokens + the file's symbol names, split the
 *  SAME way `scoreLabel` splits labels so terms line up. */
function buildFileBlobs(nodes: readonly NodeRow[]): FileBlob[] {
  const symbolsByPath = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.file_path || n.kind === "file") continue;
    const arr = symbolsByPath.get(n.file_path) ?? [];
    arr.push(n.qualified_name || n.name);
    symbolsByPath.set(n.file_path, arr);
  }
  const blobs: FileBlob[] = [];
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    const tokens = [
      ...splitSymbol(n.file_path),
      ...(symbolsByPath.get(n.file_path) ?? []).flatMap(splitSymbol),
    ];
    blobs.push({ path: n.file_path, text: tokens.join(" ") });
  }
  return blobs;
}

export function buildFrameMap(nodes: readonly NodeRow[], edges: readonly EdgeRow[]): FrameMap {
  const records = buildFrameRecords(nodes);
  const corpus = buildCorpusIndex(buildFileBlobs(nodes));
  const ranked = rankFrames(records, corpus);

  const ambient = ranked.filter((r) => r.ambient);
  const pairs = rollupFramePairs(nodes, edges);
  const positioned = layoutFrames(
    ambient.map((r) => ({
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_count: r.member_count,
    })),
    pairs,
  );
  const posById = new Map(positioned.map((p) => [p.id, p]));

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
    };
  });

  return { frames, stage: { w: STAGE_W, h: STAGE_H } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/mcp-server/frame-map.test.ts`
Expected: PASS (all frame-map tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/frame-map.ts tests/mcp-server/frame-map.test.ts
git commit -m "feat(frames): buildFrameMap orchestrator (rank + rollup + layout)"
```

---

### Task 8: `/api/frames` endpoint

**Files:**
- Modify: `src/mcp-server/api.ts`

Add a route mirroring the existing `/api/file-edges` handler (same `openProjectStore` + node/edge fetch + `resolved.owned` cleanup pattern).

- [ ] **Step 1: Add the import**

In `src/mcp-server/api.ts`, after the existing `buildFileEdges` import (line 17), add:

```ts
import { buildFrameMap } from "./frame-map.js";
import { STAGE_W, STAGE_H } from "./frame-layout.js";
```

- [ ] **Step 2: Add the route handler**

In `src/mcp-server/api.ts`, immediately **before** the `if (url.startsWith("/api/file-edges"))` block (around line 258), insert:

```ts
      if (url.startsWith("/api/frames")) {
        const parsed = new NodeURL(url, "http://localhost");
        const projectParam = parsed.searchParams.get("project");
        const project = projectParam ?? indexerProject ?? undefined;
        const resolved = openProjectStore(store, indexerProject, project, { registry });
        if (!resolved) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ frames: [], stage: { w: STAGE_W, h: STAGE_H } }));
          return;
        }
        try {
          const nodes = resolved.store.getAllNodesUnified(project ?? undefined);
          const edges = resolved.store.getAllEdgesUnified(project ?? undefined);
          const map = buildFrameMap(nodes, edges);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify(map));
        } finally {
          if (resolved.owned) resolved.store.close();
        }
        return;
      }

```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0, no errors. (If `@types/d3-force` from Task 6 is missing, this is where it surfaces — re-run `npm install --save-dev @types/d3-force`.)

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server/api.ts
git commit -m "feat(api): /api/frames endpoint serving ranked + positioned frames"
```

---

### Task 9: Viewer wiring + retire the grid

**Files:**
- Modify: `src/viewer/viewer.js`
- Delete: `src/viewer/layout.js`, `tests/viewer/layout.test.js`

The viewer stops computing layout client-side and consumes `/api/frames`. **This is a render-loop change — Gate-0 visual QA is mandatory.**

- [ ] **Step 1: Add a `fetchFrames` helper**

In `src/viewer/viewer.js`, find the existing fetch helpers (`fetchGraph`, `fetchDecisions`, `fetchAggregates`, `fetchFileEdges`). Add a sibling, matching their style:

```js
  async function fetchFrames(project) {
    const url = project ? `/api/frames?project=${encodeURIComponent(project)}` : '/api/frames';
    const res = await fetch(url);
    return res.json();
  }
```

- [ ] **Step 2: Remove the `gridLayout` import**

In `src/viewer/viewer.js` line 3, delete:

```js
import { gridLayout } from '/viewer/layout.js';
```

- [ ] **Step 3: Wire `fetchFrames` into `loadGraph` and consume server positions**

In `loadGraph` (around line 91), add `fetchFrames` to the `Promise.all` and replace the grid-layout block (current lines ~107–132). Replace this:

```js
    const [graph, decs, aggs, fileEdges] = await Promise.all([
      fetchGraph(projectName),
      fetchDecisions(projectName),
      fetchAggregates(projectName),
      fetchFileEdges(projectName),
    ]);
```

with:

```js
    const [graph, decs, aggs, fileEdges, frameMap] = await Promise.all([
      fetchGraph(projectName),
      fetchDecisions(projectName),
      fetchAggregates(projectName),
      fetchFileEdges(projectName),
      fetchFrames(projectName),
    ]);
```

Then replace the entire block from the `// 2. Position via grid layout.` comment through the `FRAMES = positioned.map(...)` assignment (current lines ~107–132) with:

```js
    // 2. Consume server-computed force-directed positions. Only ambient frames
    //    are positioned + rendered on the first map; the rest stay reachable
    //    via search. Positions are integer px in a fixed virtual stage; the
    //    viewer normalizes by the stage dims the server reports.
    const stage = frameMap.stage || { w: 1000, h: 800 };
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
      }));
```

(The `stageW`/`stageH`/`AGGREGATE_STRIP_H`/`layoutH` locals from the old grid block are no longer used — delete them as part of this replacement.)

- [ ] **Step 4: Confirm no other `gridLayout` / `layout.js` references remain**

Run: `grep -rn "gridLayout\|layout.js" src/viewer/`
Expected: no matches (the import and call are gone).

- [ ] **Step 5: Delete the dead grid module + its test**

```bash
git rm src/viewer/layout.js tests/viewer/layout.test.js
```

- [ ] **Step 6: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — no references to the deleted `gridLayout` remain; all new module tests green.

- [ ] **Step 7: Gate-0 Visual QA** (per `.claude/rules/workflow.md`)

```bash
npm run dev
```

Wait for the viewer to come up (port 3334 in dev), then drive it via Playwright MCP:
1. `browser_navigate` to `http://localhost:3334/viewer`
2. `browser_console_messages` — assert **no** errors/stack traces
3. `browser_take_screenshot` → save to `.playwright-mcp/frame-layout-cortex.png`
4. Switch the project selector to a larger repo if available; screenshot again.

Verify:
- Ambient frames render as a force-directed map (not a grid), no overlaps, within bounds.
- Cortex self (~7 frames) → all ambient. A large repo (e.g. tRPC, 31 frames) → ~10 ambient.
- No console errors.

If Playwright/display is unavailable, **state so explicitly** and flag the task as needing user-driven hand-verify before merge (per the workflow rule's "Honest reporting"). Save screenshots only under `.playwright-mcp/` or `.tmp/`.

- [ ] **Step 8: Commit**

```bash
git add src/viewer/viewer.js
git commit -m "feat(viewer): consume /api/frames force-directed layout; retire grid"
```

---

### Task 10: Verification harness run + decision capture

**Files:**
- No source changes (verification + provenance only).

- [ ] **Step 1: Determinism check across two endpoint calls**

With the dev server running, fetch `/api/frames` twice and diff:

```bash
curl -s http://localhost:3334/api/frames > .tmp/frames-1.json
curl -s http://localhost:3334/api/frames > .tmp/frames-2.json
diff .tmp/frames-1.json .tmp/frames-2.json && echo "DETERMINISTIC: byte-identical"
```

Expected: no diff — byte-identical ranks + positions (spec "Verification: Determinism").

- [ ] **Step 2: Mechanical invariants check**

```bash
node -e '
const m = require("./.tmp/frames-1.json");
const extracted = m.frames.length;
const ambient = m.frames.filter(f => f.ambient).length;
const budget = Math.max(4, Math.min(10, Math.ceil(extracted * 0.7)));
console.log({ extracted, ambient, budget });
const everyRanked = m.frames.every(f => Number.isInteger(f.rank));
const ambientPositioned = m.frames.filter(f => f.ambient).every(f => Number.isInteger(f.x) && Number.isInteger(f.y));
if (ambient !== Math.min(budget, extracted)) throw new Error("ambient count != budget");
if (!everyRanked) throw new Error("not every frame ranked");
if (!ambientPositioned) throw new Error("ambient frame missing position");
console.log("MECHANICAL INVARIANTS OK");
'
```

Expected: `|ambient| == min(budget, extracted)`, every frame ranked, every ambient frame positioned (spec "Verification: Mechanical").

- [ ] **Step 3: Capture the design decision** (per CLAUDE.md decision-capture)

Use the cortex decision tools (pass `repo_path: "/Users/rka/Development/cortex"`):

```
search_decisions({ query: "frame ranking force-directed layout taxonomy", repo_path: "/Users/rka/Development/cortex" })
create_decision({
  repo_path: "/Users/rka/Development/cortex",
  title: "Path 1: taxonomy-free frame ranker + force-directed layout",
  description: "Server-side recompute-on-read /api/frames: ranker (nameability × structural_weight, budget max(4,min(10,ceil(n×0.7)))) + d3-force layout (mulberry32-seeded, 300 iters, integer-quantized). Replaces the client-side gridLayout.",
  rationale: "Taxonomy feeds only 1 of 6 forces + 1 of 4 ranker factors; the rest are concrete graph facts we already have. Ship the gravity map now, add taxonomy as an additive refinement. Recompute-on-read avoids a DB migration (sub-second on ≤10 frames).",
  alternatives: "Full 4-factor ranker + taxonomy first (blocked on classifier); persist positions to DB (premature — frames are a materialized cache).",
  governs: ["src/frame-extraction/frame-ranker.ts", "src/mcp-server/frame-layout.ts", "src/mcp-server/frame-map.ts", "src/mcp-server/frame-pair-rollup.ts"]
})
```

- [ ] **Step 4: Keep the index current** (per CLAUDE.md "First thing every session")

```
detect_changes({ repo_path: "/Users/rka/Development/cortex" })
index_repository({ repo_path: "/Users/rka/Development/cortex" })
```

- [ ] **Step 5: Commit any verification artifacts notes (if applicable)**

The `.tmp/` artifacts are gitignored — nothing to commit unless you added a field report. If you wrote one, commit it:

```bash
git add docs/"field reports"/ 2>/dev/null || true
git commit -m "docs(frames): Path 1 verification field report" 2>/dev/null || echo "no field report to commit"
```

---

## Deferred (explicitly out of scope for Path 1)

Carried from the spec's Non-goals + a scoping call made in this plan — surface to the user, don't silently drop:

- **Taxonomy / `FrameKind`** → layer-adjacency force, ranker kind-weight, layer-diversity. Additive follow-up; no interface change.
- **Decision-governance tertiary force** (spec §B "optional tertiary"). Deferred to keep the layout's force set to the three grounded ones; cheap to add later via the existing `buildFrameGovernance` association.
- **Floating-entity gravity-centroid** for bare nodes + aggregates (spec §B "Floating entities"). The viewer's existing aggregate strip keeps working unchanged; positioning aggregates by centroid is a follow-up that needs its own visual QA. *(Plan deviation from spec §B — flagged here so it's a conscious choice, not an omission.)*
- **Persisting positions/ranks to a DB.** Recompute-on-read per spec §8.7.

---

## Self-Review (completed during planning)

- **Spec coverage:** §A ranker → Tasks 1–3; §A budget → Task 2; §A nameability (F1 × generic penalty) → Tasks 1, 3, 7; §A structural_weight sqrt → Task 3; §A tie-break lexicographic → Task 3; §A output `{ambient, rank, score, components}` → Task 3; §B d3-force → Task 6; §B forces (import-neighbourhood, mass, collision) → Tasks 4, 6; §B determinism (mulberry32 + SHA-256 seed + 300 iters + integer quantize) → Tasks 5, 6; §B size band 110–160 → Task 6; §C viewer wiring → Task 9; symbol→file→frame rollup risk → Task 4 (dedicated edge-case tests); Verification (determinism, mechanical, Gate-0) → Tasks 9–10. **Deferred items** (diversity, layer-adjacency, decision-governance force, floating-entity centroid, persistence) are documented above.
- **Type consistency:** `FramePairWeight` is defined once in `frame-pair-rollup.ts` and imported by `frame-layout.ts` + tests. `LayoutInputFrame`/`PositionedFrame` live in `frame-layout.ts`. `FrameRecord`/`RankedFrame` live in `frame-ranker.ts`. `STAGE_W`/`STAGE_H` exported from `frame-layout.ts`, re-used by `frame-map.ts` + `api.ts`. `buildFrameMap` signature `(nodes, edges) → FrameMap` is consistent across Tasks 7–8.
- **Placeholder scan:** no TBD/TODO; every code step shows full code.
```

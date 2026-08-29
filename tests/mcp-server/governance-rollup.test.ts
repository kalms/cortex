import { describe, it, expect } from "vitest";
import { rollupGovernancePairs, type GovernedRef } from "../../src/frame-extraction/positioning/governance-rollup.js";
import { layoutFrames, stageFor, type LayoutInputFrame } from "../../src/frame-extraction/positioning/frame-layout.js";
import type { NodeRow } from "../../src/graph/store.js";

function fileNode(id: string, path: string, frameId: number): NodeRow {
  return {
    id, kind: "file", name: path, qualified_name: null, file_path: path,
    data: JSON.stringify({ frame_id: frameId, frame_label: `f${frameId}` }),
    tier: "tier1", created_at: "", updated_at: "",
  };
}
function symNode(id: string, path: string, qn: string): NodeRow {
  return {
    id, kind: "function", name: id, qualified_name: qn, file_path: path,
    data: "{}", tier: "tier1", created_at: "", updated_at: "",
  };
}

const nodes: NodeRow[] = [
  fileNode("a", "src/a.ts", 1),
  fileNode("b", "src/b.ts", 2),
  fileNode("c", "src/c.ts", 3),
  fileNode("orphan", "src/orphan.ts", 4),
  symNode("s1", "src/a.ts", "src/a.ts::doThing"),
];

describe("rollupGovernancePairs", () => {
  it("pairs the frames a decision spans", () => {
    const g: GovernedRef[] = [{ id: "D-1", ref: "src/a.ts" }, { id: "D-1", ref: "src/b.ts" }];
    expect(rollupGovernancePairs(nodes, g)).toEqual([{ a: 1, b: 2, weight: 1 }]);
  });

  it("emits every pair for a decision spanning three frames", () => {
    const g: GovernedRef[] = [
      { id: "D-1", ref: "src/a.ts" }, { id: "D-1", ref: "src/b.ts" }, { id: "D-1", ref: "src/c.ts" },
    ];
    expect(rollupGovernancePairs(nodes, g)).toEqual([
      { a: 1, b: 2, weight: 1 }, { a: 1, b: 3, weight: 1 }, { a: 2, b: 3, weight: 1 },
    ]);
  });

  it("weights a pair by DISTINCT governing entities, not by ref count", () => {
    // D-1 governs many refs but only two frames → weight 1 for that pair.
    const many: GovernedRef[] = [
      { id: "D-1", ref: "src/a.ts" }, { id: "D-1", ref: "src/a.ts" },
      { id: "D-1", ref: "src/a.ts::doThing" }, { id: "D-1", ref: "src/b.ts" },
    ];
    expect(rollupGovernancePairs(nodes, many)).toEqual([{ a: 1, b: 2, weight: 1 }]);
    // Two separate decisions over the same pair → weight 2.
    const two: GovernedRef[] = [
      { id: "D-1", ref: "src/a.ts" }, { id: "D-1", ref: "src/b.ts" },
      { id: "T-9", ref: "src/a.ts" }, { id: "T-9", ref: "src/b.ts" },
    ];
    expect(rollupGovernancePairs(nodes, two)).toEqual([{ a: 1, b: 2, weight: 2 }]);
  });

  it("resolves qualified names through their defining file", () => {
    const g: GovernedRef[] = [{ id: "D-1", ref: "src/a.ts::doThing" }, { id: "D-1", ref: "src/b.ts" }];
    expect(rollupGovernancePairs(nodes, g)).toEqual([{ a: 1, b: 2, weight: 1 }]);
  });

  it("emits nothing for a single-frame decision — no pull to express", () => {
    const g: GovernedRef[] = [{ id: "D-1", ref: "src/a.ts" }, { id: "D-1", ref: "src/a.ts::doThing" }];
    expect(rollupGovernancePairs(nodes, g)).toEqual([]);
  });

  it("drops refs that resolve to no frame", () => {
    const g: GovernedRef[] = [{ id: "D-1", ref: "src/a.ts" }, { id: "D-1", ref: "does/not/exist.ts" }];
    expect(rollupGovernancePairs(nodes, g)).toEqual([]);
    expect(rollupGovernancePairs(nodes, [])).toEqual([]);
  });

  it("is deterministic and input-order independent", () => {
    const g: GovernedRef[] = [
      { id: "D-2", ref: "src/b.ts" }, { id: "D-1", ref: "src/a.ts" },
      { id: "D-1", ref: "src/c.ts" }, { id: "D-2", ref: "src/a.ts" },
    ];
    expect(rollupGovernancePairs(nodes, g)).toEqual(rollupGovernancePairs(nodes, [...g].reverse()));
  });
});

describe("layoutFrames — governance force", () => {
  const mk = (n: number): LayoutInputFrame[] =>
    Array.from({ length: n }, (_, i) => ({
      frame_id: i, frame_label: `f${i}`, member_count: 6, size: 100, sink: 0.5,
    }));

  it("is inert when no governance is supplied (existing callers unchanged)", () => {
    const frames = mk(12), stage = stageFor(frames.map((f) => f.size!));
    expect(layoutFrames(frames, [], stage, [])).toEqual(layoutFrames(frames, [], stage));
  });

  it("pulls co-governed frames closer than ungoverned ones", () => {
    const frames = mk(12);
    const stage = stageFor(frames.map((f) => f.size!));
    const dist = (out: ReturnType<typeof layoutFrames>, a: number, b: number) => {
      const A = out.find((f) => f.id === a)!, B = out.find((f) => f.id === b)!;
      return Math.hypot(A.x - B.x, A.y - B.y);
    };
    const before = layoutFrames(frames, [], stage);
    // One decision spanning frames 0 and 11 — with no code edges between them.
    const after = layoutFrames(frames, [], stage, [{ a: 0, b: 11, weight: 1 }]);
    expect(dist(after, 0, 11)).toBeLessThan(dist(before, 0, 11));
  });

  it("stays deterministic with governance applied", () => {
    const frames = mk(20), stage = stageFor(frames.map((f) => f.size!));
    const gov = [{ a: 0, b: 5, weight: 2 }, { a: 5, b: 9, weight: 1 }];
    expect(layoutFrames(frames, [], stage, gov)).toEqual(layoutFrames(frames, [], stage, gov));
  });

  it("still separates frames — governance never overrides non-overlap", () => {
    const frames = mk(24), stage = stageFor(frames.map((f) => f.size!));
    // Every frame co-governed with every other: maximum attraction.
    const gov = [];
    for (let a = 0; a < 24; a++) for (let b = a + 1; b < 24; b++) gov.push({ a, b, weight: 5 });
    const out = layoutFrames(frames, [], stage, gov);
    for (let a = 0; a < out.length; a++) {
      for (let b = a + 1; b < out.length; b++) {
        const ox = (out[a].w + out[b].w) / 2 - Math.abs(out[a].x - out[b].x);
        const oy = (out[a].h + out[b].h) / 2 - Math.abs(out[a].y - out[b].y);
        expect(Math.min(ox, oy)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("ignores governance pairs naming absent frames", () => {
    const frames = mk(6), stage = stageFor(frames.map((f) => f.size!));
    expect(layoutFrames(frames, [], stage, [{ a: 0, b: 999, weight: 3 }]))
      .toEqual(layoutFrames(frames, [], stage));
  });
});

import { describe, it, expect } from "vitest";
import { rollupFrameFlows } from "../../src/frame-extraction/positioning/frame-flow-rollup.js";
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
    const { flows, stats } = rollupFrameFlows(nodes, []);
    expect(flows).toEqual([]);
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

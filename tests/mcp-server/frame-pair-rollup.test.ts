import { describe, it, expect } from "vitest";
import { rollupFramePairs, buildNodeFrameIndex } from "../../src/frame-extraction/positioning/frame-pair-rollup.js";
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

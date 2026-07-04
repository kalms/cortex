import { describe, it, expect } from "vitest";
import { adaptProjectData } from "../../src/viewer/app/data.ts";

const graph = { nodes: [
  { id: "f1", kind: "file", name: "a.ts", file_path: "src/a.ts", data: JSON.stringify({ frame_id: 1 }) },
], edges: [] };
const frameMap = { stage: { w: 1000, h: 800 }, frames: [
  { id: 1, name: "alpha", x: 100, y: 80, w: 3, h: 2, count: 1, layer: "domain", ambient: true },
  { id: 2, name: "ghost", x: null, y: null, w: 1, h: 1, count: 0, layer: null, ambient: false },
] };

describe("adaptProjectData", () => {
  it("normalizes positioned frames and drops unpositioned ones", () => {
    const b = adaptProjectData({ graph, decs: { decisions: [] }, aggs: { aggregates: [] },
      fileEdges: { file_edges: [] }, frameMap, todosResp: { todos: [] } });
    expect(b.frames).toHaveLength(1);
    expect(b.frames[0]).toMatchObject({ id: "1", name: "alpha", x: 0.1, y: 0.1, deemphasized: false });
    expect(b.nodeCfg["1"].count).toBe(1);
    expect(b.rawNodes).toHaveLength(1);
    expect(b.rawFrameMap).toBe(frameMap);
  });
  it("folds decision file-kind governs into frameGovernance via membership", () => {
    const decs = { decisions: [
      { id: "d1", summary: "frame ref", state: "active", governs: [{ kind: "frame", id: 1 }] },
      { id: "d2", summary: "file ref", state: "active", governs: [{ kind: "file", path: "src/a.ts" }] },
      { id: "d3", summary: "unresolvable", state: "active", governs: [{ kind: "file", path: "elsewhere/x.ts" }] },
    ] };
    const b = adaptProjectData({ graph, decs, aggs: { aggregates: [] },
      fileEdges: { file_edges: [] }, frameMap, todosResp: { todos: [] } });
    expect(b.frameGovernance["1"]).toEqual(["d1", "d2"]);
  });
  it("keeps closed todos in allTodos but not in the ambient todo map", () => {
    const todosResp = { todos: [
      { id: "t1", seq: 1, summary: "open", state: "proposed", governs: [] },
      { id: "t2", seq: 2, summary: "done", state: "done", governs: [] },
    ] };
    const b = adaptProjectData({ graph, decs: { decisions: [] }, aggs: { aggregates: [] },
      fileEdges: { file_edges: [] }, frameMap, todosResp });
    expect(Object.keys(b.ambientTodoMap)).toEqual(["t1"]);
    expect(b.allTodos).toHaveLength(2);
  });
});

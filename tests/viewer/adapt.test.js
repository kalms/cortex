import { describe, it, expect } from "vitest";
import { adaptProjectData } from "../../src/viewer/canvas/adapt.js";

const node = (id, path, frameId) => ({
  id, kind: "file", name: id, file_path: path,
  data: JSON.stringify({ frame_id: frameId, frame_label: `frame-${frameId}` }),
});

function fixture() {
  return {
    graph: {
      nodes: [node("n1", "src/a.ts", 1), node("n2", "src/b.ts", 1), node("n3", "lib/c.ts", 2)],
      edges: [],
    },
    decs: { decisions: [
      { id: "d1", seq: 1, summary: "s", state: "active", governs: [{ kind: "frame", id: "1" }] },
      { id: "d2", seq: 2, summary: "s2", state: "active", governs: [{ kind: "file", path: "lib/c.ts" }] },
    ] },
    aggs: { aggregates: [{ id: "agg1", label: "aux", member_count: 3, x: 100, y: 700 }] },
    fileEdges: { file_edges: [{ from_path: "src/a.ts", to_path: "src/b.ts", weight: 2 }] },
    frameMap: { stage: { w: 1000, h: 800 }, frames: [
      { id: 1, name: "core", x: 300, y: 200, w: 150, h: 120, count: 2, layer: "domain", ambient: true },
      { id: 2, name: "lib", x: 700, y: 500, w: 100, h: 90, count: 1, layer: "data", ambient: true },
    ] },
    todosResp: { todos: [
      { id: "t1", seq: 1, summary: "todo", state: "open", governs: [{ kind: "frame", id: "2" }], spawnsFrom: "d1" },
      { id: "t2", seq: 2, summary: "done todo", state: "done", governs: [], spawnsFrom: null },
    ] },
  };
}

describe("adaptProjectData (canvas/adapt.js)", () => {
  it("normalizes frames to stage fractions and keeps px sizes", () => {
    const b = adaptProjectData(fixture());
    expect(b.frames).toHaveLength(2);
    expect(b.frames[0]).toMatchObject({ id: "1", x: 0.3, y: 0.25, w: 150, h: 120, deemphasized: false });
  });
  it("builds per-frame node config and names", () => {
    const b = adaptProjectData(fixture());
    expect(b.nodeCfg["1"].count).toBe(2);
    expect(b.fileNames["1"]).toEqual(["a.ts", "b.ts"]);
    expect(b.frameFilePaths["2"]).toEqual(["lib/c.ts"]);
  });
  it("folds file-kind governance through frame membership", () => {
    const b = adaptProjectData(fixture());
    expect(b.frameGovernance["1"]).toContain("d1");
    expect(b.frameGovernance["2"]).toContain("d2"); // file ref → containing frame
    expect(b.todoGovernance["2"]).toContain("t1");
  });
  it("filters closed todos out of the ambient map but keeps them in spawnsFrom", () => {
    const b = adaptProjectData(fixture());
    expect(b.ambientTodoMap["t1"]).toBeDefined();
    expect(b.ambientTodoMap["t2"]).toBeUndefined();
    expect(b.spawnsFrom["d1"]).toEqual(["t1"]);
  });
  it("passes aggregates and file edges through", () => {
    const b = adaptProjectData(fixture());
    expect(b.aggregates).toHaveLength(1);
    expect(b.fileEdges[0].weight).toBe(2);
  });
  it("carries ALL frame members (LOD budgets at draw time, not adapt time)", () => {
    const f = fixture();
    f.graph.nodes = Array.from({ length: 40 }, (_, i) => node(`m${i}`, `src/m${i}.ts`, 1));
    const b = adaptProjectData(f);
    expect(b.nodeCfg["1"].count).toBe(40);
    expect(b.fileNames["1"]).toHaveLength(40);
  });
});

describe("adaptProjectData — scaled stage normalization", () => {
  /** Same scene, expressed on a 2x stage: every server-side coordinate and size
   *  doubles. The adapter must normalize it back to the reference stage so the
   *  engine's fixed 1000x800 coordinate space keeps working unchanged. */
  function scaled(k) {
    const f = fixture();
    f.frameMap = {
      stage: { w: 1000 * k, h: 800 * k },
      frames: f.frameMap.frames.map((fr) => ({
        ...fr, x: fr.x * k, y: fr.y * k, w: fr.w * k, h: fr.h * k,
      })),
    };
    f.aggs = { aggregates: f.aggs.aggregates.map((a) => ({ ...a, x: a.x * k, y: a.y * k })) };
    return f;
  }

  it("yields identical frame geometry to the reference stage", () => {
    const ref = adaptProjectData(fixture());
    const big = adaptProjectData(scaled(2));
    expect(big.frames.map((f) => [f.id, f.x, f.y, f.w, f.h]))
      .toEqual(ref.frames.map((f) => [f.id, f.x, f.y, f.w, f.h]));
  });

  it("rescales aggregate dots too, so they stay on the cloud", () => {
    const ref = adaptProjectData(fixture());
    const big = adaptProjectData(scaled(2));
    expect(big.aggregates.map((a) => [a.x, a.y])).toEqual(ref.aggregates.map((a) => [a.x, a.y]));
  });

  it("rescales frameMeta sizes in step with the frames", () => {
    const ref = adaptProjectData(fixture());
    const big = adaptProjectData(scaled(2));
    expect([...big.frameMeta].map(([id, m]) => [id, m.w, m.h]))
      .toEqual([...ref.frameMeta].map(([id, m]) => [id, m.w, m.h]));
  });

  it("leaves an aggregate with no position untouched", () => {
    const f = scaled(2);
    f.aggs = { aggregates: [{ id: "agg1", label: "aux", member_count: 3 }] };
    expect(adaptProjectData(f).aggregates[0]).toEqual({ id: "agg1", label: "aux", member_count: 3 });
  });
});

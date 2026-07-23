import { describe, it, expect } from "vitest";
import { frameIdsForRefs, buildFrameAdjacency, frameBfsPath } from "../../src/viewer/canvas/adapters.js";

const index = new Map([["src/a.ts", "1"], ["src/b/c.ts", "2"]]);

describe("frameIdsForRefs", () => {
  it("resolves plain paths and qn prefixes, dedupes, drops unresolvable and D-/T- refs", () => {
    expect(frameIdsForRefs(index, ["src/a.ts", "src/a.ts::fn", "src/b/c.ts", "D-abcd", "T-abcd", "nope.ts"]))
      .toEqual(["1", "2"]);
  });
  it("empty refs → empty", () => { expect(frameIdsForRefs(index, [])).toEqual([]); });
});

describe("buildFrameAdjacency / frameBfsPath", () => {
  const adj = buildFrameAdjacency([{ a: "1", b: "2" }, { a: "2", b: "3" }, { a: "4", b: "5" }]);
  it("adjacency is undirected", () => {
    expect([...adj.get("2")].sort()).toEqual(["1", "3"]);
  });
  it("finds shortest path", () => { expect(frameBfsPath(adj, "1", "3")).toEqual(["1", "2", "3"]); });
  it("same node", () => { expect(frameBfsPath(adj, "1", "1")).toEqual(["1"]); });
  it("unreachable → []", () => { expect(frameBfsPath(adj, "1", "5")).toEqual([]); });
  it("unknown endpoint → []", () => { expect(frameBfsPath(adj, "1", "99")).toEqual([]); });
});

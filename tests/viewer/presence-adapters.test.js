import { describe, it, expect } from "vitest";
import { frameIdsForRefs, primaryRefPath, buildFrameAdjacency, frameBfsPath } from "../../src/viewer/canvas/adapters.js";

const index = new Map([["src/a.ts", "1"], ["src/b/c.ts", "2"]]);

describe("frameIdsForRefs", () => {
  it("resolves plain paths and qn prefixes, dedupes, drops unresolvable and D-/T- refs", () => {
    expect(frameIdsForRefs(index, ["src/a.ts", "src/a.ts::fn", "src/b/c.ts", "D-abcd", "T-abcd", "nope.ts"]))
      .toEqual(["1", "2"]);
  });
  it("empty refs → empty", () => { expect(frameIdsForRefs(index, [])).toEqual([]); });
});

describe("primaryRefPath", () => {
  it("returns the path of the first resolving ref (the traversal target's anchor)", () => {
    // D-/T- and unresolvable refs are skipped; qn prefix is stripped to the path.
    expect(primaryRefPath(index, ["D-abcd", "nope.ts", "src/b/c.ts::fn", "src/a.ts"])).toBe("src/b/c.ts");
    expect(primaryRefPath(index, ["src/a.ts"])).toBe("src/a.ts");
  });
  it("null when nothing resolves", () => {
    expect(primaryRefPath(index, ["D-abcd", "nope.ts"])).toBe(null);
    expect(primaryRefPath(index, [])).toBe(null);
  });
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

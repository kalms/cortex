import { describe, it, expect } from "vitest";
import { partitionSpotlightRefs, resolveEmphasisPairs } from "../../src/viewer/canvas/adapters.js";

const index = new Map([["src/a.ts", "1"], ["src/b/c.ts", "2"]]);

describe("partitionSpotlightRefs", () => {
  it("partitions mixed refs into frameIds, decisionIds, todoIds, and unresolved", () => {
    const result = partitionSpotlightRefs(index, [
      "src/a.ts",
      "src/a.ts::fn",
      "src/b/c.ts",
      "D-decision1",
      "T-todo1",
      "nope.ts",
    ]);
    expect(result).toEqual({
      frameIds: ["1", "2"],
      decisionIds: ["D-decision1"],
      todoIds: ["T-todo1"],
      unresolved: ["nope.ts"],
    });
  });

  it("dedupes within each bucket", () => {
    const result = partitionSpotlightRefs(index, [
      "src/a.ts",
      "src/a.ts::fn",
      "src/a.ts",
      "D-decision1",
      "D-decision1",
      "T-todo1",
      "T-todo1",
      "nope.ts",
      "nope.ts",
    ]);
    expect(result).toEqual({
      frameIds: ["1"],
      decisionIds: ["D-decision1"],
      todoIds: ["T-todo1"],
      unresolved: ["nope.ts"],
    });
  });

  it("lands unresolvable paths in unresolved, not frameIds", () => {
    const result = partitionSpotlightRefs(index, ["nope.ts", "also-nope.ts"]);
    expect(result).toEqual({
      frameIds: [],
      decisionIds: [],
      todoIds: [],
      unresolved: ["nope.ts", "also-nope.ts"],
    });
  });

  it("empty refs → all empty", () => {
    const result = partitionSpotlightRefs(index, []);
    expect(result).toEqual({
      frameIds: [],
      decisionIds: [],
      todoIds: [],
      unresolved: [],
    });
  });

  it("handles directory-level governance (prefix matching)", () => {
    // "src/b/" should match "src/b/c.ts" via prefix
    const result = partitionSpotlightRefs(index, ["src/b/", "D-xyz"]);
    expect(result).toEqual({
      frameIds: ["2"],
      decisionIds: ["D-xyz"],
      todoIds: [],
      unresolved: [],
    });
  });

  it("preserves insertion order within buckets", () => {
    const result = partitionSpotlightRefs(index, [
      "src/b/c.ts",
      "src/a.ts",
      "D-zebra",
      "D-apple",
    ]);
    expect(result.frameIds).toEqual(["2", "1"]);
    expect(result.decisionIds).toEqual(["D-zebra", "D-apple"]);
  });

  it("strips :: suffix from qns like frameIdsForRefs does", () => {
    const result = partitionSpotlightRefs(index, [
      "src/a.ts::someFunc::nested",
      "src/b/c.ts::anotherFunc",
    ]);
    expect(result.frameIds).toEqual(["1", "2"]);
    expect(result.unresolved).toEqual([]);
  });

  it("keeps D-/T- refs with :: suffix verbatim (ID check before strip)", () => {
    const result = partitionSpotlightRefs(index, ["D-abc::x", "T-xyz::func"]);
    expect(result.decisionIds).toEqual(["D-abc::x"]);
    expect(result.todoIds).toEqual(["T-xyz::func"]);
    expect(result.frameIds).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it("preserves original ref in unresolved (not stripped path)", () => {
    const result = partitionSpotlightRefs(index, ["nope.ts::fn"]);
    expect(result.unresolved).toEqual(["nope.ts::fn"]);
  });
});

describe("resolveEmphasisPairs", () => {
  // src/a.ts and src/a2.ts share frame "1"; src/b.ts is frame "2".
  const emphasisIndex = new Map([
    ["src/a.ts", "1"],
    ["src/a2.ts", "1"],
    ["src/b.ts", "2"],
  ]);

  it("resolves both-ends pairs to frame ids and drops the rest", () => {
    expect(resolveEmphasisPairs(emphasisIndex, [
      ["src/a.ts", "src/b.ts"],          // both resolve, different frames → kept
      ["src/a.ts", "src/a2.ts"],         // same frame → dropped
      ["src/a.ts", "not/indexed.ts"],    // one end unresolved → dropped
      ["D-zwrt", "src/b.ts"],            // D- ref never resolves → dropped
    ])).toEqual([{ from: "1", to: "2" }]);
  });

  it("strips a :: suffix on either end before resolving via the path prefix", () => {
    expect(resolveEmphasisPairs(emphasisIndex, [
      ["src/a.ts::someFunc", "src/b.ts::otherFunc"],
    ])).toEqual([{ from: "1", to: "2" }]);
  });
});

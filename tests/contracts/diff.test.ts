import { describe, it, expect } from "vitest";
import { groupBindings, diffKeys, findMismatches, summarizeCoverage } from "../../src/contracts/diff.js";
import type { Binding } from "../../src/contracts/types.js";

const b = (tool: string, role: "provides" | "consumes", keys: string[]): Binding =>
  ({ tool, role, keys, file: "f", symbol: "s", line: 1 });

describe("diffKeys", () => {
  it("reports sent-but-not-read and read-but-not-sent", () => {
    expect(diffKeys(["project"], ["repo_path"])).toEqual({
      missing_on_provider: ["repo_path"],
      missing_on_consumer: ["project"],
    });
  });
  it("is empty when key sets match", () => {
    expect(diffKeys(["a", "b"], ["b", "a"])).toEqual({ missing_on_provider: [], missing_on_consumer: [] });
  });
  it("returns empty diffs for two empty arrays", () => {
    expect(diffKeys([], [])).toEqual({ missing_on_provider: [], missing_on_consumer: [] });
  });
});

describe("findMismatches", () => {
  it("flags detect_changes (repo_path sent, project read)", () => {
    const bindings = [
      b("detect_changes", "provides", ["project"]),
      b("detect_changes", "consumes", ["repo_path"]),
    ];
    const m = findMismatches(bindings);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ tool: "detect_changes", missing_on_provider: ["repo_path"], missing_on_consumer: ["project"] });
  });
  it("does not flag a matching contract", () => {
    const bindings = [b("x", "provides", ["repo_path"]), b("x", "consumes", ["repo_path"])];
    expect(findMismatches(bindings)).toEqual([]);
  });
  it("treats union of consumer keys across multiple call sites", () => {
    const bindings = [
      b("y", "provides", ["a", "b"]),
      b("y", "consumes", ["a"]),
      b("y", "consumes", ["b"]),
    ];
    expect(findMismatches(bindings)).toEqual([]);
  });
  it("returns empty array when given no bindings", () => {
    expect(findMismatches([])).toEqual([]);
  });
  it("sorts results by tool name", () => {
    const bindings = [
      b("zebra", "provides", ["x"]),
      b("zebra", "consumes", ["y"]),
      b("alpha", "provides", ["a"]),
      b("alpha", "consumes", ["b"]),
    ];
    const m = findMismatches(bindings);
    expect(m).toHaveLength(2);
    expect(m[0].tool).toBe("alpha");
    expect(m[1].tool).toBe("zebra");
  });
});

describe("summarizeCoverage", () => {
  it("returns zero report for empty bindings", () => {
    expect(summarizeCoverage([], 0)).toEqual({
      anchors: 0, providers: 0, consumers: 0, matched: 0,
      provider_only: [], consumer_only: [], unrecognized: 0,
    });
  });
  it("counts sides and flags one-sided anchors", () => {
    const bindings = [
      b("matched", "provides", ["a"]), b("matched", "consumes", ["a"]),
      b("dead", "provides", ["a"]),
      b("orphan", "consumes", ["a"]),
    ];
    expect(summarizeCoverage(bindings, 2)).toEqual({
      anchors: 3, providers: 2, consumers: 2, matched: 1,
      provider_only: ["dead"], consumer_only: ["orphan"], unrecognized: 2,
    });
  });
});

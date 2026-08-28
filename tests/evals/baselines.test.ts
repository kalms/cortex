import { describe, it, expect } from "vitest";
import { mergeImprovements } from "../../evals/src/baselines.js";
import type { Assertion, AssertionResult, Baseline } from "../../evals/src/assertions/types.js";

function universal(name: string): Assertion {
  return {
    fix_id: "universal",
    name,
    description: "",
    // The map-valued metric MUST declare kind "language_density": that is what
    // mergeImprovements discriminates on, rather than sniffing the value's
    // shape, so a fixture that lies about its query kind would exercise the
    // wrong branch and prove nothing.
    query: name === "per_language_function_density"
      ? { kind: "language_density" }
      : { kind: "sql", sql: "" },
    baseline_expected: "pass",
    scope: "universal",
    direction: name === "per_language_function_density" ? "higher_is_better" : "lower_is_better",
  };
}

function res(name: string, observed: AssertionResult["observed"], ratchet: AssertionResult["ratchet"]): AssertionResult {
  return { assertion: universal(name), observed, passed: true, surprised: false, ratchet };
}

const BASE: Baseline = {
  target: "demo",
  captured_at: "2026-01-01T00:00:00.000Z",
  source_sha: "abc123",
  nodes_by_label: { function: 10 },
  edges_by_type: { CALLS: 20 },
  per_assertion: { file_sourced_calls: 147, qn_collisions: 3, per_language_function_density: { go: 3.1, ts: 4.2 } },
};

describe("mergeImprovements", () => {
  it("adopts a metric that improved beyond epsilon", () => {
    const { baseline, adopted } = mergeImprovements(BASE, [
      res("file_sourced_calls", 0, { status: "pass", observed: 0, baseline: 147, delta: -147, improved: true }),
    ]);
    expect(adopted).toEqual(["file_sourced_calls"]);
    expect(baseline.per_assertion.file_sourced_calls).toBe(0);
  });

  it("refuses to adopt a regression", () => {
    const { baseline, adopted } = mergeImprovements(BASE, [
      res("qn_collisions", 9, { status: "fail", observed: 9, baseline: 3, delta: 6, improved: false }),
    ]);
    expect(adopted).toEqual([]);
    expect(baseline.per_assertion.qn_collisions).toBe(3);
  });

  it("ignores a metric that merely held steady", () => {
    const { adopted } = mergeImprovements(BASE, [
      res("qn_collisions", 3, { status: "pass", observed: 3, baseline: 3, delta: 0, improved: false }),
    ]);
    expect(adopted).toEqual([]);
  });

  it("ignores a metric with no baseline to improve on", () => {
    const { adopted } = mergeImprovements(BASE, [
      res("orphan_definition_rate", 4, { status: "no_baseline", observed: 4 }),
    ]);
    expect(adopted).toEqual([]);
  });

  it("adopts improved languages of a map metric and leaves the rest alone", () => {
    const { baseline, adopted } = mergeImprovements(BASE, [
      res("per_language_function_density", { go: 9.9, ts: 1.0 }, {
        go: { status: "pass", observed: 9.9, baseline: 3.1, delta: 6.8, improved: true },
        ts: { status: "fail", observed: 1.0, baseline: 4.2, delta: -3.2, improved: false },
      }),
    ]);
    expect(adopted).toEqual(["per_language_function_density.go"]);
    expect(baseline.per_assertion.per_language_function_density).toEqual({ go: 9.9, ts: 4.2 });
  });

  it("never touches the scorecard sections or the source sha", () => {
    const { baseline } = mergeImprovements(BASE, [
      res("file_sourced_calls", 0, { status: "pass", observed: 0, baseline: 147, delta: -147, improved: true }),
    ]);
    expect(baseline.nodes_by_label).toEqual(BASE.nodes_by_label);
    expect(baseline.edges_by_type).toEqual(BASE.edges_by_type);
    expect(baseline.source_sha).toBe("abc123");
  });

  it("does not mutate the baseline it was given", () => {
    mergeImprovements(BASE, [
      res("file_sourced_calls", 0, { status: "pass", observed: 0, baseline: 147, delta: -147, improved: true }),
    ]);
    expect(BASE.per_assertion.file_sourced_calls).toBe(147);
  });

  it("never adopts an unmeasurable metric, whose observed value is null", () => {
    // The loudest invariant in the plan: `not_measured` carries observed: null.
    // Writing that into a baseline seeds a non-comparable entry that every
    // later run then compares against.
    const { baseline, adopted } = mergeImprovements(BASE, [
      res("file_sourced_calls", null, { status: "not_measured", observed: null }),
    ]);
    expect(adopted).toEqual([]);
    expect(baseline.per_assertion.file_sourced_calls).toBe(147);
  });

  it("skips a result carrying no ratchet outcome at all", () => {
    const { adopted } = mergeImprovements(BASE, [
      res("qn_collisions", 1, undefined),
    ]);
    expect(adopted).toEqual([]);
  });
});

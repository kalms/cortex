import { describe, it, expect } from "vitest";
import { compareGraphShape } from "../../evals/src/target.js";
import type { Scorecard } from "../../evals/src/assertions/types.js";

const card = (nodes: Record<string, number>, edges: Record<string, number>): Scorecard => ({
  target: "demo", indexer_seconds: null, nodes_by_label: nodes, edges_by_type: edges, killer_queries: [],
});

describe("compareGraphShape", () => {
  it("reports stable when both passes agree", () => {
    const a = card({ function: 10 }, { CALLS: 5 });
    const b = card({ function: 10 }, { CALLS: 5 });
    expect(compareGraphShape(a, b)).toEqual({ stable: true, differences: [] });
  });

  it("ignores SEMANTICALLY_RELATED, which is known nondeterministic", () => {
    const a = card({ function: 10 }, { CALLS: 5, SEMANTICALLY_RELATED: 146 });
    const b = card({ function: 10 }, { CALLS: 5, SEMANTICALLY_RELATED: 148 });
    expect(compareGraphShape(a, b).stable).toBe(true);
  });

  it("reports a node-count difference", () => {
    const a = card({ function: 10 }, {});
    const b = card({ function: 9 }, {});
    const r = compareGraphShape(a, b);
    expect(r.stable).toBe(false);
    expect(r.differences.join(" ")).toContain("function");
  });

  it("reports an edge-count difference", () => {
    const a = card({}, { CALLS: 5 });
    const b = card({}, { CALLS: 7 });
    const r = compareGraphShape(a, b);
    expect(r.stable).toBe(false);
    expect(r.differences.join(" ")).toContain("CALLS");
  });

  it("reports a label present in one scorecard and absent from the other", () => {
    // Pins the union-of-keys symmetry in both directions. An implementation
    // that iterated only Object.keys(a) would silently miss a whole label or
    // edge type appearing or vanishing between runs.
    expect(compareGraphShape(card({ function: 10 }, {}), card({}, {})).stable).toBe(false);
    expect(compareGraphShape(card({}, {}), card({ function: 10 }, {})).stable).toBe(false);
    expect(compareGraphShape(card({}, { CALLS: 3 }), card({}, {})).stable).toBe(false);
  });
});

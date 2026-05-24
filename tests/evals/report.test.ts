import { describe, it, expect } from "vitest";
import { renderSummary } from "../../evals/src/report.js";
import type { Scorecard, AssertionResult, Baseline, Assertion } from "../../evals/src/assertions/types.js";

const stubAssertion: Assertion = {
  fix_id: 2,
  name: "http_calls_edge_count_nonzero",
  description: "stub",
  query: { kind: "count_edge", type: "HTTP_CALLS" },
  predicate: { op: "gt", value: 0 },
  baseline_expected: "fail",
};

describe("report.renderSummary", () => {
  it("renders a target heading", () => {
    const sc: Scorecard = {
      target: "nuxt-ui",
      indexer_seconds: 12.3,
      nodes_by_label: { function: 100 },
      edges_by_type: { CALLS: 50 },
      killer_queries: [],
    };
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results: [], baseline: null }]);
    expect(md).toContain("## nuxt-ui");
  });

  it("lists surprises with checkmark/cross prefixes", () => {
    const sc: Scorecard = {
      target: "nuxt-ui", indexer_seconds: null,
      nodes_by_label: {}, edges_by_type: {}, killer_queries: [],
    };
    const results: AssertionResult[] = [
      { assertion: stubAssertion, observed: 47, passed: true, surprised: true },
    ];
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results, baseline: null }]);
    expect(md).toContain("Surprises");
    expect(md).toMatch(/✓\s+http_calls_edge_count_nonzero/);
    expect(md).toContain("(fix #2)");
  });

  it("marks regressions as REGRESSION", () => {
    const sc: Scorecard = {
      target: "nuxt-ui", indexer_seconds: null,
      nodes_by_label: {}, edges_by_type: {}, killer_queries: [],
    };
    const regressionAssertion: Assertion = {
      ...stubAssertion,
      name: "no_tarball_routes",
      baseline_expected: "pass",
    };
    const results: AssertionResult[] = [
      { assertion: regressionAssertion, observed: 4, passed: false, surprised: true },
    ];
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results, baseline: null }]);
    expect(md).toContain("REGRESSION");
    expect(md).toMatch(/✗\s+no_tarball_routes/);
  });

  it("omits the Surprises block when no assertion is surprised", () => {
    const sc: Scorecard = {
      target: "nuxt-ui", indexer_seconds: null,
      nodes_by_label: {}, edges_by_type: {}, killer_queries: [],
    };
    const results: AssertionResult[] = [
      { assertion: stubAssertion, observed: 0, passed: false, surprised: false },
    ];
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results, baseline: null }]);
    expect(md).not.toContain("Surprises");
  });

  it("renders scorecard delta when baseline is provided", () => {
    const sc: Scorecard = {
      target: "nuxt-ui", indexer_seconds: null,
      nodes_by_label: { function: 1103 }, edges_by_type: { HTTP_CALLS: 47, IMPORTS: 538 },
      killer_queries: [],
    };
    const baseline: Baseline = {
      target: "nuxt-ui",
      captured_at: "2026-05-21T00:00:00Z",
      nodes_by_label: { function: 412 },
      edges_by_type: { HTTP_CALLS: 0, IMPORTS: 214 },
      per_assertion: {},
    };
    const md = renderSummary([{ target: "nuxt-ui", scorecard: sc, results: [], baseline }]);
    expect(md).toContain("Scorecard delta");
    expect(md).toMatch(/nodes\.function:\s+412 → 1,?103/);
    expect(md).toMatch(/edges\.HTTP_CALLS:\s+0 → 47/);
  });
});

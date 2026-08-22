import { describe, it, expect } from "vitest";
import { renderSummary } from "../../evals/src/report.js";
import type { Scorecard, AssertionResult, Baseline, Assertion } from "../../evals/src/assertions/types.js";
import { renderUniversalSection } from "../../evals/src/report.js";

const stubAssertion: Assertion = {
  fix_id: 2,
  name: "http_calls_edge_count_nonzero",
  description: "stub",
  query: { kind: "count_edge", type: "HTTP_CALLS" },
  predicate: { op: "gt", value: 0 },
  baseline_expected: "fail",
  scope: "nuxt",
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
      scope: "nuxt",
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

describe("universal metric rendering", () => {
  const base = {
    target: "demo",
    scorecard: { target: "demo", indexer_seconds: null, nodes_by_label: {}, edges_by_type: {}, killer_queries: [] },
    baseline: null,
  };

  // renderUniversalSection now discriminates the per-language branch on the
  // assertion's own query kind rather than the shape of `ratchet` (repo data
  // can forge a map key called "status" and must not be able to pick the
  // branch). Callers that exercise the map-valued metric pass
  // queryKind: "language_density"; everything else defaults to a scalar "sql".
  function report(name: string, observed: unknown, ratchet: unknown, queryKind: "sql" | "language_density" = "sql"): any {
    return {
      ...base,
      results: [{
        assertion: {
          fix_id: "universal",
          name,
          description: "",
          query: queryKind === "language_density" ? { kind: "language_density" } : { kind: "sql", sql: "" },
          baseline_expected: "pass",
          scope: "universal",
          direction: "lower_is_better",
        },
        observed,
        passed: null,
        surprised: false,
        ratchet,
      }],
    };
  }

  it("renders absolute value, delta and a regression flag", () => {
    const lines = renderUniversalSection(
      report("file_sourced_calls", 12, { status: "fail", observed: 12, baseline: 0, delta: 12, improved: false }),
    ).join("\n");
    expect(lines).toContain("file_sourced_calls: 12 (+12) REGRESSED");
  });

  it("keeps the absolute value visible when the metric merely holds steady", () => {
    const lines = renderUniversalSection(
      report("call_attribution_rate", 40.5, { status: "pass", observed: 40.5, baseline: 40.5, delta: 0, improved: false }),
    ).join("\n");
    expect(lines).toContain("40.50");
    expect(lines).not.toContain("REGRESSED");
  });

  it("names an improvement as a stale baseline", () => {
    const lines = renderUniversalSection(
      report("file_sourced_calls", 0, { status: "pass", observed: 0, baseline: 147, delta: -147, improved: true }),
    ).join("\n");
    expect(lines).toContain("IMPROVED — baseline stale");
  });

  it("marks a metric with no baseline rather than failing it", () => {
    const lines = renderUniversalSection(
      report("qn_collisions", 3, { status: "no_baseline", observed: 3 }),
    ).join("\n");
    expect(lines).toContain("no baseline");
    expect(lines).not.toContain("REGRESSED");
  });

  it("labels a language that disappeared since the baseline", () => {
    const lines = renderUniversalSection(
      report("per_language_function_density", { ts: 4.2 }, {
        ts: { status: "pass", observed: 4.2, baseline: 4.2, delta: 0, improved: false },
        rb: { status: "fail", observed: 0, baseline: 2, delta: -2, improved: false },
      }, "language_density"),
    ).join("\n");
    expect(lines).toContain("rb");
    expect(lines).toContain("DISAPPEARED");
  });

  it("does not mistake a language key named 'status' for a scalar outcome", () => {
    const lines = renderUniversalSection(
      report("per_language_function_density", { status: 1.5 }, {
        status: { status: "pass", observed: 1.5, baseline: 1.5, delta: 0, improved: false },
      }, "language_density"),
    ).join("\n");
    expect(lines).toContain("status: 1.50");
  });
});

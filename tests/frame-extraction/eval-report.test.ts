// tests/frame-extraction/eval-report.test.ts
import { describe, it, expect } from "vitest";
import { renderEvalReport } from "../../scripts/frame-extraction/eval-report.js";
import type { EvalReport } from "../../scripts/frame-extraction/types.js";

const report: EvalReport = {
  algorithm: "tfidf+hdbscan",
  repo_slug: "self/cortex",
  generated_at: "2026-05-17T12:00:00Z",
  metrics: {
    cluster_count: 14,
    noise_rate: 0.527,
    total_files: 544,
    co_change_agreement_strict: 0.92,
    co_change_agreement_lenient: 0.32,
    import_agreement_strict: 0.68,
    import_agreement_lenient: 0.41,
    cluster_elapsed_seconds: 3.7,
  },
  internal: {
    silhouette_score: 0.18,
    vocabulary_size: 5432,
    top_tokens_per_cluster: { "0": ["auth", "token", "session"], "1": ["billing", "invoice"] },
  },
  cluster_summary: [
    {
      cluster_id: 0,
      member_count: 12,
      path_prefix: "src/auth/",
      top_tokens: ["auth", "token", "session"],
      sample_paths: ["src/auth/a.ts", "src/auth/b.ts"],
    },
  ],
};

describe("renderEvalReport", () => {
  it("contains the algorithm and repo slug in the heading", () => {
    const md = renderEvalReport(report);
    expect(md).toMatch(/tfidf\+hdbscan/);
    expect(md).toMatch(/self\/cortex/);
  });

  it("renders the metrics table with all keys (strict + lenient agreements)", () => {
    const md = renderEvalReport(report);
    for (const key of [
      "cluster_count", "noise_rate", "total_files",
      "co_change_agreement_strict", "co_change_agreement_lenient",
      "import_agreement_strict", "import_agreement_lenient",
      "cluster_elapsed_seconds",
    ]) {
      expect(md).toContain(key);
    }
  });

  it("renders silhouette + vocabulary in the internal section", () => {
    const md = renderEvalReport(report);
    expect(md).toMatch(/silhouette/i);
    expect(md).toMatch(/0\.18/);
    expect(md).toMatch(/vocabulary/i);
    expect(md).toMatch(/5432/);
  });

  it("renders one row per cluster_summary entry", () => {
    const md = renderEvalReport(report);
    expect(md).toMatch(/src\/auth\//);
    expect(md).toMatch(/auth.*token.*session|auth, token, session/);
  });

  it("handles null cross-signal metrics gracefully (renders as —)", () => {
    const md = renderEvalReport({
      ...report,
      metrics: {
        ...report.metrics,
        co_change_agreement_strict: null,
        co_change_agreement_lenient: null,
        import_agreement_strict: null,
        import_agreement_lenient: null,
      },
    });
    expect(md).toMatch(/co_change_agreement_strict.*—/);
    expect(md).toMatch(/co_change_agreement_lenient.*—/);
    expect(md).toMatch(/import_agreement_strict.*—/);
    expect(md).toMatch(/import_agreement_lenient.*—/);
  });
});

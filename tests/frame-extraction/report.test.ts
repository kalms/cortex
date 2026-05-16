// tests/frame-extraction/report.test.ts
import { describe, it, expect } from "vitest";
import { renderReport } from "../../scripts/frame-extraction/report.js";
import type { SurveyResult } from "../../scripts/frame-extraction/types.js";

const sample: SurveyResult[] = [
  {
    slug: "a/b", archetype: "ts-monorepo", size_hint: "medium",
    primary_language: "typescript", commit_sha: "abc123",
    result: {
      ok: true,
      stats: {
        total_nodes: 500, total_edges: 1500, edge_density: 3.0,
        node_labels: [{ label: "function", count: 200 }],
        entity_count: 200,
        file_count: 100, max_depth: 4, mean_depth: 2.1,
        extension_histogram: { ".ts": 90, ".md": 10 },
        auxiliary_directories: ["locales"],
      },
    },
    elapsed_seconds: 12.3,
  },
  {
    slug: "x/y", archetype: "python-cli", size_hint: "small",
    primary_language: "python", commit_sha: null,
    result: { ok: false, phase: "index", message: "discover: bad" },
    elapsed_seconds: 0.5,
  },
];

describe("renderReport", () => {
  it("includes a row per successful repo with entity_count + edge_density", () => {
    const md = renderReport(sample);
    expect(md).toMatch(/a\/b/);
    expect(md).toMatch(/200/);
    expect(md).toMatch(/3\.000/);
  });

  it("lists failed repos under a Failures heading", () => {
    const md = renderReport(sample);
    expect(md).toMatch(/## Failures/);
    expect(md).toMatch(/x\/y/);
    expect(md).toMatch(/index/);
  });

  it("suggests a threshold band based on the entity_count distribution", () => {
    const md = renderReport(sample);
    expect(md).toMatch(/Suggested threshold/);
  });
});

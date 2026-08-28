import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GraphStore } from "../../src/graph/store.js";
import { runAssertion } from "../../evals/src/assertions/runner.js";
import { UNIVERSAL_ASSERTIONS } from "../../evals/src/assertions/universal.js";
import { applyRatchet } from "../../evals/src/assertions/verdicts.js";
import { renderUniversalSection } from "../../evals/src/report.js";
import { mergeImprovements } from "../../evals/src/baselines.js";
import type { Baseline, TargetReport } from "../../evals/src/assertions/types.js";

/** Every other eval test hand-builds RatchetOutcome objects. That leaves a seam:
 *  nothing checks that what applyRatchet ACTUALLY produces is something the
 *  renderer and the baseline merger can consume. A real crash hid in exactly
 *  that seam — a density map whose keys come from real file extensions took a
 *  branch the renderer could not handle, and threw. These tests run the real
 *  pipeline end to end: graph -> runAssertion -> applyRatchet -> render + merge. */
describe("pipeline seam: real outcomes through the renderer and the merger", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-seam-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function scorecard() {
    return { target: "demo", indexer_seconds: null, nodes_by_label: {}, edges_by_type: {}, killer_queries: [] };
  }

  it("carries every universal metric from a real graph through render and merge", () => {
    // Two languages, one of them named by an extension that previously forged
    // a branch: a file called "notes.text" puts a `text` key in the density map.
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.a", file_path: "a.ts" });
    store.createNode({ kind: "function", name: "f", qualified_name: "p.a.f", file_path: "a.ts" });
    store.createNode({ kind: "file", name: "__file__", qualified_name: "p.n", file_path: "notes.text" });

    const results = UNIVERSAL_ASSERTIONS.map((a) => runAssertion(a, { dbPath }));
    const baseline: Baseline = {
      target: "demo",
      captured_at: "2026-01-01T00:00:00.000Z",
      nodes_by_label: {},
      edges_by_type: {},
      per_assertion: { per_language_function_density: { ts: 1, text: 0 } },
    };

    const ratcheted = applyRatchet(results, baseline);

    // The density metric must survive as a MAP, not collapse to a scalar
    // not_measured — that collapse is what made the renderer throw.
    const density = ratcheted.find((r) => r.assertion.query.kind === "language_density")!;
    expect(density.ratchet).toBeDefined();
    expect("status" in (density.ratchet as object)).toBe(false);

    const report = { target: "demo", scorecard: scorecard(), results: ratcheted, baseline } as unknown as TargetReport;
    const lines = renderUniversalSection(report).join("\n");
    expect(lines).toContain("per_language_function_density");
    expect(lines).toContain("text");
    expect(lines).not.toContain("undefined");
    expect(lines).not.toContain("NaN");

    // And the merger must consume the same outcomes without throwing.
    const { adopted } = mergeImprovements(baseline, ratcheted);
    expect(Array.isArray(adopted)).toBe(true);
  });

  it("renders an unmeasurable metric from an empty graph without inventing a number", () => {
    const results = UNIVERSAL_ASSERTIONS.map((a) => runAssertion(a, { dbPath }));
    const ratcheted = applyRatchet(results, null);
    const report = { target: "demo", scorecard: scorecard(), results: ratcheted, baseline: null } as unknown as TargetReport;

    const lines = renderUniversalSection(report).join("\n");
    expect(lines).not.toContain("NaN");
    expect(lines).not.toContain("undefined");
    // Nothing may be judged against a baseline that does not exist.
    expect(ratcheted.every((r) => r.passed === null)).toBe(true);
    expect(mergeImprovements(
      { target: "demo", captured_at: "", nodes_by_label: {}, edges_by_type: {}, per_assertion: {} },
      ratcheted,
    ).adopted).toEqual([]);
  });
});

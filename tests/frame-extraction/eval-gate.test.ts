// tests/frame-extraction/eval-gate.test.ts
import { describe, it, expect } from "vitest";
import { evaluateF1Gate, F1_GATE_DEFAULTS } from "../../src/frame-extraction/eval-gate.js";

// A baseline of 5 healthy repos averaging ~0.56 weighted F1.
const baseline = [
  { slug: "a", ok: true, cluster_count: 8, label_f1_weighted: 0.60 },
  { slug: "b", ok: true, cluster_count: 12, label_f1_weighted: 0.50 },
  { slug: "c", ok: true, cluster_count: 20, label_f1_weighted: 0.55 },
  { slug: "d", ok: true, cluster_count: 6, label_f1_weighted: 0.65 },
  { slug: "e", ok: true, cluster_count: 10, label_f1_weighted: 0.50 },
];

describe("evaluateF1Gate", () => {
  it("passes when the current run matches the baseline", () => {
    const r = evaluateF1Gate(baseline, baseline);
    expect(r.pass).toBe(true);
    expect(r.enforced).toBe(true);
    expect(r.comparedRepos).toBe(5);
    expect(r.failures).toEqual([]);
  });

  it("fails when the corpus mean regresses beyond the tolerance", () => {
    // drop every repo by 0.10 → mean drops 0.10 > default 0.05 tolerance
    const current = baseline.map((b) => ({ ...b, label_f1_weighted: b.label_f1_weighted - 0.1 }));
    const r = evaluateF1Gate(current, baseline);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/regress/i);
  });

  it("fails when the corpus mean falls below the absolute floor", () => {
    const current = baseline.map((b) => ({ ...b, label_f1_weighted: 0.30 }));
    const r = evaluateF1Gate(current, baseline);
    expect(r.pass).toBe(false);
    expect(r.failures.join(" ")).toMatch(/floor/i);
  });

  it("excludes a degenerate 0-cluster repo from the mean and warns instead of failing", () => {
    // 'a' collapses to 0 clusters this run (f1 0). Without exclusion its 0 would
    // tank the mean and trip the gate; with exclusion the other 4 still pass.
    const current = baseline.map((b) =>
      b.slug === "a" ? { ...b, cluster_count: 0, label_f1_weighted: 0 } : b,
    );
    const r = evaluateF1Gate(current, baseline);
    expect(r.pass).toBe(true);
    expect(r.comparedRepos).toBe(4);
    expect(r.warnings.join(" ")).toMatch(/a.*0 clusters|0 clusters.*a/i);
  });

  it("warns (does not fail) on a single-repo drop when the mean still holds", () => {
    // one repo dives 0.20 (0.50→0.30, enough to warn) but across 5 repos the
    // mean only moves 0.04 — within the 0.05 tolerance → warn, not fail.
    const current = baseline.map((b) =>
      b.slug === "b" ? { ...b, label_f1_weighted: 0.30 } : b,
    );
    const r = evaluateF1Gate(current, baseline);
    expect(r.pass).toBe(true);
    expect(r.warnings.join(" ")).toMatch(/\bb\b/);
  });

  it("does not enforce (never fails) when too few repos overlap the baseline", () => {
    const current = [{ slug: "a", ok: true, cluster_count: 8, label_f1_weighted: 0.10 }];
    const r = evaluateF1Gate(current, baseline);
    expect(r.enforced).toBe(false);
    expect(r.pass).toBe(true);
    // the would-be failure is surfaced as a warning so it is still visible
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("passes with a warning and null means when nothing overlaps the baseline", () => {
    const current = [{ slug: "z", ok: true, cluster_count: 5, label_f1_weighted: 0.5 }];
    const r = evaluateF1Gate(current, baseline);
    expect(r.pass).toBe(true);
    expect(r.comparedRepos).toBe(0);
    expect(r.currentMean).toBeNull();
    expect(r.baselineMean).toBeNull();
  });

  it("exposes documented defaults", () => {
    expect(F1_GATE_DEFAULTS.regressionTolerance).toBeGreaterThan(0);
    expect(F1_GATE_DEFAULTS.absoluteFloor).toBeGreaterThan(0);
    expect(F1_GATE_DEFAULTS.minReposToEnforce).toBeGreaterThanOrEqual(1);
  });
});

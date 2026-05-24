import { describe, it, expect } from "vitest";
import { ALL_ASSERTIONS } from "../../evals/src/assertions/registry.js";

describe("assertion registry", () => {
  it("has at least 18 graph-content assertions", () => {
    expect(ALL_ASSERTIONS.length).toBeGreaterThanOrEqual(18);
  });

  it("every assertion name is unique", () => {
    const names = ALL_ASSERTIONS.map((a) => a.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("baseline_expected is either 'pass' or 'fail'", () => {
    for (const a of ALL_ASSERTIONS) {
      expect(["pass", "fail"]).toContain(a.baseline_expected);
    }
  });

  it("fix_id is one of {2, 3, 4, 5, 6, 8}", () => {
    for (const a of ALL_ASSERTIONS) {
      expect([2, 3, 4, 5, 6, 8]).toContain(a.fix_id);
    }
  });

  it("each fix has at least 2 assertions", () => {
    const byFix: Record<number, number> = {};
    for (const a of ALL_ASSERTIONS) {
      byFix[a.fix_id] = (byFix[a.fix_id] ?? 0) + 1;
    }
    for (const fid of [2, 3, 4, 5, 6, 8]) {
      expect(byFix[fid]).toBeGreaterThanOrEqual(2);
    }
  });
});

import { describe, it, expect } from "vitest";
import { ratchet, RATE_EPSILON, COUNT_EPSILON } from "../../evals/src/assertions/ratchet.js";

describe("ratchet", () => {
  it("reports no_baseline when the metric has never been captured", () => {
    const r = ratchet(12, undefined, "lower_is_better", COUNT_EPSILON);
    expect(r).toEqual({ status: "no_baseline", observed: 12 });
  });

  it("lower_is_better: fails when the value rises beyond epsilon", () => {
    const r = ratchet(12, 0, "lower_is_better", COUNT_EPSILON);
    expect(r.status).toBe("fail");
    expect(r).toMatchObject({ observed: 12, baseline: 0, delta: 12 });
  });

  it("lower_is_better: passes when the value falls", () => {
    expect(ratchet(0, 147, "lower_is_better", COUNT_EPSILON).status).toBe("pass");
  });

  it("higher_is_better: fails when the value drops beyond epsilon", () => {
    expect(ratchet(40, 92, "higher_is_better", RATE_EPSILON).status).toBe("fail");
  });

  it("higher_is_better: passes when the value rises", () => {
    expect(ratchet(93, 92, "higher_is_better", RATE_EPSILON).status).toBe("pass");
  });

  it("tolerates movement within epsilon in the bad direction", () => {
    // 92.0 -> 91.6 is a 0.4pp drop, inside the 0.5pp rate epsilon.
    expect(ratchet(91.6, 92, "higher_is_better", RATE_EPSILON).status).toBe("pass");
  });

  it("fails just outside epsilon", () => {
    expect(ratchet(91.4, 92, "higher_is_better", RATE_EPSILON).status).toBe("fail");
  });

  it("exact: fails on any difference", () => {
    expect(ratchet(1, 0, "exact", COUNT_EPSILON).status).toBe("fail");
    expect(ratchet(0, 0, "exact", COUNT_EPSILON).status).toBe("pass");
  });

  it("flags movement in the good direction beyond epsilon as improved", () => {
    expect(ratchet(0, 147, "lower_is_better", COUNT_EPSILON)).toMatchObject({
      status: "pass",
      improved: true,
    });
  });

  it("does not call movement within epsilon an improvement", () => {
    // 0.4pp of upward drift is noise, not a gain worth locking in.
    expect(ratchet(92.4, 92, "higher_is_better", RATE_EPSILON)).toMatchObject({
      status: "pass",
      improved: false,
    });
  });

  it("never reports an exact-direction metric as improved", () => {
    expect(ratchet(0, 0, "exact", COUNT_EPSILON)).toMatchObject({
      status: "pass",
      improved: false,
    });
  });

  it("reports delta as observed minus baseline", () => {
    expect(ratchet(5, 3, "lower_is_better", COUNT_EPSILON).delta).toBe(2);
  });
});

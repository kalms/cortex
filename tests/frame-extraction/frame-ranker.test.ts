import { describe, it, expect } from "vitest";
import { genericPenalty } from "../../src/frame-extraction/inject-frames.js";
import { ambientBudget } from "../../src/frame-extraction/frame-ranker.js";

describe("genericPenalty", () => {
  it("returns 1.0 for a fully specific label", () => {
    expect(genericPenalty("checkout-payment")).toBe(1);
  });

  it("returns 0 for a fully generic label", () => {
    // "src", "utils" are both in the stop-list / short-token rule
    expect(genericPenalty("src-utils")).toBe(0);
  });

  it("returns the non-generic fraction for a mixed label", () => {
    // "core" is generic, "checkout" is not → 1 of 2 specific
    expect(genericPenalty("core-checkout")).toBe(0.5);
  });

  it("returns 0 for an empty label", () => {
    expect(genericPenalty("")).toBe(0);
  });
});

describe("ambientBudget", () => {
  it("floors at 4 for tiny repos", () => {
    expect(ambientBudget(1)).toBe(4);
    expect(ambientBudget(5)).toBe(4); // ceil(3.5)=4
  });

  it("caps at 10 for large repos", () => {
    expect(ambientBudget(31)).toBe(10); // ceil(21.7)=22 → capped 10
    expect(ambientBudget(100)).toBe(10);
  });

  it("scales by 0.7 in the mid band", () => {
    expect(ambientBudget(10)).toBe(7); // ceil(7.0)=7
    expect(ambientBudget(9)).toBe(7);  // ceil(6.3)=7
  });

  it("returns 0 for zero frames", () => {
    expect(ambientBudget(0)).toBe(0);
  });
});

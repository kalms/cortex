import { describe, it, expect } from "vitest";
import { genericPenalty } from "../../src/frame-extraction/inject-frames.js";

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

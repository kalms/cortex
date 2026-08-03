import { describe, it, expect } from "vitest";
import {
  dotBudget, labelAlpha, shedAlpha, applyHysteresis, interEdgeZoomFade,
  quantizeAlpha, PX_PER_DOT, MIN_DOTS,
} from "../../src/viewer/canvas/lod.js";

describe("lod", () => {
  it("calibration: a full-size 150×120 frame at fit ≈ today's 22-dot cap", () => {
    expect(dotBudget(150 * 120, 100)).toBe(22); // 18000 / 800 = 22.5 → 22
  });
  it("squeeze relief: a small on-screen frame shows fewer dots, floored at MIN_DOTS", () => {
    expect(dotBudget(60 * 50, 100)).toBe(MIN_DOTS);
    expect(dotBudget(60 * 50, 4)).toBe(4); // never more than the members
  });
  it("zoom reveal: area grows quadratically with zoom and lifts the budget to all members", () => {
    const base = dotBudget(150 * 120, 100);
    const zoomed2x = dotBudget(150 * 2 * 120 * 2, 100);
    expect(zoomed2x).toBeGreaterThan(base * 3);
    expect(dotBudget(150 * 4 * 120 * 4, 100)).toBe(100); // capped at members
  });
  it("labelAlpha ramps across the spacing band", () => {
    expect(labelAlpha(64)).toBe(0);
    expect(labelAlpha(80)).toBeCloseTo(0.5, 5);
    expect(labelAlpha(96)).toBe(1);
    expect(labelAlpha(200)).toBe(1);
  });
  it("shedAlpha is 1 at/above fit and fades during overscroll", () => {
    expect(shedAlpha(1)).toBe(1);
    expect(shedAlpha(2)).toBe(1);
    expect(shedAlpha(0.8)).toBeCloseTo(0.35, 5);
  });
  it("hysteresis holds a ±1 target wobble", () => {
    expect(applyHysteresis(22, 23)).toBe(22);
    expect(applyHysteresis(22, 21)).toBe(22);
    expect(applyHysteresis(22, 24)).toBe(24);
  });
  it("interEdgeZoomFade holds at 1 through fit, then recedes with zoom", () => {
    expect(interEdgeZoomFade(1)).toBe(1);
    expect(interEdgeZoomFade(1.25)).toBe(1);
    expect(interEdgeZoomFade(2.5)).toBeCloseTo(0.5, 5);
    expect(interEdgeZoomFade(4)).toBeCloseTo(Math.max(0.3, 0.3125), 5);
  });
  it("quantizeAlpha snaps to 1/32 steps and clamps to [0,1]", () => {
    expect(quantizeAlpha(0.151)).toBe(0.15625);
    expect(quantizeAlpha(0)).toBe(0);
    expect(quantizeAlpha(1.2)).toBe(1);
    expect(quantizeAlpha(-0.3)).toBe(0);
  });
  it("quantizeAlpha is monotonic over [0,1]", () => {
    let prev = -Infinity;
    for (let i = 0; i <= 100; i++) {
      const a = i / 100;
      const q = quantizeAlpha(a);
      expect(q).toBeGreaterThanOrEqual(prev);
      prev = q;
    }
  });
});

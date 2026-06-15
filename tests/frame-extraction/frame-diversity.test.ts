// tests/frame-extraction/frame-diversity.test.ts
import { describe, it, expect } from "vitest";
import {
  selectAmbientByDiversity,
  DIVERSITY_DECAY,
  type DiversityInput,
} from "../../src/frame-extraction/frame-diversity.js";

const f = (frame_id: number, score: number, layer: DiversityInput["layer"]): DiversityInput =>
  ({ frame_id, score, layer });

describe("selectAmbientByDiversity — Phase 1 (fill, decay, ceremony cap)", () => {
  it("returns all ids when budget >= frame count", () => {
    const got = selectAmbientByDiversity([f(1, 5, "domain"), f(2, 3, "data")], 5);
    expect(got).toEqual(new Set([1, 2]));
  });

  it("returns empty for budget 0 or no frames", () => {
    expect(selectAmbientByDiversity([f(1, 5, "domain")], 0)).toEqual(new Set());
    expect(selectAmbientByDiversity([], 4)).toEqual(new Set());
  });

  it("caps ceremony at one when non-ceremony candidates exist", () => {
    const frames = [
      f(1, 10, "ceremony"), f(2, 9, "ceremony"), f(3, 8, "ceremony"),
      f(4, 5, "interface"), f(5, 4, "data"),
    ];
    const got = selectAmbientByDiversity(frames, 3);
    const ceremonyCount = [...got].filter((id) => frames.find((x) => x.frame_id === id)!.layer === "ceremony").length;
    expect(ceremonyCount).toBe(1);
    expect(got).toEqual(new Set([1, 4, 5]));
  });

  it("relaxes the ceremony cap only when nothing else remains", () => {
    const frames = [f(1, 10, "ceremony"), f(2, 9, "ceremony"), f(3, 8, "ceremony")];
    const got = selectAmbientByDiversity(frames, 3);
    expect(got).toEqual(new Set([1, 2, 3]));
  });

  it("geometric decay evicts a 3rd same-layer frame for an unrepresented layer", () => {
    expect(DIVERSITY_DECAY).toBe(0.6);
    const frames = [
      f(1, 10, "interface"), f(2, 9, "interface"), f(3, 8, "interface"),
      f(4, 7, "interface"), f(5, 4, "data"),
    ];
    const got = selectAmbientByDiversity(frames, 3);
    expect(got).toEqual(new Set([1, 2, 5]));
  });

  it("first pick is always the top raw score (decay inert at count 0)", () => {
    const frames = [f(1, 3, "data"), f(2, 10, "interface"), f(3, 5, "domain")];
    const got = selectAmbientByDiversity(frames, 1);
    expect(got).toEqual(new Set([2]));
  });
});

describe("selectAmbientByDiversity — Phase 2 (bounded coverage repair)", () => {
  it("promotes a below-cut data frame when it clears the floor, displacing the weakest", () => {
    // budget 2. Phase 1: interface#1 ×1=10 (slot 1); then interface#2 ×0.6=5.4
    //   beats data ×1=5 → interface#2 takes slot 2. data is left OUT despite the
    //   repo having it — so Phase 2 must repair coverage.
    // Phase 2: data candidate (5). Both interface frames are displaceable
    //   (interface has 2 reps); weakest = interface#2 (9). floor: 5 >= 0.5*9=4.5
    //   → swap data in for interface#2.
    const frames = [
      { frame_id: 1, score: 10, layer: "interface" as const },
      { frame_id: 2, score: 9, layer: "interface" as const },
      { frame_id: 3, score: 5, layer: "data" as const },
    ];
    const got = selectAmbientByDiversity(frames, 2);
    expect(got).toEqual(new Set([1, 3]));
  });

  it("refuses promotion when the candidate is below the floor (coverage not guaranteed)", () => {
    // data(2) vs weakest displaceable interface(6): 2 >= 0.5*6=3 is FALSE → no swap.
    const frames = [
      { frame_id: 1, score: 10, layer: "interface" as const },
      { frame_id: 2, score: 6, layer: "interface" as const },
      { frame_id: 3, score: 2, layer: "data" as const },
    ];
    const got = selectAmbientByDiversity(frames, 2);
    expect(got).toEqual(new Set([1, 2])); // data NOT injected
  });

  it("skips a required layer the repo does not have", () => {
    // No data frame anywhere → coverage skips data, no error.
    const frames = [
      { frame_id: 1, score: 10, layer: "interface" as const },
      { frame_id: 2, score: 6, layer: "interface" as const },
      { frame_id: 3, score: 5, layer: "domain" as const },
    ];
    const got = selectAmbientByDiversity(frames, 2);
    // Phase 1 (budget 2): interface(10), then interface ×0.6=3.6 vs domain ×1=5
    //   → domain(5) wins slot 2. Both interface+domain present; no repair needed.
    expect(got).toEqual(new Set([1, 3]));
  });

  it("never displaces the sole representative of another required layer", () => {
    // budget 2, frames span domain, interface, data — all required, all wanted.
    // Phase 1 fills 2 slots (domain 10, interface 8). data(7) is missing but the
    // only displaceable candidates (domain, interface) are each a sole required
    // rep → no safe displacement → data stays out (bounded, not forced).
    const frames = [
      { frame_id: 1, score: 10, layer: "domain" as const },
      { frame_id: 2, score: 8, layer: "interface" as const },
      { frame_id: 3, score: 7, layer: "data" as const },
    ];
    const got = selectAmbientByDiversity(frames, 2);
    expect(got).toEqual(new Set([1, 2]));
  });

  it("displaces an over-represented required layer to make room for coverage", () => {
    const frames = [
      { frame_id: 1, score: 10, layer: "domain" as const },
      { frame_id: 2, score: 9, layer: "domain" as const },
      { frame_id: 3, score: 8, layer: "interface" as const },
      { frame_id: 4, score: 5, layer: "data" as const },
    ];
    // Phase 1 (budget 3): domain(10) ×1; then domain#2 ×0.6=5.4 vs interface(8) ×1=8
    //   → interface(8); then domain#2 ×0.6=5.4 vs data(5) ×1=5 → domain#2(5.4).
    //   selected = {1(domain), 3(interface), 2(domain)}. data missing.
    // Phase 2: data candidate (5). Displaceable required reps with count≥2: domain
    //   has 2 reps → weakest domain = id2(score 9). 5 >= 0.5*9=4.5 → swap.
    const got = selectAmbientByDiversity(frames, 3);
    expect(got).toEqual(new Set([1, 3, 4]));
  });
});

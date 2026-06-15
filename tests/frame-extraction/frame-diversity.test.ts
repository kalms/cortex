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

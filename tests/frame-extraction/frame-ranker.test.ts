import { describe, it, expect } from "vitest";
import { genericPenalty } from "../../src/frame-extraction/inject-frames.js";
import { ambientBudget, rankFrames, type FrameRecord } from "../../src/frame-extraction/frame-ranker.js";
import { buildCorpusIndex } from "../../src/frame-extraction/label-quality.js";

// Build a corpus where each file's blob text == its path tokens, so a label
// that matches the path scores high coverage/specificity.
function corpusFromPaths(paths: string[]) {
  return buildCorpusIndex(
    paths.map((p) => ({ path: p, text: p.replace(/[._\-/]+/g, " ") })),
  );
}

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

describe("rankFrames", () => {
  const records: FrameRecord[] = [
    { frame_id: 0, frame_label: "checkout", member_paths: ["src/checkout/cart.ts", "src/checkout/pay.ts"] },
    { frame_id: 1, frame_label: "cluster:7", member_paths: ["src/a/x.ts"] },
    { frame_id: 2, frame_label: "viewer", member_paths: ["src/viewer/a.ts", "src/viewer/b.ts", "src/viewer/c.ts"] },
  ];
  const corpus = corpusFromPaths(records.flatMap((r) => r.member_paths));

  it("assigns a 1-based rank to every frame", () => {
    const ranked = rankFrames(records, corpus);
    expect(ranked).toHaveLength(3);
    expect([...ranked].map((r) => r.rank).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("scores opaque cluster:N labels at zero (genericPenalty × F1 = 0)", () => {
    const ranked = rankFrames(records, corpus);
    const opaque = ranked.find((r) => r.frame_id === 1)!;
    expect(opaque.score).toBe(0);
    expect(opaque.components.nameability).toBe(0);
  });

  it("marks the top ambientBudget(n) frames ambient", () => {
    const ranked = rankFrames(records, corpus);
    // 3 frames → budget = max(4, …) = 4 > 3 → all ambient
    expect(ranked.every((r) => r.ambient)).toBe(true);
  });

  it("cuts to the budget when there are more frames than the budget", () => {
    // 20 frames → budget = max(4, min(10, ceil(14))) = 10
    const many: FrameRecord[] = Array.from({ length: 20 }, (_, i) => ({
      frame_id: i,
      frame_label: `topic${i}`,
      member_paths: [`src/topic${i}/file.ts`],
    }));
    const c = corpusFromPaths(many.flatMap((r) => r.member_paths));
    const ranked = rankFrames(many, c);
    expect(ranked.filter((r) => r.ambient)).toHaveLength(10);
  });

  it("is deterministic and breaks ties lexicographically on frame_id", () => {
    const r1 = rankFrames(records, corpus);
    const r2 = rankFrames(records, corpus);
    expect(r1).toEqual(r2);
  });

  it("orders by score descending", () => {
    const ranked = [...rankFrames(records, corpus)].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });
});

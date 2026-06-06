// tests/frame-extraction/intruder.test.ts
import { describe, it, expect } from "vitest";
import { buildIntruderTrials } from "../../scripts/frame-extraction/intruder.js";
import type { ClusterAssignment } from "../../src/frame-extraction/types.js";

const clusters: ClusterAssignment[] = [
  { cluster_id: 0, member_paths: ["auth/a.ts", "auth/b.ts", "auth/c.ts", "auth/d.ts"] },
  { cluster_id: 1, member_paths: ["billing/x.ts", "billing/y.ts", "billing/z.ts"] },
  { cluster_id: -1, member_paths: ["noise/n.ts"] },
];

// Deterministic picker: always take the first eligible index.
const pickFirst = (n: number): number => 0;

describe("buildIntruderTrials", () => {
  it("builds one trial per non-noise cluster with a known intruder from another cluster", () => {
    const trials = buildIntruderTrials(clusters, { membersPerTrial: 3, pick: pickFirst });
    expect(trials).toHaveLength(2); // skips noise
    const t0 = trials.find((t) => t.cluster_id === 0)!;
    expect(t0.member_sample).toHaveLength(3);
    expect(t0.member_sample.every((p) => p.startsWith("auth/"))).toBe(true);
    expect(t0.intruder_path.startsWith("auth/")).toBe(false); // from another cluster
    expect(t0.candidates).toContain(t0.intruder_path);
    expect(t0.candidates).toHaveLength(4); // 3 members + 1 intruder
  });

  it("skips a cluster that cannot supply enough members", () => {
    const tiny: ClusterAssignment[] = [
      { cluster_id: 0, member_paths: ["a.ts"] },
      { cluster_id: 1, member_paths: ["b.ts", "c.ts"] },
    ];
    const trials = buildIntruderTrials(tiny, { membersPerTrial: 3, pick: pickFirst });
    expect(trials.find((t) => t.cluster_id === 0)).toBeUndefined();
  });
});

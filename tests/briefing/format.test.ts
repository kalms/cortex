import { describe, it, expect } from "vitest";
import { formatHeadline } from "../../src/briefing/format.js";

describe("formatHeadline", () => {
  it("renders a governed + drifting headline with the decision and verdict", () => {
    const out = formatHeadline({
      target: "src/foo.ts::bar",
      decision: { id: "D-xyz", title: "Do it this way", displayState: "active · drifting", verdict: "partial" },
      callerCount: 4,
      fanoutThreshold: 12,
      pr: 39,
    });
    const lines = out.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(out).toContain("D-xyz");
    expect(out).toContain("Do it this way");
    expect(out).toContain("active · drifting");
    expect(out).toContain("4 callers");
    expect(out).toContain("PR #39");
    expect(out).toContain("context_pack");
  });

  it("renders a blast-radius-only headline (no decision, no PR)", () => {
    const out = formatHeadline({
      target: "src/util.ts::helper",
      callerCount: 30,
      fanoutThreshold: 12,
    });
    expect(out).toContain("30 callers");
    expect(out).not.toContain("PR #");
    expect(out).not.toMatch(/D-/);
  });
});

import { vi, describe, it, expect } from "vitest";
import { briefForTarget } from "../../../src/cli/commands/brief.js";
import { blastRadius } from "../../../src/briefing/blast-radius.js";

vi.mock("../../../src/briefing/blast-radius.js", () => ({ blastRadius: vi.fn() }));

describe("briefForTarget (pure core of runBriefCommand)", () => {
  it("returns empty headline + exit 0 when ungated", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const r = briefForTarget(
      {
        search: { findGoverning: () => [] },
        decisions: { get: () => null },
        links: { findByDecision: () => [] },
        store: {} as any,
        project: "p",
        repoPath: "/nonexistent",
      } as any,
      "src/x.ts::y",
      { fanoutThreshold: 12 },
    );
    expect(r.headline).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("returns exit 2 when escalated", () => {
    vi.mocked(blastRadius).mockReturnValue(1);
    const r = briefForTarget(
      {
        search: { findGoverning: () => [{ id: "D-x", title: "t", status: "active" }] },
        decisions: { get: () => ({ reconciliation_verdict: "drift" }) },
        links: { findByDecision: () => [] },
        store: {} as any,
        project: "p",
        repoPath: "/nonexistent",
      } as any,
      "src/foo.ts::bar",
      { fanoutThreshold: 12 },
    );
    expect(r.exitCode).toBe(2);
    expect(r.headline).toContain("D-x");
  });
});

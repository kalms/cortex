import { vi, describe, it, expect } from "vitest";
import { composeBriefing } from "../../src/briefing/compose.js";
import { blastRadius } from "../../src/briefing/blast-radius.js";
import type { BriefingDeps } from "../../src/briefing/types.js";

vi.mock("../../src/briefing/blast-radius.js", () => ({ blastRadius: vi.fn() }));

function deps(over: Partial<{ governing: any[]; record: any }>): BriefingDeps {
  const governing = over.governing ?? [];
  return {
    search: { findGoverning: () => governing } as any,
    decisions: { get: () => over.record ?? null } as any,
    store: {} as any,
    project: "p",
  };
}

describe("composeBriefing", () => {
  it("returns ungated/silent when nothing trips the gate", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const b = composeBriefing(deps({}), "src/x.ts::y", { fanoutThreshold: 12 });
    expect(b.gated).toBe(false);
    expect(b.headline).toBe("");
  });

  it("gates + escalates on a partial-verdict governing decision", () => {
    vi.mocked(blastRadius).mockReturnValue(3);
    const b = composeBriefing(
      deps({
        governing: [{ id: "D-xyz", title: "Do it this way", status: "active" }],
        record: { reconciliation_verdict: "partial" },
      }),
      "src/foo.ts::bar",
      { fanoutThreshold: 12 },
    );
    expect(b.gated).toBe(true);
    expect(b.escalate).toBe(true);
    expect(b.headline).toContain("D-xyz");
    expect(b.headline).toContain("drifting");
  });

  it("gates without escalating on high blast radius alone", () => {
    vi.mocked(blastRadius).mockReturnValue(30);
    const b = composeBriefing(deps({}), "src/util.ts::helper", { fanoutThreshold: 12 });
    expect(b.gated).toBe(true);
    expect(b.escalate).toBe(false);
    expect(b.headline).toContain("30 callers");
  });
});

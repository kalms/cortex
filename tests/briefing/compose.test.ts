import { vi, describe, it, expect } from "vitest";
import { composeBriefing } from "../../src/briefing/compose.js";
import { blastRadius } from "../../src/briefing/blast-radius.js";
import type { BriefingDeps } from "../../src/briefing/types.js";

vi.mock("../../src/briefing/blast-radius.js", () => ({ blastRadius: vi.fn() }));

/**
 * Build a BriefingDeps stub.
 * - `governing`: list of decision stubs returned by findGoverning
 * - `record`: single record returned for every id (legacy shorthand; used by existing tests)
 * - `records`: id → record map; takes precedence over `record` when present
 */
function deps(
  over: Partial<{ governing: any[]; record: any; records: Record<string, any> }>,
): BriefingDeps {
  const governing = over.governing ?? [];
  return {
    search: { findGoverning: () => governing } as any,
    decisions: {
      get: (id: string) => {
        if (over.records) return over.records[id] ?? null;
        return over.record ?? null;
      },
    } as any,
    links: { findByDecision: () => [] } as any,
    store: {} as any,
    project: "p",
    repoPath: "/nonexistent",
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

  // --- Defect 1: superseded decisions must never drive a briefing ---

  it("superseded-only: returns ungated/silent (no active decision)", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const b = composeBriefing(
      deps({
        governing: [{ id: "D-old", title: "old", status: "superseded" }],
        records: { "D-old": { reconciliation_verdict: "drift" } },
      }),
      "src/freshness.ts",
      { fanoutThreshold: 12 },
    );
    expect(b.gated).toBe(false);
    expect(b.escalate).toBe(false);
    expect(b.headline).toBe("");
    expect(b.headline).not.toContain("D-old");
  });

  it("superseded ignored when an active decision also governs", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const b = composeBriefing(
      deps({
        governing: [
          { id: "D-a", title: "active one", status: "active" },
          { id: "D-b", title: "superseded one", status: "superseded" },
        ],
        records: {
          "D-a": { reconciliation_verdict: "match" },
          "D-b": { reconciliation_verdict: "drift" },
        },
      }),
      "src/foo.ts",
      { fanoutThreshold: 12 },
    );
    // Active match decision gates but doesn't escalate; superseded drift is ignored.
    expect(b.gated).toBe(true);
    expect(b.escalate).toBe(false);
    expect(b.headline).toContain("D-a");
    expect(b.headline).not.toContain("D-b");
  });

  // --- Defect 2: worst active verdict chosen when multiple active decisions govern ---

  it("worst active verdict chosen: partial wins over match", () => {
    vi.mocked(blastRadius).mockReturnValue(0);
    const b = composeBriefing(
      deps({
        governing: [
          { id: "D-x", title: "match decision", status: "active" },
          { id: "D-y", title: "partial decision", status: "active" },
        ],
        records: {
          "D-x": { reconciliation_verdict: "match" },
          "D-y": { reconciliation_verdict: "partial" },
        },
      }),
      "src/frame-layout.ts",
      { fanoutThreshold: 12 },
    );
    // D-y (partial=worse) must surface, not D-x (match=best).
    expect(b.gated).toBe(true);
    expect(b.escalate).toBe(true);
    expect(b.headline).toContain("D-y");
    expect(b.headline).not.toContain("D-x");
  });
});

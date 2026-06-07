import { describe, it, expect } from "vitest";
import { renderFreshnessLine } from "../../src/cli/commands/freshness.js";

describe("renderFreshnessLine", () => {
  it("renders fresh", () => {
    expect(renderFreshnessLine({ state: "fresh" })).toBe("fresh");
  });
  it("renders stale with the note", () => {
    expect(renderFreshnessLine({ state: "stale:dirty", note: "uncommitted changes present — results may be stale, reindex to refresh" }))
      .toContain("stale:dirty");
  });
  it("renders degraded/empty as actionable", () => {
    expect(renderFreshnessLine({ state: "empty", note: "graph DB empty or degraded — reindex needed (index_repository)" }))
      .toContain("reindex");
  });
});

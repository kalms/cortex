import { describe, it, expect } from "vitest";
import { sectionHeader } from "../../src/mcp-server/tools/context-pack.js";

describe("sectionHeader", () => {
  it("renders a showing-window when total exceeds shown", () => {
    expect(sectionHeader("CALLERS", 10, 23)).toBe("## CALLERS (showing 10 of 23)");
  });

  it("renders just the total when nothing was truncated", () => {
    expect(sectionHeader("CALLERS", 3, 3)).toBe("## CALLERS (3)");
  });

  it("renders (0) for an empty section", () => {
    expect(sectionHeader("CALLERS", 0, 0)).toBe("## CALLERS (0)");
  });
});

import { describe, it, expect } from "vitest";
import { deriveModule } from "../../src/architecture/module-path.js";

describe("deriveModule", () => {
  it("maps a nested source file to src/<module>", () => {
    expect(deriveModule("src/mcp-server/tools/code-tools.ts")).toBe("src/mcp-server");
  });
  it("maps a two-level source file", () => {
    expect(deriveModule("src/cli/main.ts")).toBe("src/cli");
  });
  it("drops root-level files under a source root (too coarse)", () => {
    expect(deriveModule("src/index.ts")).toBeNull();
  });
  it("keeps non-source top-level dirs as their own module", () => {
    expect(deriveModule("hooks/check-index.sh")).toBe("hooks");
  });
  it("excludes noise dirs at any depth", () => {
    expect(deriveModule("tests/architecture/x.test.ts")).toBeNull();
    expect(deriveModule("src/mcp-server/__tests__/x.ts")).toBeNull();
    expect(deriveModule("docs/architecture/frame-extraction.md")).toBeNull();
  });
  it("returns null for empty/nullish", () => {
    expect(deriveModule(null)).toBeNull();
    expect(deriveModule("")).toBeNull();
  });
});

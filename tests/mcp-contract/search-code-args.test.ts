import { describe, it, expect } from "vitest";
import { buildRgArgs, buildGrepFallbackArgs } from "../../src/mcp-server/tools/code-tools.js";

describe("search_code argv builders", () => {
  it("buildRgArgs: caps results with --max-count=200", () => {
    const args = buildRgArgs("ribbon");
    expect(args).toContain("--max-count");
    const idx = args.indexOf("--max-count");
    expect(args[idx + 1]).toBe("200");
  });

  it("buildRgArgs: includes pattern and current dir", () => {
    const args = buildRgArgs("ribbon");
    expect(args).toContain("ribbon");
    expect(args).toContain(".");
  });

  it("buildGrepFallbackArgs: excludes node_modules", () => {
    const args = buildGrepFallbackArgs("ribbon");
    expect(args).toContain("--exclude-dir=node_modules");
  });

  it("buildGrepFallbackArgs: excludes .git, dist, build, .cache, vendored", () => {
    const args = buildGrepFallbackArgs("ribbon");
    expect(args).toContain("--exclude-dir=.git");
    expect(args).toContain("--exclude-dir=dist");
    expect(args).toContain("--exclude-dir=build");
    expect(args).toContain("--exclude-dir=.cache");
    expect(args).toContain("--exclude-dir=vendored");
  });

  it("buildGrepFallbackArgs: preserves -rn and pattern", () => {
    const args = buildGrepFallbackArgs("ribbon");
    expect(args).toContain("-rn");
    expect(args).toContain("ribbon");
    expect(args).toContain(".");
  });
});

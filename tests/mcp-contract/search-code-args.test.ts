import { describe, it, expect } from "vitest";
import { isAbsolute } from "node:path";
import {
  buildRgArgs,
  buildGrepFallbackArgs,
  resolveRgBinary,
} from "../../src/mcp-server/tools/code-tools.js";

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

  // The fallback used to recurse the whole repo, including ~1.7 GB of derived
  // and scratch trees (.tmp eval clones, .cortex DBs, python .venv). That made
  // it time out (10 s) or exit 2 on an unreadable file — surfaced as an opaque
  // internal_error. Exclude those trees so a no-rg user still gets results.
  it("buildGrepFallbackArgs: excludes derived/scratch dirs (.tmp, .cortex, .venv)", () => {
    const args = buildGrepFallbackArgs("ribbon");
    expect(args).toContain("--exclude-dir=.tmp");
    expect(args).toContain("--exclude-dir=.cortex");
    expect(args).toContain("--exclude-dir=.venv");
  });

  it("buildGrepFallbackArgs: skips binary files and caps matches per file", () => {
    const args = buildGrepFallbackArgs("ribbon");
    expect(args).toContain("-I"); // skip binary files (DBs, object files)
    expect(args).toContain("-m");
    const idx = args.indexOf("-m");
    expect(args[idx + 1]).toBe("200");
  });
});

describe("resolveRgBinary", () => {
  it("honors the CORTEX_RG_PATH override", () => {
    const prev = process.env.CORTEX_RG_PATH;
    process.env.CORTEX_RG_PATH = "/custom/path/to/rg";
    try {
      expect(resolveRgBinary()).toBe("/custom/path/to/rg");
    } finally {
      if (prev === undefined) delete process.env.CORTEX_RG_PATH;
      else process.env.CORTEX_RG_PATH = prev;
    }
  });

  it("defaults to the bundled absolute rg path (or bare 'rg' if unavailable)", () => {
    const prev = process.env.CORTEX_RG_PATH;
    delete process.env.CORTEX_RG_PATH;
    try {
      const bin = resolveRgBinary();
      expect(bin.length).toBeGreaterThan(0);
      // Either the bundled @vscode/ripgrep absolute path, or the PATH fallback.
      expect(isAbsolute(bin) || bin === "rg").toBe(true);
    } finally {
      if (prev !== undefined) process.env.CORTEX_RG_PATH = prev;
    }
  });
});

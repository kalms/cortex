// tests/frame-extraction/auxiliary-detection.test.ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_AUXILIARY_SEGMENTS,
  isAuxiliaryPath,
} from "../../src/frame-extraction/auxiliary-detection.js";

describe("isAuxiliaryPath", () => {
  it("matches a top-level auxiliary segment", () => {
    expect(isAuxiliaryPath("vendor/lodash/index.js")).toBe(true);
    expect(isAuxiliaryPath("node_modules/react/index.js")).toBe(true);
    expect(isAuxiliaryPath("dist/bundle.js")).toBe(true);
  });

  it("matches a nested auxiliary segment", () => {
    expect(isAuxiliaryPath("internal/indexer/vendored/grammars/c/parser.h")).toBe(true);
    expect(isAuxiliaryPath("packages/api/build/server.js")).toBe(true);
    expect(isAuxiliaryPath("tests/__snapshots__/login.snap")).toBe(true);
  });

  it("returns false for non-auxiliary paths", () => {
    expect(isAuxiliaryPath("src/auth/middleware.ts")).toBe(false);
    expect(isAuxiliaryPath("src/billing/invoice.ts")).toBe(false);
    expect(isAuxiliaryPath("internal/indexer/src/pipeline/pass.c")).toBe(false);
  });

  it("requires exact segment match (not substring)", () => {
    // 'static' should not match 'staticAnalysis'
    expect(isAuxiliaryPath("src/staticAnalysis/check.ts")).toBe(false);
    // 'vendor' should not match 'vendoredAlternative' (but `vendored` itself IS in
    // the default list, so check a fictitious extension we know isn't covered).
    expect(isAuxiliaryPath("src/vendorsale/index.ts")).toBe(false);
  });

  it("returns false for empty path", () => {
    expect(isAuxiliaryPath("")).toBe(false);
  });

  it("accepts a custom segments set", () => {
    const custom = new Set(["thirdparty"]);
    expect(isAuxiliaryPath("thirdparty/foo.js", custom)).toBe(true);
    expect(isAuxiliaryPath("vendor/foo.js", custom)).toBe(false);
  });

  it("default set includes the spec's path patterns + cortex variants", () => {
    // Spec list:
    for (const seg of ["locales", "i18n", "__snapshots__", "fixtures",
                       "assets", "static", "public", "vendor",
                       "generated", "dist", "build"]) {
      expect(DEFAULT_AUXILIARY_SEGMENTS.has(seg)).toBe(true);
    }
    // Cortex variants:
    expect(DEFAULT_AUXILIARY_SEGMENTS.has("vendored")).toBe(true);
    expect(DEFAULT_AUXILIARY_SEGMENTS.has("node_modules")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { CORTEX_INDEXER_VERSION, indexerAssetName } from "../../src/indexer/version.js";

describe("indexerAssetName", () => {
  it("maps the three supported targets to tarball names", () => {
    const v = CORTEX_INDEXER_VERSION;
    expect(indexerAssetName("darwin", "arm64")).toBe(`cortex-indexer-${v}-darwin-arm64.tar.gz`);
    expect(indexerAssetName("linux", "x64")).toBe(`cortex-indexer-${v}-linux-x64.tar.gz`);
    expect(indexerAssetName("linux", "arm64")).toBe(`cortex-indexer-${v}-linux-arm64.tar.gz`);
  });

  it("returns null for unsupported platform/arch (incl. darwin-x64, which has no prebuilt)", () => {
    expect(indexerAssetName("darwin", "x64")).toBeNull();
    expect(indexerAssetName("win32", "x64")).toBeNull();
    expect(indexerAssetName("linux", "ia32")).toBeNull();
    expect(indexerAssetName("darwin", "ppc64")).toBeNull();
  });

  it("pins an exact semver string", () => {
    expect(CORTEX_INDEXER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

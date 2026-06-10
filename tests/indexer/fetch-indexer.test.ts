import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assetNameFor, FETCH_INDEXER_VERSION, sha256Hex } from "../../scripts/fetch-indexer.mjs";
import { CORTEX_INDEXER_VERSION, indexerAssetName } from "../../src/indexer/version.js";

describe("fetch-indexer pure helpers", () => {
  it("version + asset mapping stay in lockstep with src/indexer/version.ts (drift guard)", () => {
    expect(FETCH_INDEXER_VERSION).toBe(CORTEX_INDEXER_VERSION);
    for (const [p, a] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"]]) {
      expect(assetNameFor(p, a)).toBe(indexerAssetName(p, a));
    }
    expect(assetNameFor("win32", "x64")).toBeNull();
  });

  it("computes sha256 of a buffer", () => {
    const buf = Buffer.from("hello");
    const expected = createHash("sha256").update(buf).digest("hex");
    expect(sha256Hex(buf)).toBe(expected);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { resolveIndexerBinary } from "../../src/indexer/binary.js";

const ORIG = process.env.CORTEX_INDEXER_PATH;
afterEach(() => {
  if (ORIG === undefined) delete process.env.CORTEX_INDEXER_PATH;
  else process.env.CORTEX_INDEXER_PATH = ORIG;
  delete process.env.CBM_BINARY_PATH;
});

describe("resolveIndexerBinary", () => {
  it("honors CORTEX_INDEXER_PATH override", () => {
    process.env.CORTEX_INDEXER_PATH = "/custom/indexer";
    expect(resolveIndexerBinary()).toBe("/custom/indexer");
  });

  it("falls back to the bundled bin/cortex-indexer path", () => {
    delete process.env.CORTEX_INDEXER_PATH;
    expect(resolveIndexerBinary()).toMatch(/[/\\]bin[/\\]cortex-indexer$/);
  });

  it("ignores the dead CBM_BINARY_PATH alias", () => {
    delete process.env.CORTEX_INDEXER_PATH;
    process.env.CBM_BINARY_PATH = "/legacy/cbm";
    expect(resolveIndexerBinary()).not.toBe("/legacy/cbm");
  });
});

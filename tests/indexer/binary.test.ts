import { afterEach, describe, expect, it } from "vitest";
import { resolveIndexerBinary, ensureIndexer, IndexerNotInstalledError, IndexerVersionMismatchError } from "../../src/indexer/binary.js";
import { CORTEX_INDEXER_VERSION } from "../../src/indexer/version.js";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Write a fake indexer that prints the given JSON for `--version`. */
function fakeIndexer(versionJson: object): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-indexer-"));
  const bin = join(dir, "cortex-indexer");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo '${JSON.stringify(versionJson)}'; fi\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** Write a fake indexer that prints non-JSON garbage for `--version`. */
function fakeLegacyIndexer(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-legacy-"));
  const bin = join(dir, "cortex-indexer");
  writeFileSync(bin, `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo 'cbm version 0.5 (legacy plaintext)'; fi\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("ensureIndexer", () => {
  afterEach(() => { delete process.env.CORTEX_INDEXER_PATH; });

  it("returns the path when version matches the pin", async () => {
    const bin = fakeIndexer({ version: CORTEX_INDEXER_VERSION, schema: 1, protocol: 1 });
    process.env.CORTEX_INDEXER_PATH = bin;
    await expect(ensureIndexer({ noCache: true })).resolves.toBe(bin);
  });

  it("throws IndexerNotInstalledError when the binary is absent", async () => {
    process.env.CORTEX_INDEXER_PATH = "/nonexistent/cortex-indexer";
    await expect(ensureIndexer({ noCache: true })).rejects.toBeInstanceOf(IndexerNotInstalledError);
  });

  it("throws IndexerVersionMismatchError on a version mismatch (default path)", async () => {
    const bin = fakeIndexer({ version: "9.9.9", schema: 1, protocol: 1 });
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true }))
      .rejects.toBeInstanceOf(IndexerVersionMismatchError);
  });

  it("skips the version assertion when CORTEX_INDEXER_PATH is set (dev override)", async () => {
    const bin = fakeIndexer({ version: "9.9.9", schema: 1, protocol: 1 });
    process.env.CORTEX_INDEXER_PATH = bin;
    await expect(ensureIndexer({ noCache: true })).resolves.toBe(bin);
  });

  it("treats a non-JSON --version as a legacy binary and does not throw", async () => {
    const bin = fakeLegacyIndexer();
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true })).resolves.toBe(bin);
  });

  it("throws IndexerNotInstalledError when the binary exists but is not executable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noexec-"));
    const bin = join(dir, "cortex-indexer");
    writeFileSync(bin, "not executable\n");
    chmodSync(bin, 0o644);
    await expect(ensureIndexer({ noCache: true, binaryPath: bin, assertVersion: true }))
      .rejects.toBeInstanceOf(IndexerNotInstalledError);
  });

  it("returns the cached path on the second call without re-checking (cache hit)", async () => {
    const bin = fakeIndexer({ version: CORTEX_INDEXER_VERSION, schema: 1, protocol: 1 });
    process.env.CORTEX_INDEXER_PATH = bin;
    // First call (caching enabled) populates the module cache.
    const first = await ensureIndexer();
    expect(first).toBe(bin);
    // Point the env elsewhere; a cache HIT must ignore it and return the cached path.
    process.env.CORTEX_INDEXER_PATH = "/nonexistent/changed-indexer";
    const second = await ensureIndexer();
    expect(second).toBe(bin);
  });
});

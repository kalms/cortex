import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assetNameFor, FETCH_INDEXER_VERSION, sha256Hex, fetchIndexer } from "../../scripts/fetch-indexer.mjs";
import { CORTEX_INDEXER_VERSION, indexerAssetName } from "../../src/indexer/version.js";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** Build a real .tar.gz containing an executable `cortex-indexer`, return {buf, sha}. */
function makeAssetTarball() {
  const dir = mkdtempSync(join(tmpdir(), "asset-"));
  const bin = join(dir, "cortex-indexer");
  writeFileSync(bin, "#!/bin/sh\necho ok\n");
  chmodSync(bin, 0o755);
  const tgz = join(dir, "asset.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", dir, "cortex-indexer"]);
  const buf = readFileSync(tgz);
  return { buf, sha: sha256Hex(buf) };
}

describe("fetchIndexer download", () => {
  it("downloads, verifies sha256, extracts, and installs the binary", async () => {
    const { buf, sha } = makeAssetTarball();
    const asset = assetNameFor(process.platform, process.arch);
    if (!asset) return; // unsupported runner platform — covered by soft-warn test below
    const server = createServer((req, res) => {
      if (req.url.endsWith(".sha256")) { res.end(`${sha}  ${asset}\n`); return; }
      res.end(buf);
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const destDir = mkdtempSync(join(tmpdir(), "bin-"));

    const result = await fetchIndexer({
      baseUrl: `http://127.0.0.1:${port}`,
      destDir,
      cacheDir: mkdtempSync(join(tmpdir(), "cache-")),
    });
    server.close();

    expect(result.installed).toBe(true);
    expect(existsSync(join(destDir, "cortex-indexer"))).toBe(true);
  });

  it("soft-warns (no throw, installed=false) when the asset 404s", async () => {
    const server = createServer((_req, res) => { res.statusCode = 404; res.end("nope"); });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const result = await fetchIndexer({
      baseUrl: `http://127.0.0.1:${port}`,
      destDir: mkdtempSync(join(tmpdir(), "bin-")),
      cacheDir: mkdtempSync(join(tmpdir(), "cache-")),
    });
    server.close();
    expect(result.installed).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

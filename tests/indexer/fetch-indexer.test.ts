import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assetNameFor, FETCH_INDEXER_VERSION, sha256Hex, fetchIndexer } from "../../scripts/fetch-indexer.mjs";
import { CORTEX_INDEXER_VERSION, indexerAssetName } from "../../src/indexer/version.js";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
afterAll(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

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
  const dir = tmp("asset-");
  const bin = join(dir, "cortex-indexer");
  writeFileSync(bin, "#!/bin/sh\necho ok\n");
  chmodSync(bin, 0o755);
  const tgz = join(dir, "asset.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", dir, "cortex-indexer"]);
  const buf = readFileSync(tgz);
  return { buf, sha: sha256Hex(buf) };
}

describe("fetchIndexer download", () => {
  const supported = assetNameFor(process.platform, process.arch);
  it.skipIf(!supported)("downloads, verifies sha256, extracts, and installs the binary", async () => {
    const { buf, sha } = makeAssetTarball();
    const server = createServer((req, res) => {
      if (req.url.endsWith(".sha256")) { res.end(`${sha}  ${supported}\n`); return; }
      res.end(buf);
    });
    await new Promise((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const destDir = tmp("bin-");

    const result = await fetchIndexer({
      baseUrl: `http://127.0.0.1:${port}`,
      destDir,
      cacheDir: tmp("cache-"),
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
      destDir: tmp("bin-"),
      cacheDir: tmp("cache-"),
    });
    server.close();
    expect(result.installed).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it.skipIf(!assetNameFor(process.platform, process.arch))("uses a pre-seeded cache without downloading", async () => {
    const cacheDir = tmp("cache-");
    const platDir = join(cacheDir, FETCH_INDEXER_VERSION, `${process.platform}-${process.arch}`);
    mkdirSync(platDir, { recursive: true });
    const cacheBin = join(platDir, "cortex-indexer");
    writeFileSync(cacheBin, "#!/bin/sh\necho cached\n");
    chmodSync(cacheBin, 0o755);
    const destDir = tmp("bin-");
    // baseUrl points at an unreachable port; a cache hit must never contact it.
    const result = await fetchIndexer({ baseUrl: "http://127.0.0.1:1", destDir, cacheDir });
    expect(result.installed).toBe(true);
    expect(existsSync(join(destDir, "cortex-indexer"))).toBe(true);
  });
});

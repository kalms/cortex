// scripts/fetch-indexer.mjs
// Postinstall downloader for the prebuilt cortex-indexer binary. Plain ESM:
// runs at `npm install` time before any TypeScript build, so it must not
// import from dist/ or src/.
import { createHash } from "node:crypto";

// MUST equal CORTEX_INDEXER_VERSION in src/indexer/version.ts (drift-guard test).
export const FETCH_INDEXER_VERSION = "0.3.1";

// Mirror of SUPPORTED in src/indexer/version.ts (drift-guard test enforces it).
// darwin-x64 intentionally absent — no prebuilt is published (macos-13 runners
// no longer dispatch); Intel-Mac users build from source.
const SUPPORTED = new Set(["darwin-arm64", "linux-x64", "linux-arm64"]);

export function assetNameFor(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.has(key)) return null;
  return `cortex-indexer-${FETCH_INDEXER_VERSION}-${key}.tar.gz`;
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

import { mkdirSync, writeFileSync, copyFileSync, chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_BASE_URL =
  process.env.CORTEX_INDEXER_BASE_URL ||
  "https://github.com/ruevu/cortex-indexer/releases/download";

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download + verify + extract the pinned binary into destDir/cortex-indexer.
 * Never throws on an expected miss (unsupported platform, 404, offline):
 * returns { installed:false, reason } so postinstall can warn and exit 0.
 */
export async function fetchIndexer({ baseUrl = DEFAULT_BASE_URL, destDir, cacheDir } = {}) {
  const asset = assetNameFor(process.platform, process.arch);
  if (!asset) {
    return { installed: false, reason: `no prebuilt asset for ${process.platform}-${process.arch}` };
  }
  const base = `${baseUrl}/v${FETCH_INDEXER_VERSION}`;
  const cacheBin = join(cacheDir, FETCH_INDEXER_VERSION, `${process.platform}-${process.arch}`, "cortex-indexer");
  mkdirSync(destDir, { recursive: true });

  try {
    if (!existsSync(cacheBin)) {
      const [tgz, shaText] = await Promise.all([
        download(`${base}/${asset}`),
        download(`${base}/${asset}.sha256`),
      ]);
      const want = shaText.toString("utf8").trim().split(/\s+/)[0];
      const got = sha256Hex(tgz);
      if (want !== got) throw new Error(`checksum mismatch for ${asset}: want ${want}, got ${got}`);

      const cacheParent = join(cacheBin, "..");
      mkdirSync(cacheParent, { recursive: true });
      // Extract into a staging dir on the same filesystem, then atomically
      // rename into place — so existsSync(cacheBin) implies a COMPLETE binary
      // (an interrupted extraction leaves only the staging dir, never cacheBin).
      const stageDir = mkdtempSync(join(cacheParent, ".stage-"));
      try {
        const tmpTgz = join(stageDir, "asset.tar.gz");
        writeFileSync(tmpTgz, tgz);
        execFileSync("tar", ["-xzf", tmpTgz, "-C", stageDir, "cortex-indexer"]);
        const stagedBin = join(stageDir, "cortex-indexer");
        chmodSync(stagedBin, 0o755);
        renameSync(stagedBin, cacheBin);
      } finally {
        rmSync(stageDir, { recursive: true, force: true });
      }
    }
    copyFileSync(cacheBin, join(destDir, "cortex-indexer"));
    chmodSync(join(destDir, "cortex-indexer"), 0o755);
    return { installed: true, from: cacheBin };
  } catch (e) {
    return { installed: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// CLI entry: only runs when invoked directly (postinstall), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const result = await fetchIndexer({
    destDir: join(root, "bin"),
    cacheDir: join(homedir(), ".cache", "cortex-indexer", "bin"),
  });
  if (result.installed) {
    console.log(`cortex-indexer ${FETCH_INDEXER_VERSION} installed (${result.from ?? "downloaded"}).`);
  } else {
    console.warn(
      `WARN: cortex-indexer not installed (${result.reason}). ` +
      `Run \`npm run fetch-indexer\` to retry, or set CORTEX_INDEXER_PATH to a ` +
      `locally built binary. Cortex tools will report indexer_unavailable until then.`,
    );
  }
}

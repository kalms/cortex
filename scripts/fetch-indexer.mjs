// scripts/fetch-indexer.mjs
// Postinstall downloader for the prebuilt cortex-indexer binary. Plain ESM:
// runs at `npm install` time before any TypeScript build, so it must not
// import from dist/ or src/.
import { createHash } from "node:crypto";

// MUST equal CORTEX_INDEXER_VERSION in src/indexer/version.ts (drift-guard test).
export const FETCH_INDEXER_VERSION = "0.3.0";

const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);

export function assetNameFor(platform, arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.has(key)) return null;
  return `cortex-indexer-${FETCH_INDEXER_VERSION}-${key}.tar.gz`;
}

export function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

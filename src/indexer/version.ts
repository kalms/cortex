/**
 * The exact cortex-indexer release this build of cortex is pinned to.
 * Single source of truth for the fetcher and the runtime version check.
 * Bumping the indexer is an explicit, reviewable cortex commit.
 *
 * NOTE: mirror any change in scripts/fetch-indexer.mjs (drift-guard test in
 * tests/indexer/fetch-indexer.test.ts enforces equality).
 */
export const CORTEX_INDEXER_VERSION = "0.3.0";

/** Supported (platform, arch) targets → release asset basename, else null. */
const SUPPORTED = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
]);

export function indexerAssetName(
  platform: NodeJS.Platform | string,
  arch: string,
): string | null {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.has(key)) return null;
  return `cortex-indexer-${CORTEX_INDEXER_VERSION}-${key}.tar.gz`;
}

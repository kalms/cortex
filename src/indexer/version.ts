/**
 * The exact cortex-indexer release this build of cortex is pinned to.
 * Single source of truth for the fetcher and the runtime version check.
 * Bumping the indexer is an explicit, reviewable cortex commit.
 *
 * NOTE: mirror any change in scripts/fetch-indexer.mjs (drift-guard test in
 * tests/indexer/fetch-indexer.test.ts enforces equality).
 */
export const CORTEX_INDEXER_VERSION = "0.3.1";

/**
 * Supported (platform, arch) targets → release asset basename, else null.
 *
 * darwin-x64 (Intel Mac) is intentionally absent: GitHub's macos-13 runners no
 * longer dispatch reliably, so cortex-indexer publishes no darwin-x64 asset.
 * Intel-Mac users hit the actionable "build from source" path, not a 404.
 */
const SUPPORTED = new Set([
  "darwin-arm64",
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

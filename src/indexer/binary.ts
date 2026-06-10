import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** Bundled location written by the fetcher / legacy build: <repo>/bin/cortex-indexer. */
export const LOCAL_INDEXER = join(__dirname, "..", "..", "bin", "cortex-indexer");

/**
 * Resolve the indexer binary path. `CORTEX_INDEXER_PATH` is the sole override
 * (dev workflow: point at a locally built binary). The legacy `CBM_BINARY_PATH`
 * alias is intentionally NOT consulted — it was removed with the repo split.
 */
export function resolveIndexerBinary(): string {
  return process.env.CORTEX_INDEXER_PATH || LOCAL_INDEXER;
}

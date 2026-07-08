import { homedir } from "node:os";
import { join } from "node:path";
import { durableStoreRoot } from "./resolve-path.js";

/** Slug-form of an absolute path, matching the standalone indexer's cache
 *  filename convention (leading slash dropped, remaining slashes → '-'). */
export function cacheSlug(absPath: string): string {
  return absPath.replace(/^\//, "").replace(/\//g, "-");
}

/** Base dir of the standalone indexer's cache. Honors `$CTX_CACHE_DIR`
 *  (the indexer's own relocation env), else `~/.cache/cortex-indexer`. */
export function indexerCacheDir(): string {
  const env = process.env.CTX_CACHE_DIR;
  return env && env.trim() ? env : join(homedir(), ".cache", "cortex-indexer");
}

/** The legacy per-repo slug cache path for a canonical repo root. */
export function slugCachePath(repoRoot: string): string {
  return join(indexerCacheDir(), `${cacheSlug(repoRoot)}.db`);
}

/** Where content-bearing orphan decision dirs are archived (never deleted). */
export function archiveRoot(): string {
  return join(durableStoreRoot(), "_archive");
}

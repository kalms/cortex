import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

const CACHE_DIR = join(homedir(), ".cache", "cortex");

function indexerVersion(): string {
  try {
    return execSync(`${process.env.CORTEX_INDEXER_PATH || "bin/cortex-indexer"} --version`, {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function grammarPackHash(): string {
  // Post-split the grammars live in the separate cortex-indexer repo, not here,
  // so this dir is normally absent in cortex — that's expected, not an error.
  // Grammar changes ship via a new indexer release with a bumped version, and
  // indexerVersion() (the binary's --version, which includes the version) is
  // already part of the cache key, so it invalidates on grammar changes. The
  // constant below keeps the key stable; the branch survives only for repos
  // that still vendor grammars in-tree (e.g. a local cortex-indexer checkout).
  const grammarRoot = join(process.cwd(), "internal", "indexer", "vendored", "grammars");
  if (!existsSync(grammarRoot)) {
    return "no-grammars";
  }
  const h = createHash("sha256");
  function walk(dir: string) {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else {
        h.update(relative(grammarRoot, p));
        h.update("\0");
        h.update(readFileSync(p));
      }
    }
  }
  walk(grammarRoot);
  return h.digest("hex");
}

function gitTreeHash(repo: string): string {
  try {
    return execSync("git rev-parse HEAD^{tree}", { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "no-tree";
  }
}

/** Index depth the indexer binary supports. `full` is the default and indexes
 * every pass; `fast`/`moderate` skip passes, so they produce a different graph
 * and must NOT share a cache entry with `full` (or each other). */
export type IndexMode = "fast" | "moderate" | "full";

export function computeCacheKey(repo: string, mode: IndexMode = "full"): string {
  const parts = [indexerVersion(), grammarPackHash(), gitTreeHash(repo)];
  // `full` is the historical default — omit it so entries written before mode
  // existed stay valid. Non-full modes hash a distinct key so a partial snapshot
  // can never be served for a deeper request.
  if (mode !== "full") parts.push(`mode:${mode}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

export function cachePath(key: string): string {
  return join(CACHE_DIR, `${key}.db`);
}

export function hasCacheEntry(key: string): boolean {
  return existsSync(cachePath(key));
}

export function writeCacheEntry(key: string, sourceDbPath: string): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  copyFileSync(sourceDbPath, cachePath(key));
}

/** @returns true if cache hit (entry copied to destDbPath), false on miss */
export function readCacheEntry(key: string, destDbPath: string): boolean {
  if (!hasCacheEntry(key)) return false;
  copyFileSync(cachePath(key), destDbPath);
  return true;
}

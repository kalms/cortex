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
  // Phase 9 may relocate this. If the dir is missing the key is still
  // deterministic, but grammar updates no longer invalidate it — log loudly
  // so a future path-break doesn't silently kill cache correctness.
  const grammarRoot = join(process.cwd(), "internal", "indexer", "internal", "cbm", "vendored", "grammars");
  if (!existsSync(grammarRoot)) {
    process.stderr.write(`Cortex cache: grammar dir not found at ${grammarRoot}; cache keys will not invalidate on grammar changes\n`);
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

export function computeCacheKey(repo: string): string {
  const parts = [indexerVersion(), grammarPackHash(), gitTreeHash(repo)];
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

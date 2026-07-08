import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { readRepoId } from "./repo-id.js";
import { durableStoreRoot } from "./resolve-path.js";
import { archiveRoot, indexerCacheDir, slugCachePath } from "./store-paths.js";

export { readRepoId };

/** repoIds of currently-registered repos (the "live" set). */
export function liveRepoIds(entries: { root_path: string }[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    const id = readRepoId(e.root_path);
    if (id) out.add(id);
  }
  return out;
}

/** True iff the decisions.db in this dir has zero decision rows. Any open/query
 *  failure returns false — never treat an uninspectable store as empty. */
export function isEmptyDecisionDir(repoIdDir: string): boolean {
  const dbPath = join(repoIdDir, "decisions.db");
  if (!existsSync(dbPath)) return false;
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as { n: number };
    return row.n === 0;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** True iff <repoRoot>/.cortex/db opens as SQLite with ≥1 nodes row. */
export function hasValidCanonicalGraph(repoRoot: string): boolean {
  const dbPath = join(repoRoot, ".cortex", "db");
  if (!existsSync(dbPath)) return false;
  let db: BetterSqlite3.Database | null = null;
  try {
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    return db.prepare("SELECT 1 FROM nodes LIMIT 1").get() !== undefined;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** A slug cache is reapable when its repo's canonical graph provably exists,
 *  or the repo path is gone entirely. Otherwise it may be the only copy — keep. */
export function isReapableSlugCache(repoRoot: string): boolean {
  return !existsSync(repoRoot) || hasValidCanonicalGraph(repoRoot);
}

/** True iff `path` exists and its mtime is older than maxAgeMs before nowMs. */
export function isStaleStaging(path: string, nowMs: number, maxAgeMs: number): boolean {
  try {
    return nowMs - statSync(path).mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

/** Unlink a db file plus its -wal/-shm sidecars. Returns bytes freed — only for
 *  sidecars whose unlink actually succeeded. */
export function reapFile(path: string): number {
  let bytes = 0;
  for (const ext of ["", "-wal", "-shm"]) {
    const p = path + ext;
    try {
      const size = statSync(p).size;
      unlinkSync(p);
      bytes += size;
    } catch { /* absent or unlink failed — fine, don't count it */ }
  }
  return bytes;
}

/** Move a content-bearing orphan decision dir to the archive. Never deletes.
 *  Returns the destination path, or null if the source is missing. */
export function archiveDecisionDir(repoId: string): string | null {
  const src = join(durableStoreRoot(), repoId);
  if (!existsSync(src)) return null;
  mkdirSync(archiveRoot(), { recursive: true });
  let dest = join(archiveRoot(), repoId);
  let n = 1;
  while (existsSync(dest)) dest = join(archiveRoot(), `${repoId}-${n++}`);
  renameSync(src, dest);
  return dest;
}

/** Reap the repo's slug cache iff safe (canonical exists or repo gone). */
export function reapRepoSlugCache(repoRoot: string): number {
  if (!isReapableSlugCache(repoRoot)) return 0;
  return reapFile(slugCachePath(repoRoot));
}

/** Current-repo SessionStart sweep: reap this repo's slug cache (guarded) + its
 *  db.stage-* siblings + stale tmp-ctx_incr_* files in the shared cache dir. */
export function sweepCurrentRepo(
  repoRoot: string,
  opts: { maxStagingAgeMs?: number } = {},
): { bytes: number; removed: string[] } {
  const maxAge = opts.maxStagingAgeMs ?? 86_400_000;
  const now = Date.now();
  let bytes = 0;
  const removed: string[] = [];

  const slugBytes = reapRepoSlugCache(repoRoot);
  if (slugBytes > 0) { bytes += slugBytes; removed.push(slugCachePath(repoRoot)); }

  // db.stage-* under <repoRoot>/.cortex
  const cortexDir = join(repoRoot, ".cortex");
  try {
    for (const f of readdirSync(cortexDir)) {
      if (f.startsWith("db.stage-")) {
        const p = join(cortexDir, f);
        if (isStaleStaging(p, now, maxAge)) {
          const b = reapFile(p); if (b > 0) { bytes += b; removed.push(p); }
        }
      }
    }
  } catch { /* no .cortex — fine */ }

  // stale tmp-ctx_incr_* in the shared indexer cache dir
  try {
    for (const f of readdirSync(indexerCacheDir())) {
      if (f.startsWith("tmp-ctx_incr_") && f.endsWith(".db")) {
        const p = join(indexerCacheDir(), f);
        if (isStaleStaging(p, now, maxAge)) {
          const b = reapFile(p); if (b > 0) { bytes += b; removed.push(p); }
        }
      }
    }
  } catch { /* no cache dir — fine */ }

  return { bytes, removed };
}

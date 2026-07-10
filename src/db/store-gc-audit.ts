import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Registry } from "./registry.js";
import { durableStoreRoot } from "./resolve-path.js";
import { indexerCacheDir, slugCachePath } from "./store-paths.js";
import {
  liveRepoIds, isEmptyDecisionDir, isReapableSlugCache, isStaleStaging,
  reapFile, archiveDecisionDir, repoRootFromSlug,
} from "./store-gc.js";

export interface StoreAudit {
  reapable: { path: string; bytes: number; reason: string }[];
  archiveCandidates: { repoId: string; dir: string }[];
}

/** Best-effort total size (bytes) of the immediate files in a directory. */
function dirSize(path: string): number {
  let n = 0;
  try {
    for (const f of readdirSync(path)) {
      try { n += statSync(join(path, f)).size; } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return n;
}

/** Best-effort size (bytes) of a single file. */
function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * Dry-run classification across all storage buckets: durable decision dirs
 * (`~/.cortex/<repoId>`) and the shared indexer cache (slug caches + stale
 * staging files). Never touches disk.
 */
export function auditStores(registry: Registry): StoreAudit {
  const reapable: StoreAudit["reapable"] = [];
  const archiveCandidates: StoreAudit["archiveCandidates"] = [];
  const now = Date.now();
  const live = liveRepoIds(registry.list());
  const home = durableStoreRoot();

  // (a) decision dirs
  try {
    for (const repoId of readdirSync(home)) {
      if (repoId === "_archive") continue;
      const dir = join(home, repoId);
      const isLive = live.has(repoId);
      if (isEmptyDecisionDir(dir)) {
        reapable.push({ path: dir, bytes: dirSize(dir), reason: "empty decision dir" });
        continue;
      }
      if (!isLive) archiveCandidates.push({ repoId, dir });
    }
  } catch { /* no durable home */ }

  // (b) slug caches + stale staging in the indexer cache dir
  try {
    const registered = registry.list();
    for (const f of readdirSync(indexerCacheDir())) {
      if (f === "_registry.db") continue;
      const p = join(indexerCacheDir(), f);
      if (f.startsWith("tmp-ctx_incr_") && f.endsWith(".db")) {
        if (isStaleStaging(p, now, 86_400_000)) {
          reapable.push({ path: p, bytes: fileSize(p), reason: "stale staging" });
        }
        continue;
      }
      if (!f.endsWith(".db")) continue;
      // Map slug → a registered repo root; reap if that repo has a canonical graph or is gone.
      const owner = registered.find((r) => slugCachePath(r.root_path) === p);
      if (owner) {
        if (isReapableSlugCache(owner.root_path)) {
          reapable.push({ path: p, bytes: fileSize(p), reason: "consumed slug cache" });
        }
      } else {
        // No registered owner — reconstruct a candidate repo root from the slug
        // (best-effort, lossy) and apply the same guard as the registered-owner
        // branch: reap only if that root is gone or has a valid canonical graph.
        // A wrong reconstruction just yields a non-existent path → reap, same
        // as before; a correct one protects a live repo's only graph copy.
        const candidateRoot = repoRootFromSlug(basename(p, ".db"));
        if (isReapableSlugCache(candidateRoot)) {
          reapable.push({ path: p, bytes: fileSize(p), reason: "orphan slug cache (no registered repo)" });
        }
      }
    }
  } catch { /* no cache dir */ }

  return { reapable, archiveCandidates };
}

/**
 * Apply the audit: `rmSync` for empty decision dirs, `reapFile` for
 * regenerable cache files, `archiveDecisionDir` (move, never delete) for
 * content-bearing orphan decision dirs. Best-effort — a failure on one
 * finding does not abort the rest.
 */
export function fixStores(registry: Registry, audit: StoreAudit): { bytesReaped: number; archived: string[] } {
  let bytesReaped = 0;
  const archived: string[] = [];
  for (const r of audit.reapable) {
    try {
      if (existsSync(join(r.path, "decisions.db"))) {
        // A directory finding (empty decision dir) — never a file target for reapFile.
        const bytes = dirSize(r.path);
        rmSync(r.path, { recursive: true, force: true });
        bytesReaped += bytes;
      } else {
        bytesReaped += reapFile(r.path);
      }
    } catch { /* best-effort */ }
  }
  for (const c of audit.archiveCandidates) {
    try { if (archiveDecisionDir(c.repoId)) archived.push(c.repoId); } catch { /* best-effort */ }
  }
  return { bytesReaped, archived };
}

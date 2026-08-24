import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { readRepoId } from "./repo-id.js";
import { durableStoreRoot } from "./resolve-path.js";
import { archiveRoot, indexerCacheDir, slugCachePath } from "./store-paths.js";
import { Registry, type RegistryRepo } from "./registry.js";
import { mainWorktreeRoot } from "./git-root.js";

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

/** Best-effort reconstruction of a repo root from a slug-cache filename.
 *  The slug flatten (/ → -) is lossy, so this is only a CANDIDATE: a repo
 *  path containing a literal '-' segment won't round-trip. It exists solely
 *  to apply the same reap guard to orphan slug caches as everywhere else —
 *  a wrong guess yields a non-existent path, which isReapableSlugCache treats
 *  as "gone" (→ reap), identical to the prior unguarded behavior; a correct
 *  guess protects a live repo whose only graph copy is the cache. */
export function repoRootFromSlug(slug: string): string {
  return "/" + slug.replace(/-/g, "/");
}

/** Reap the repo's slug cache iff safe (canonical exists or repo gone). */
export function reapRepoSlugCache(repoRoot: string): number {
  if (!isReapableSlugCache(repoRoot)) return 0;
  return reapFile(slugCachePath(repoRoot));
}

/** True iff `entry` belongs to the CURRENT repo's family for registry-prune
 *  purposes: this checkout's own row (`root_path === repoRoot`), or any row
 *  whose `worktree_of` points at this repo's main-worktree root (a removed
 *  worktree of the SAME repo). Every other repo's rows are out of family.
 *
 *  This is what keeps the SessionStart sweep — which runs in EVERY repo, on
 *  every session start, with output discarded — from silently dropping an
 *  unrelated repo's registry row just because that repo happens to be on an
 *  unmounted volume or a detached network share at the moment this session's
 *  sweep runs. `cortex doctor --fix` remains the machine-wide backstop: it is
 *  dry-run by default and prints every row before removing anything. */
function isSameRepoFamily(
  entry: Pick<RegistryRepo, "root_path" | "worktree_of">,
  repoRoot: string,
  mainRoot: string | null,
): boolean {
  if (entry.root_path === repoRoot) return true;
  return mainRoot !== null && entry.worktree_of === mainRoot;
}

/** Remove registry rows whose path is confirmed gone AT THE MOMENT OF
 *  REMOVAL — `existsCheck` is re-run immediately before each individual
 *  `remove`, rather than computing a "dead" snapshot once and pruning the
 *  whole batch from it afterward. `reg.list()` and a batched prune are not
 *  atomic; a path that goes absent → present in that window (a worktree
 *  re-created, a flaky mount coming back) must survive on its current state,
 *  not be deleted on stale information. `existsCheck` defaults to the real
 *  `existsSync` and is only overridden by tests. Returns the names actually
 *  removed. */
export function pruneVanishedRows(
  reg: Registry,
  candidates: Pick<RegistryRepo, "name" | "root_path">[],
  existsCheck: (p: string) => boolean = existsSync,
): string[] {
  const pruned: string[] = [];
  for (const c of candidates) {
    if (!existsCheck(c.root_path)) {
      reg.remove(c.name);
      pruned.push(c.name);
    }
  }
  return pruned;
}

/** Current-repo SessionStart sweep: reap this repo's slug cache (guarded) + its
 *  db.stage-* siblings + stale tmp-ctx_incr_* files in the shared cache dir,
 *  plus dead registry rows scoped to this repo's family (see below). No-op
 *  (returns an empty result) when `CORTEX_GC=0` — checked here, not just by
 *  `runSweep`, so the destructive registry mutation stays behind the gate for
 *  every caller, not only the one that happens to check the env var today. */
export function sweepCurrentRepo(
  repoRoot: string,
  opts: { maxStagingAgeMs?: number; registryPath?: string } = {},
): { bytes: number; removed: string[]; prunedRows: string[] } {
  if (process.env.CORTEX_GC === "0") return { bytes: 0, removed: [], prunedRows: [] };
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

  // Dead-row reclamation, SCOPED TO THIS REPO'S FAMILY (isSameRepoFamily,
  // above). `git worktree remove` takes the directory and its .cortex/db
  // with it but leaves the registry row; worktrees are short-lived, so THIS
  // repo's dead worktree rows must be reclaimed on the SessionStart sweep
  // rather than waiting for a manual `cortex doctor --fix` — but every other
  // repo's rows are left strictly alone; only `cortex doctor --fix` (the
  // machine-wide, dry-run-first backstop) touches those. Best-effort: a
  // registry failure never fails the sweep.
  const prunedRows: string[] = [];
  try {
    // `Registry`'s constructor defaults to `defaultRegistryPath()` when its
    // arg is `undefined`, so the production call path (`runSweep`, which
    // calls `sweepCurrentRepo(repoRoot)` with no `opts` at all) resolves to
    // the real registry — not a no-op.
    const reg = new Registry(opts.registryPath);
    try {
      // Repo-identity axis, not the checkout axis: `worktree_of` is written
      // against `mainWorktreeRoot`, so family membership must be tested
      // against it too. Degrades to `null` outside a git repo / on any git
      // failure — never throws — which narrows family to just this
      // checkout's own row.
      const mainRoot = mainWorktreeRoot(repoRoot);
      const family = reg.list().filter((e) => isSameRepoFamily(e, repoRoot, mainRoot));
      prunedRows.push(...pruneVanishedRows(reg, family));
    } finally { reg.close(); }
  } catch { /* best-effort */ }

  return { bytes, removed, prunedRows };
}

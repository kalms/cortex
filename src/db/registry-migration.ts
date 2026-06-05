// src/db/registry-migration.ts
import BetterSqlite3 from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Registry, legacyRegistryPath } from "./registry.js";

/** One-shot, idempotent: carry rows from the pre-XDG registry location
 *  (`~/.cache/cortex-indexer/_registry.db`) into the current registry. Covers
 *  repos registered via register-on-index that have no legacy cache `<slug>.db`
 *  to re-seed from. Best-effort; reads the old file read-only and leaves it in
 *  place. No-op when the old file is absent (fresh installs). */
export function importLegacyRegistry(
  registry: Registry,
  legacyPath: string = legacyRegistryPath(),
): void {
  if (!existsSync(legacyPath)) return;
  let old: BetterSqlite3.Database | null = null;
  try {
    old = new BetterSqlite3(legacyPath, { readonly: true, fileMustExist: true });
    const rows = old
      .prepare("SELECT name, root_path, indexed_at FROM repos")
      .all() as Array<{ name: string; root_path: string; indexed_at?: string }>;
    for (const r of rows) {
      if (!r?.name || !r?.root_path) continue;
      registry.register(r.name, r.root_path, r.indexed_at ?? new Date().toISOString());
    }
  } catch {
    // best-effort (old file unreadable / pre-`repos`-schema)
  } finally {
    old?.close();
  }
}

/** One-shot, idempotent: seed the registry from every legacy project graph DB
 *  in the cache dir. Reads each `<slug>.db`'s ctx_projects row to recover the
 *  original root_path (the slug filename is lossy). Best-effort: unreadable /
 *  pre-migration files are skipped. Does NOT copy graph data — repos re-index
 *  into `.cortex/db` and `resolveGraphDbForRead`'s cache fallback covers reads
 *  until they do. The `.tmp` guard lives in Registry.register. */
export function migrateCacheToRegistry(
  registry: Registry,
  cacheDir: string = join(homedir(), ".cache", "cortex-indexer"),
): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return;
  }
  const seenPaths = new Set<string>();
  for (const name of entries) {
    if (!name.endsWith(".db") || name.startsWith("_") || name.startsWith("tmp-")) continue;
    const dbPath = join(cacheDir, name);
    let probe: BetterSqlite3.Database | null = null;
    try {
      probe = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
      const hasTable = probe
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ctx_projects'")
        .get();
      if (!hasTable) continue;
      const projectName = name.slice(0, -3);
      const row = probe
        .prepare("SELECT name, root_path, indexed_at FROM ctx_projects WHERE name = ? LIMIT 1")
        .get(projectName) as { name: string; root_path: string; indexed_at?: string } | undefined;
      if (!row?.root_path || !row?.name) continue;
      // Two cache slugs may point at the same repo (e.g. a re-slug). Register
      // each root_path once; register() conflicts on root_path's UNIQUE
      // constraint otherwise. Mirrors listKnownRepos' byPath dedup.
      if (seenPaths.has(row.root_path)) continue;
      seenPaths.add(row.root_path);
      registry.register(row.name, row.root_path, row.indexed_at ?? new Date().toISOString());
    } catch {
      // best-effort
    } finally {
      probe?.close();
    }
  }
}

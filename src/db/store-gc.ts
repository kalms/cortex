import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";

/** repoId from <root>/cortex.json, or null on any read/parse failure. */
export function readRepoId(repoRoot: string): string | null {
  try {
    const raw = readFileSync(join(repoRoot, "cortex.json"), "utf-8");
    const id = JSON.parse(raw)?.repoId;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

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

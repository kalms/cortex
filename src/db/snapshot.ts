import type Database from "better-sqlite3";
import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

/** Consistent single-file copy of an open DB. `VACUUM INTO` is WAL-correct and
 *  synchronous; it requires `dest` to NOT already exist. */
export function snapshotDb(db: Database.Database, dest: string): void {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

/** Overwrite `storePath` from a snapshot. The caller MUST have closed the live
 *  handle first. Stale WAL/SHM sidecars are removed so the restored file is the
 *  sole source of truth. */
export function restoreDb(storePath: string, snapshotPath: string): void {
  copyFileSync(snapshotPath, storePath);
  for (const sidecar of [`${storePath}-wal`, `${storePath}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
}

/** Keep the newest `keep` `decisions.db.bak.*` files in `dir` (names carry an
 *  ISO timestamp, so lexical sort == chronological), delete the rest. */
export function pruneSnapshots(dir: string, keep: number): void {
  if (!existsSync(dir)) return;
  const baks = readdirSync(dir)
    .filter((f) => basename(f).startsWith("decisions.db.bak."))
    .sort(); // ascending: oldest first
  for (const f of baks.slice(0, Math.max(0, baks.length - keep))) {
    rmSync(join(dir, f), { force: true });
  }
}

import { unlinkSync } from "node:fs";
import { join } from "node:path";

/** Per-index staging DB path: a sibling of the canonical .cortex/db that no
 *  long-lived handle holds open. pid-scoped so concurrent indexers never
 *  collide. The C writer + frame/contract passes build HERE; publishStagedDb
 *  then swaps the contents into the canonical db. Lives under .cortex/ so it is
 *  on the same filesystem as the live db (local ATTACH + row copy). */
export function stagingDbPath(repoRoot: string, pid: number = process.pid): string {
  return join(repoRoot, ".cortex", `db.stage-${pid}`);
}

/** Best-effort removal of a staging DB and its WAL sidecars. Safe to call when
 *  the files don't exist. Used both to clear a stale staging file at index
 *  start and (in a finally) to clean up after publish OR an aborted index, so a
 *  failed/interrupted run never leaks a multi-MB staging file. */
export function cleanupStagingDb(stagePath: string): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try { unlinkSync(stagePath + ext); } catch { /* not present — fine */ }
  }
}

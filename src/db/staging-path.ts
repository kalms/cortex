import { join } from "node:path";

/** Per-index staging DB path: a sibling of the canonical .cortex/db that no
 *  long-lived handle holds open. pid-scoped so concurrent indexers never
 *  collide. The C writer + frame/contract passes build HERE; publishStagedDb
 *  then swaps the contents into the canonical db. Lives under .cortex/ so it is
 *  on the same filesystem as the live db (local ATTACH + row copy). */
export function stagingDbPath(repoRoot: string, pid: number = process.pid): string {
  return join(repoRoot, ".cortex", `db.stage-${pid}`);
}

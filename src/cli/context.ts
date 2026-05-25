import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";

export type ProjectState = "indexed" | "unindexed-repo" | "no-project";

export type ProjectContext = {
  state: ProjectState;
  cwd: string;
  projectName: string | null;       // null when state === "no-project"
  graphDbPath: string | null;       // null when state !== "indexed"
};

/** Convert an absolute path into the indexer's project naming convention. */
export function deriveProjectName(absPath: string): string {
  return absPath.replace(/^\//, "").replace(/\//g, "-");
}

/** Walk up looking for a .git directory. Returns the first match or null. */
function findGitRoot(start: string): string | null {
  let cur = resolve(start);
  while (true) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * Cheap probe: does this graph.db contain at least one node for the given
 * project? Used to discard a graph.db that physically exists but holds data
 * for a different project (a common state when .cortex/graph.db is reused
 * by another repo's MCP session).
 *
 * Opens read-only — never mutates the file via CREATE TABLE IF NOT EXISTS,
 * which is what a default better-sqlite3 / GraphStore open would do. That
 * matters when an active indexer holds the write lock: a write-mode open
 * would throw 'database is locked' and the catch would falsely report
 * 'no data' even though the local db is the right one.
 */
function dbHasProjectData(dbPath: string, projectName: string): boolean {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    // The file may exist but not be a graph.db yet (e.g. an empty placeholder
    // created by a test); guard the table-existence check before counting.
    const hasNodes = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'")
      .get();
    if (!hasNodes) return false;
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE project = ?")
      .get(projectName) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Locate the graph.db backing this project. Probes the MCP-convention local
 * path first, then the standalone-indexer cache. A db that exists but holds
 * data for the wrong project (e.g. .cortex/graph.db got overwritten by
 * another repo's session) is skipped — we prefer a populated cache db over
 * an empty-for-this-project local db.
 */
function findIndexedDb(projectName: string, gitRoot: string): string | null {
  const localPath = join(gitRoot, ".cortex", "graph.db");
  const cachePath = join(homedir(), ".cache", "cortex-indexer", `${projectName}.db`);
  const localOk = existsSync(localPath) && dbHasProjectData(localPath, projectName);
  if (localOk) return localPath;
  const cacheOk = existsSync(cachePath) && dbHasProjectData(cachePath, projectName);
  if (cacheOk) return cachePath;
  // Neither has data for our project; fall back to whichever physically
  // exists so the caller can still report "no data for this project" with
  // a real db path attached, rather than a missing-file error.
  if (existsSync(localPath)) return localPath;
  if (existsSync(cachePath)) return cachePath;
  return null;
}

export function detectProjectState(cwd: string): ProjectState {
  return loadContext(cwd).state;
}

export function loadContext(cwd: string): ProjectContext {
  const absCwd = resolve(cwd);
  const gitRoot = findGitRoot(absCwd);
  if (!gitRoot) {
    return { state: "no-project", cwd: absCwd, projectName: null, graphDbPath: null };
  }
  const projectName = deriveProjectName(gitRoot);
  const graphDbPath = findIndexedDb(projectName, gitRoot);
  if (!graphDbPath) {
    return { state: "unindexed-repo", cwd: absCwd, projectName, graphDbPath: null };
  }
  return { state: "indexed", cwd: absCwd, projectName, graphDbPath };
}

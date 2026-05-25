import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { GraphStore } from "../graph/store.js";

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
 * by another repo's MCP session). Returns false on any error.
 */
function dbHasProjectData(dbPath: string, projectName: string): boolean {
  try {
    const store = new GraphStore(dbPath);
    const rows = store.queryRaw<{ n: number }>(
      "SELECT COUNT(*) AS n FROM nodes WHERE project = ?",
      [projectName],
    );
    return (rows[0]?.n ?? 0) > 0;
  } catch {
    return false;
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

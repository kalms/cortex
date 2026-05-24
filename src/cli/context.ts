import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

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

/** Check if a graph.db exists for this project in the indexer's cache. */
function findIndexedDb(projectName: string): string | null {
  // Indexer writes to ~/.cache/cortex-indexer/<projectName>.db when CORTEX_DB
  // is not set. (cortex itself may set CORTEX_DB to a project-local file but
  // we don't depend on that here.)
  const cachePath = join(homedir(), ".cache/cortex-indexer", `${projectName}.db`);
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
  const graphDbPath = findIndexedDb(projectName);
  if (!graphDbPath) {
    return { state: "unindexed-repo", cwd: absCwd, projectName, graphDbPath: null };
  }
  return { state: "indexed", cwd: absCwd, projectName, graphDbPath };
}

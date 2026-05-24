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

/** Check if a graph.db exists for this project, probing both known locations. */
function findIndexedDb(projectName: string, gitRoot: string): string | null {
  // MCP server convention: index_repository writes to <gitRoot>/.cortex/graph.db
  const localPath = join(gitRoot, ".cortex", "graph.db");
  if (existsSync(localPath)) return localPath;
  // Standalone indexer cache: ~/.cache/cortex-indexer/<projectName>.db
  const cachePath = join(homedir(), ".cache", "cortex-indexer", `${projectName}.db`);
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

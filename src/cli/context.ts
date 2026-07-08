import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveGraphDbForRead } from "../db/resolve-path.js";

export type ProjectState = "indexed" | "unindexed-repo" | "no-project";

export type ProjectContext = {
  state: ProjectState;
  cwd: string;
  /** Git repo root walked-up from cwd; null when state === "no-project". */
  gitRoot: string | null;
  projectName: string | null;       // null when state === "no-project"
  graphDbPath: string | null;       // null when state !== "indexed"
};

/** Convert an absolute path into the indexer's project naming convention. */
export function deriveProjectName(absPath: string): string {
  return absPath.replace(/^\//, "").replace(/\//g, "-");
}

/** Standalone-indexer cache DB path for a project: ~/.cache/cortex-indexer/<project>.db */
export function cachePathForProject(projectName: string): string {
  return join(homedir(), ".cache", "cortex-indexer", `${projectName}.db`);
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

export function detectProjectState(cwd: string): ProjectState {
  return loadContext(cwd).state;
}

export function loadContext(cwd: string): ProjectContext {
  const absCwd = resolve(cwd);
  const gitRoot = findGitRoot(absCwd);
  if (!gitRoot) {
    return { state: "no-project", cwd: absCwd, gitRoot: null, projectName: null, graphDbPath: null };
  }
  const projectName = deriveProjectName(gitRoot);
  // Delegate to the single graph-path chokepoint (D-2ke5): it prefers the
  // canonical <repo>/.cortex/db, then falls back to the legacy
  // <repo>/.cortex/graph.db and the CLI cache. The old inline resolver here
  // only knew the two legacy locations, so a repo indexed solely at
  // .cortex/db (the norm since D-2ke5) was misreported as "unindexed-repo".
  const graphDbPath = resolveGraphDbForRead(gitRoot);
  if (!graphDbPath) {
    return { state: "unindexed-repo", cwd: absCwd, gitRoot, projectName, graphDbPath: null };
  }
  return { state: "indexed", cwd: absCwd, gitRoot, projectName, graphDbPath };
}

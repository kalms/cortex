import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function resolveCortexDbPath(startDir: string = process.cwd()): string {
  const override = process.env.CORTEX_DB_PATH;
  if (override) return override;

  const gitRoot = findGitRoot(startDir);
  const base = gitRoot ?? startDir;
  return join(base, ".cortex", "db");
}

export function resolveDecisionsDbPath(startDir?: string): string {
  const override = process.env.CORTEX_DECISIONS_DB;
  if (override) return override;

  const start = startDir ?? process.cwd();
  const gitRoot = findGitRoot(start);
  const base = gitRoot ?? start;
  return join(base, ".cortex", "decisions.db");
}

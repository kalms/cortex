import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function resolveCortexDbPath(startDir: string = process.cwd()): string {
  const override = process.env.CORTEX_DB_PATH;
  if (override) return override;

  let dir = startDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return join(dir, ".cortex", "db");
    }
    const parent = dirname(dir);
    if (parent === dir) {
      // No .git found — fall back to startDir-relative .cortex/db
      return join(startDir, ".cortex", "db");
    }
    dir = parent;
  }
}

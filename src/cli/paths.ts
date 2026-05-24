import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Repo root resolution. Works whether main.ts runs via tsx (src/cli/main.ts)
 * or as compiled dist/cli/main.js — both live at <root>/{src,dist}/cli/ so
 * `../../..` from any module under cli/commands lands on the repo root.
 * The bin launcher also exports CORTEX_REPO_ROOT; we prefer that when set
 * because it survives any future relocation of the JS files.
 */
export function repoRoot(): string {
  const env = process.env.CORTEX_REPO_ROOT;
  if (env) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

export function indexerBinPath(): string {
  return resolve(repoRoot(), "bin", "cortex-indexer");
}

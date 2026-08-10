import { readFileSync } from "node:fs";
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

/**
 * The CLI's own version, read from the install root's package.json.
 *
 * Must resolve against `repoRoot()`, never `process.cwd()` — the CLI is on
 * PATH and is normally invoked from some *other* repo. A cwd-relative read
 * reports that repo's version as Cortex's (or "0.0.0" where no package.json
 * exists), which is why this lives here beside the root resolution.
 */
export function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot(), "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

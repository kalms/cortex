/**
 * Locates and provisions the Python venv used by frame extraction.
 *
 * The venv lives at ~/.cache/cortex-indexer/python-venv (a writable,
 * cross-cwd home — the same cache dir as the project DBs), NOT inside the
 * repo, so it survives plugin installs where the repo is read-only.
 * Override with CORTEX_VENV for tests / power users.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function venvDir(): string {
  const override = process.env.CORTEX_VENV;
  if (override) return override;
  return join(homedir(), ".cache", "cortex-indexer", "python-venv");
}

export function venvPythonBin(): string {
  return join(venvDir(), "bin", "python");
}

export function hasVenv(): boolean {
  return existsSync(venvPythonBin());
}

export type SetupVenvResult =
  | { status: "ok" }
  | { status: "python_missing" }
  | { status: "failed"; reason: string };

function python3OnPath(): boolean {
  try {
    execSync("command -v python3", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create/refresh the venv by running setup-venv.sh, targeting venvDir().
 * Foreground; inherits stdio unless quiet. Never throws — returns a result.
 * Safe to call repeatedly (the script is idempotent).
 */
export function setupVenv(opts: { quiet?: boolean } = {}): SetupVenvResult {
  if (!python3OnPath()) return { status: "python_missing" };
  const here = fileURLToPath(new URL(".", import.meta.url));
  // src/frame-extraction → repo root → scripts/.../setup-venv.sh
  const script = resolve(here, "..", "..", "scripts", "frame-extraction", "python", "setup-venv.sh");
  try {
    execFileSync("bash", [script], {
      stdio: opts.quiet ? "ignore" : "inherit",
      env: { ...process.env, CORTEX_VENV: venvDir() },
    });
    return { status: "ok" };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

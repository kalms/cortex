/**
 * Locates and provisions the Python venv used by frame extraction.
 *
 * The venv lives at ~/.cache/cortex-indexer/python-venv (a writable,
 * cross-cwd home — the same cache dir as the project DBs), NOT inside the
 * repo, so it survives plugin installs where the repo is read-only.
 * Override with CORTEX_VENV for tests / power users.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

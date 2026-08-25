/**
 * Locates and provisions the Python venv used by frame extraction.
 *
 * The venv lives at ~/.cache/cortex-indexer/python-venv (a writable,
 * cross-cwd home — the same cache dir as the project DBs), NOT inside the
 * repo, so it survives plugin installs where the repo is read-only.
 * Override with CORTEX_VENV for tests / power users.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  if (!existsSync(venvPythonBin())) return false;
  // `python3 -m venv` creates bin/python before pip installs anything, so a
  // creation that dies partway leaves a venv that EXISTS and cannot cluster —
  // every run then fails with ModuleNotFoundError instead of skipping and
  // retrying, which is strictly worse than having no venv at all. Require the
  // first thing the clusterer imports, not just the interpreter.
  const lib = join(venvDir(), "lib");
  try {
    return readdirSync(lib).some((py) => existsSync(join(lib, py, "site-packages", "numpy")));
  } catch {
    return false;
  }
}

export type SetupVenvResult =
  | { status: "ok" }
  | { status: "python_missing" }
  | { status: "failed"; reason: string };

/** Where a PATH lookup can't reach — see resolvePython3. */
const PYTHON3_FALLBACKS = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"];

/**
 * Resolve the python3 to build the venv with: CORTEX_PYTHON, then PATH, then
 * the usual absolute locations.
 *
 * The fallbacks matter because a sidecar spawned by a GUI app inherits the
 * launching process's environment, not a login shell's — so PATH can be
 * minimal or empty even on a machine with a perfectly good python3. Returning
 * a path rather than a bare name also lets us hand the setup script the same
 * interpreter we just checked for.
 */
function resolvePython3(): string | null {
  const pinned = process.env.CORTEX_PYTHON;
  if (pinned) return existsSync(pinned) ? pinned : null;
  try {
    const found = execSync("command -v python3", { encoding: "utf-8" }).trim();
    if (found && existsSync(found)) return found;
  } catch { /* not on PATH — fall through to the absolute locations */ }
  return PYTHON3_FALLBACKS.find((p) => existsSync(p)) ?? null;
}

/**
 * Create/refresh the venv by running setup-venv.sh, targeting venvDir().
 * Foreground; inherits stdio unless quiet. Never throws — returns a result.
 * Safe to call repeatedly (the script is idempotent).
 */
export function setupVenv(opts: { quiet?: boolean } = {}): SetupVenvResult {
  const python3 = resolvePython3();
  if (!python3) return { status: "python_missing" };
  const here = fileURLToPath(new URL(".", import.meta.url));
  // src/frame-extraction → repo root → scripts/.../setup-venv.sh
  const script = resolve(here, "..", "..", "scripts", "frame-extraction", "python", "setup-venv.sh");
  try {
    execFileSync("bash", [script], {
      stdio: opts.quiet ? "ignore" : "inherit",
      env: {
        ...process.env,
        CORTEX_VENV: venvDir(),
        // The script runs `python3 -m venv`, so put the interpreter we
        // resolved on the child's PATH — it may not be on ours.
        PATH: [dirname(python3), process.env.PATH].filter(Boolean).join(":"),
      },
    });
    clearSetupFailure();
    return { status: "ok" };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Marker written when an automatic setup fails, so the next index doesn't retry immediately. */
const FAILED_MARKER = ".venv-setup-failed";
/** Held for the duration of an automatic setup — the venv is global, indexes are not. */
const LOCK_FILE = ".venv-setup.lock";
/** How long an automatic setup stays failed before it is worth trying again. */
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** A lock older than this belonged to a process that died mid-setup. */
const LOCK_STALE_MS = 30 * 60 * 1000;

function stateDir(): string {
  return dirname(venvDir());
}

function ageMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function clearSetupFailure(): void {
  try { rmSync(join(stateDir(), FAILED_MARKER), { force: true }); } catch { /* best-effort */ }
}

/**
 * Provision the venv on demand, returning whether frame extraction can run.
 *
 * Without this, a machine that has never run `cortex install` or `cortex setup
 * frames` gets `{skipped, venv_missing}` from every index, forever — and an
 * embedding consumer with an always-visible viewer (Mesh) has no surface that
 * reports it, so the canvas just stays empty. `cortex install` provisions the
 * venv, but a bundled sidecar is unpacked from a tarball and never runs it.
 *
 * Guards, because this spends 1–3 minutes and a network connection:
 *   - CORTEX_FRAMES_SETUP=0 opts out entirely.
 *   - A failure writes a marker and is not retried for 24h. An explicit
 *     `cortex setup frames` bypasses the marker (it calls setupVenv directly)
 *     and clears it on success.
 *   - A lock file serializes provisioners: two repos can index at once, each
 *     holding only its own index lock, and concurrent pip installs into one
 *     venv corrupt it. A loser skips this run rather than waiting.
 */
export function ensureVenv(opts: { onProvision?: () => void } = {}): boolean {
  if (hasVenv()) return true;
  if (process.env.CORTEX_FRAMES_SETUP === "0") return false;

  const failedAge = ageMs(join(stateDir(), FAILED_MARKER));
  if (failedAge !== null && failedAge < RETRY_AFTER_MS) return false;

  const lock = join(stateDir(), LOCK_FILE);
  const lockAge = ageMs(lock);
  if (lockAge !== null && lockAge < LOCK_STALE_MS) return false;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(lock, `${process.pid}\n`);
  } catch {
    return false; // unwritable cache dir — nothing here can succeed
  }

  try {
    opts.onProvision?.();
    const result = setupVenv({ quiet: true });
    if (result.status === "ok" && hasVenv()) return true;
    try {
      const why = result.status === "failed" ? result.reason : result.status;
      writeFileSync(join(stateDir(), FAILED_MARKER), `${why}\n`);
    } catch { /* best-effort */ }
    return false;
  } finally {
    try { rmSync(lock, { force: true }); } catch { /* best-effort */ }
  }
}

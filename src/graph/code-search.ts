import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { accessSync, constants as fsConstants } from "node:fs";

const execFileAsync = promisify(execFile);

export const RG_MAX_BUFFER = 64 * 1024 * 1024;

export function buildRgArgs(pattern: string): string[] {
  return [
    "--no-heading",
    "--line-number",
    "--color=never",
    "--max-count", "200",
    pattern,
    ".",
  ];
}

export function buildGrepFallbackArgs(pattern: string): string[] {
  return [
    "-rn",
    "-I", // skip binary files (sqlite DBs, compiled objects)
    "-m", "200", // cap matches per file, mirroring rg's --max-count
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "--exclude-dir=.cache",
    "--exclude-dir=vendored",
    // Derived / scratch trees. Unlike rg (which honors .gitignore), grep
    // recurses everything — these total ~1.7 GB in this repo and caused the
    // fallback to time out or exit 2 on an unreadable file.
    "--exclude-dir=.tmp",
    "--exclude-dir=.cortex",
    "--exclude-dir=.venv",
    pattern,
    ".",
  ];
}

const localRequire = createRequire(import.meta.url);
let cachedRgBinary: string | null | undefined;

/**
 * Resolve the ripgrep binary to invoke for `search_code`.
 *
 * Order of preference:
 *  1. `CORTEX_RG_PATH` env override — escape hatch for custom installs.
 *  2. The `@vscode/ripgrep` bundled binary (absolute path, platform-specific).
 *     This is the load-bearing fix: the MCP server is often spawned with a
 *     stripped PATH (e.g. a plugin host), so a system `rg` on the user's PATH
 *     is invisible. Bundling guarantees rg is present for every install.
 *  3. Bare `"rg"` (PATH lookup) if the bundled package is somehow unavailable.
 *
 * The bundled path is cached after the first successful resolve; the env
 * override is re-read each call so tests and operators can flip it at runtime.
 */
export function resolveRgBinary(): string {
  const override = process.env.CORTEX_RG_PATH;
  if (override) return override;
  if (cachedRgBinary === undefined) {
    try {
      const { rgPath } = localRequire("@vscode/ripgrep") as { rgPath: string };
      accessSync(rgPath, fsConstants.X_OK);
      cachedRgBinary = rgPath;
    } catch {
      cachedRgBinary = null;
    }
  }
  return cachedRgBinary ?? "rg";
}

// ---------------------------------------------------------------------------
// search_code subprocess error classification.
//
// rg/grep failures arrive as rejected exec errors with a grab-bag of shapes
// (numeric exit code, string Node error code, POSIX signal, partial stdout).
// Before this classifier, the primary rg path mapped *every* non-ENOENT,
// non-exit-1, no-stdout error to an opaque `internal_error` — so an invalid
// regex (exit 2) and a timed-out search (SIGTERM) both surfaced as crashes,
// hiding the actionable "your pattern is bad" signal and masking incomplete
// searches. The grep-fallback branch already degraded gracefully; this lifts
// that handling into one pure, tested function used by BOTH binaries.
//
// Outcomes:
//  - output            → use this stdout (full result, or partial from an
//                        interrupted/over-buffered run — better than nothing)
//  - empty             → no matches, OR an incomplete search (timeout / read
//                        error) that produced nothing. Not a crash.
//  - missing           → binary absent (ENOENT); caller falls back.
//  - invalid_pattern   → the regex engine rejected the pattern (exit 2 +
//                        a parse-error stderr). Actionable: fix the pattern.
//  - error             → genuinely unexpected; only the true-unknown bucket.
export type SearchExecError = {
  code?: number | string | null;
  signal?: string | null;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  message?: string;
};

export type SearchExecOutcome =
  | { kind: "output"; stdout: string }
  | { kind: "empty" }
  | { kind: "missing" }
  | { kind: "invalid_pattern"; detail: string }
  | { kind: "error"; detail: string };

// Strong, low-false-positive signals that a non-zero exit was a *pattern*
// rejection rather than a filesystem/read error. Anchored to phrases the regex
// engines actually emit, NOT bare words like "unmatched"/"unbalanced" that also
// appear in read-error paths (`rg: ./unmatched: Permission denied`):
//   - rg always prefixes pattern errors with "regex parse error:".
//   - GNU grep: "Invalid regular expression", "brackets ([ ]) not balanced",
//     "Unmatched ( or \(", "Trailing backslash", "Invalid content of \{\}".
//   - BSD grep (macOS /usr/bin/grep): "repetition-operator operand invalid",
//     "parentheses not balanced", "trailing backslash (\)".
// "unmatched" is matched only when an actual bracket char follows, so a file
// literally named "unmatched" in a read-error message can't trip it.
const REGEX_ERROR_RE =
  /regex parse error|error parsing regex|regular expression|not balanced|trailing backslash|unclosed|invalid repetition|repetition[- ]operator|unmatched\s*[[\](){}]/i;

export function classifySearchExec(err: SearchExecError): SearchExecOutcome {
  // Binary not on PATH — the caller decides whether to fall back.
  if (err.code === "ENOENT") return { kind: "missing" };

  const stdout = typeof err.stdout === "string" ? err.stdout : "";
  const stderr = typeof err.stderr === "string" ? err.stderr : "";
  const hasOutput = stdout.trim().length > 0;

  // Exit 1 = no matches (rg + grep convention). Normally stdout is empty, but
  // honor any buffered output if present.
  if (err.code === 1) return hasOutput ? { kind: "output", stdout } : { kind: "empty" };

  // Exit 2 = a search error. A regex parse error is actionable — surface it so
  // the agent can fix the pattern. Other exit-2 causes (unreadable file, etc.)
  // are incomplete searches: prefer partial output, else report empty.
  if (err.code === 2) {
    if (!hasOutput && REGEX_ERROR_RE.test(stderr)) {
      return { kind: "invalid_pattern", detail: stderr.trim() };
    }
    return hasOutput ? { kind: "output", stdout } : { kind: "empty" };
  }

  // Killed by our timeout (SIGTERM) or over the stdout maxBuffer cap. Both mean
  // an incomplete search — keep whatever completed, else report empty rather
  // than masquerading as a crash.
  if (err.killed || err.signal === "SIGTERM" || err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return hasOutput ? { kind: "output", stdout } : { kind: "empty" };
  }

  // Any other error that still produced usable output: use it.
  if (hasOutput) return { kind: "output", stdout };

  // Genuinely unexpected and empty — the only true-error bucket.
  return { kind: "error", detail: err.message ?? String(err) };
}

void execFileAsync;

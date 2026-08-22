import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { accessSync, existsSync, constants as fsConstants } from "node:fs";
import { isAbsolute, resolve as resolvePath, sep } from "node:path";
import type { GraphStore } from "./store.js";
import type { IndexerNode } from "./code-queries.js";
import { KIND_WEIGHT } from "./node-ranker.js";

const execFileAsync = promisify(execFile);

export const RG_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Scoping options for a code search.
 *
 * These exist so that raw `rg` is never the *only* way to run a search on an
 * indexed repo. `search_code` has always been ripgrep with the caller's pattern
 * passed through verbatim, so regex power was never the gap -- the gap was that
 * the wrapper accepted nothing but a pattern, which pushed callers to the
 * `cortex:grep-ok` escape for ordinary needs like "only look in docs/".
 *
 * Deliberately NOT included: context lines (`-A/-B/-C`). Reading the code
 * around a hit is `get_code_snippet`'s job, and context output would break the
 * `path:line:text` parse that every consumer depends on.
 */
export type SearchScope = {
  /** Restrict to a subtree or single file, relative to the repo root. */
  path?: string;
  /** Filename glob, e.g. "*.md". */
  glob?: string;
  /** List matching files instead of matching lines (rg --files-with-matches). */
  filesOnly?: boolean;
  /** Let a pattern match across line boundaries (rg -U --multiline-dotall). */
  multiline?: boolean;
  /** Per-file match cap; defaults to 200. */
  maxCount?: number;
};

/**
 * Validate a caller-supplied `path` scope against the repo root.
 *
 * `cwd: repoRoot` anchors rg's *process*, not its target: a relative
 * `../../etc` still escapes, and an absolute path both escapes and makes rg
 * emit absolute hit lines, which silently breaks the enclosing-symbol lookup.
 * Returns null when the path is acceptable, else a reason.
 */
export function validateSearchPath(repoRoot: string, path: string): string | null {
  if (path === "") return "path must not be empty; omit it to search the whole repo";
  if (isAbsolute(path)) return `path must be relative to the repo root, got '${path}'`;
  const resolved = resolvePath(repoRoot, path);
  const root = resolvePath(repoRoot);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return `path '${path}' escapes the repository root`;
  }
  if (!existsSync(resolved)) return `path '${path}' does not exist in this repo`;
  return null;
}

export function buildRgArgs(pattern: string, scope: SearchScope = {}): string[] {
  const args = [
    "--no-heading",
    "--line-number",
    // Without this, a single-FILE path makes rg omit the filename ("12:text"),
    // which HIT_LINE_RE then misreads as file="12", line=<next colon field>.
    "--with-filename",
    "--color=never",
    "--max-count", String(scope.maxCount ?? 200),
    // Without --hidden, rg skips dotfile dirs -- .github/, .claude/, .husky/
    // were invisible, so search_code silently missed CI workflows. .git/ is
    // re-excluded because --hidden would otherwise descend into object storage.
    // .gitignore is still honored: build output stays out by design.
    "--hidden",
    "--glob", "!.git/", "--glob", "!.venv/", "--glob", "!.next/",
    // .cortex holds the graph + decisions stores; .env* holds secrets. Both were
    // invisible before --hidden and must stay so -- a search tool should never
    // be the thing that lifts credentials into an agent's context.
    "--glob", "!.cortex/", "--glob", "!.env*",
  ];
  if (scope.glob) args.push("--glob", scope.glob);
  if (scope.filesOnly) args.push("--files-with-matches");
  if (scope.multiline) args.push("--multiline", "--multiline-dotall");
  args.push(pattern, scope.path ?? ".");
  return args;
}

export function buildGrepFallbackArgs(pattern: string, scope: SearchScope = {}): string[] {
  const extra: string[] = [];
  if (scope.glob) extra.push(`--include=${scope.glob}`);
  if (scope.filesOnly) extra.push("-l");
  return [
    "-rn",
    "-H", // same reason as rg's --with-filename: single-file targets

    "-I", // skip binary files (sqlite DBs, compiled objects)
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
    "-m", String(scope.maxCount ?? 200),
    ...extra,
    pattern,
    scope.path ?? ".",
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

export type SearchHit = {
  file: string;
  line: number;
  text: string;
  enclosing?: { kind: string; qualified_name: string; file_path: string };
};

export type SearchOutcome =
  | { kind: "hits"; hits: SearchHit[] }
  | { kind: "files"; files: string[]; truncated: boolean }
  | { kind: "invalid_path"; detail: string }
  | { kind: "empty" }
  | { kind: "invalid_pattern"; detail: string }
  | { kind: "error"; detail: string };

// rg prints paths relative to cwd: "./x.ts" when the target is ".", but
// "docs/guide.md" when the target is an explicit path. Accept both so a scoped
// search parses identically to an unscoped one.
const HIT_LINE_RE = /^(?:\.\/)?(.+?):(\d+):(.*)$/;

export async function runCodeSearch(opts: {
  pattern: string;
  repoRoot: string;
  store?: GraphStore;
  project?: string;
  maxHits?: number;
} & SearchScope): Promise<SearchOutcome> {
  const scope: SearchScope = {
    path: opts.path, glob: opts.glob, filesOnly: opts.filesOnly,
    multiline: opts.multiline, maxCount: opts.maxCount,
  };
  if (scope.path !== undefined) {
    const bad = validateSearchPath(opts.repoRoot, scope.path);
    // Without this, a typo'd path makes rg exit 2 with no stdout, which
    // classifies as "empty" -- the tool would answer "no results" for a path
    // that does not exist, which reads as a fact about the code.
    if (bad) return { kind: "invalid_path", detail: bad };
  }
  const maxHits = opts.maxHits ?? 50;
  const execOpts = { timeout: 10_000, maxBuffer: RG_MAX_BUFFER, cwd: opts.repoRoot };

  let stdout = "";
  try {
    const r = await execFileAsync(resolveRgBinary(), buildRgArgs(opts.pattern, scope), execOpts);
    stdout = r.stdout;
  } catch (rgErr) {
    const outcome = classifySearchExec(rgErr as SearchExecError);
    if (outcome.kind === "output") stdout = outcome.stdout;
    else if (outcome.kind === "empty") return { kind: "empty" };
    else if (outcome.kind === "invalid_pattern") return { kind: "invalid_pattern", detail: outcome.detail };
    else if (outcome.kind === "missing") {
      if (scope.multiline) {
        return { kind: "error", detail: "multiline search needs ripgrep, which is unavailable; grep fallback cannot match across lines." };
      }
      try {
        const r2 = await execFileAsync("grep", buildGrepFallbackArgs(opts.pattern, scope), execOpts);
        stdout = r2.stdout;
      } catch (grepErr) {
        const o2 = classifySearchExec(grepErr as SearchExecError);
        if (o2.kind === "output") stdout = o2.stdout;
        else if (o2.kind === "empty") return { kind: "empty" };
        else if (o2.kind === "invalid_pattern") return { kind: "invalid_pattern", detail: o2.detail };
        else if (o2.kind === "missing") return { kind: "error", detail: "Neither rg nor grep available on PATH." };
        else return { kind: "error", detail: o2.detail };
      }
    } else return { kind: "error", detail: outcome.detail };
  }

  if (!stdout.trim()) return { kind: "empty" };

  if (scope.filesOnly) {
    const files = stdout.split("\n")
      .map((l) => l.trim().replace(/^\.\//, ""))
      .filter(Boolean);
    const capped = files.slice(0, maxHits);
    return capped.length
      ? { kind: "files", files: capped, truncated: files.length > capped.length }
      : { kind: "empty" };
  }

  const hits: SearchHit[] = [];
  let prevFile = "";
  let prevLine = -1;
  for (const line of stdout.split("\n")) {
    const m = line.match(HIT_LINE_RE);
    if (!m) continue;
    const file = m[1];
    const lineNo = parseInt(m[2], 10);
    // In multiline mode every line of a single match is emitted separately.
    // Collapse a contiguous run in one file to its first line so one match
    // counts as one hit and cannot exhaust the budget for other files.
    if (scope.multiline && file === prevFile && lineNo === prevLine + 1) {
      prevLine = lineNo;
      continue;
    }
    prevFile = file;
    prevLine = lineNo;
    hits.push({ file, line: lineNo, text: m[3].replace(/\r$/, "") });
    if (hits.length >= maxHits) break;
  }
  if (hits.length === 0) return { kind: "empty" };

  if (opts.store && opts.project) {
    for (const hit of hits) {
      const enclosing = opts.store.queryRaw<IndexerNode>(
        `SELECT * FROM nodes
         WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
           AND kind NOT IN ('decision', 'pr', 'todo')
         ORDER BY (end_line - start_line) ASC LIMIT 1`,
        [opts.project, hit.file, hit.line, hit.line],
      );
      if (enclosing.length > 0) {
        hit.enclosing = { kind: enclosing[0].kind, qualified_name: enclosing[0].qualified_name, file_path: enclosing[0].file_path };
      }
    }
  }
  return { kind: "hits", hits };
}

// Below the 0.5 unknown-kind fallback in `weight` below — a hit with no
// enclosing symbol sinks beneath every real symbol hit.
const UNENCLOSED_WEIGHT = 0;

/** Order hits code-first: by enclosing-symbol kind weight (function/class/method
 *  high, module low, unenclosed lowest), then file, then line. Pure; new array.
 *  This demotes Markdown/doc hits (which enclose to a `module` node or nothing)
 *  beneath real code hits without a doc-extension list. */
export function rankSearchHits(hits: SearchHit[]): SearchHit[] {
  const weight = (h: SearchHit) => (h.enclosing ? (KIND_WEIGHT[h.enclosing.kind] ?? 0.5) : UNENCLOSED_WEIGHT);
  return [...hits].sort(
    (a, b) =>
      weight(b) - weight(a) ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

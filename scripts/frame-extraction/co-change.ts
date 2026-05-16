// scripts/frame-extraction/co-change.ts
/**
 * Co-change matrix from git log. See docs/specs/cortex-v0.3/frame-extraction.md
 * §Co-change as semantic signal. Read 180-day default window, drop
 * big-commit format passes, count file-pair co-occurrences.
 *
 * CLI usage:
 *   tsx scripts/frame-extraction/co-change.ts <repo-path> [--out <path>]
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import type { CoChangeOptions, FilePair } from "./types.js";

interface ParseOptions {
  big_commit_threshold: number;
}

/** Stream individual `FilePair` events from a `git log` block. Each event
 *  has `count: 1`; the caller aggregates. Pair endpoints are sorted so
 *  `(b, a)` collapses to `(a, b)`. Pure function — fully testable. */
export function* parseCoChangeLog(
  log: string,
  opts: ParseOptions,
): Iterable<FilePair> {
  // Format: each commit is a line with the SHA, followed by N lines of
  // touched paths, followed by a blank line. (`--pretty=format:%H` does
  // not emit a trailing newline, so the last commit has no terminator.)
  const lines = log.split("\n");
  let files: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      // Commit boundary.
      yield* pairsForCommit(files, opts);
      files = [];
      i += 1;
      continue;
    }
    // A SHA line is 6–40 hex chars. Anything else is a file path. We treat
    // the FIRST non-empty line after a blank (or start-of-input) as the
    // SHA; subsequent non-empty lines are paths.
    if (files.length === 0 && /^[0-9a-f]{6,40}$/.test(line)) {
      // SHA line — discard, we don't need it.
      i += 1;
      continue;
    }
    files.push(line);
    i += 1;
  }
  // Flush trailing commit.
  if (files.length > 0) yield* pairsForCommit(files, opts);
}

function* pairsForCommit(
  files: string[],
  opts: ParseOptions,
): Iterable<FilePair> {
  if (files.length < 2 || files.length >= opts.big_commit_threshold) return;
  // Dedupe within a commit (in case the same path appears twice for any
  // reason) and sort for stable iteration.
  const unique = Array.from(new Set(files)).sort();
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      const a = unique[i]!;
      const b = unique[j]!;
      // Endpoints already in sorted order from the outer sort.
      yield { a, b, count: 1 };
    }
  }
}

/** Run `git log` against the repo and aggregate raw pair events into
 *  a single `FilePair[]` sorted descending by count. Filter by
 *  `min_count` to drop singletons. */
export function collectCoChange(opts: CoChangeOptions): FilePair[] {
  const args = [
    "log",
    "--name-only",
    "--pretty=format:%H",
    `--since=${opts.since_days}.days.ago`,
    "-M",
  ].join(" ");
  const log = execSync(`git -C ${shellQuote(opts.repo_path)} ${args}`, {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const counts = new Map<string, FilePair>();
  for (const ev of parseCoChangeLog(log, { big_commit_threshold: opts.big_commit_threshold })) {
    const key = `${ev.a} ${ev.b}`;
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { a: ev.a, b: ev.b, count: 1 });
  }
  return [...counts.values()]
    .filter((p) => p.count >= opts.min_count)
    .sort((a, b) => b.count - a.count);
}

function shellQuote(s: string): string {
  // execSync with a shell string — quote the path defensively.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Write a `FilePair[]` to JSONL (one pair per line). Caller-supplied path. */
export function writeCoChangeJsonl(pairs: FilePair[], outPath: string): void {
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, pairs.map((p) => JSON.stringify(p)).join("\n") + "\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("usage: tsx co-change.ts <repo-path> [--out <path>] [--since-days N] [--big N] [--min N]");
    process.exit(2);
  }
  const repo_path = resolve(args[0]!);
  let outPath: string | null = null;
  let since_days = 180;
  let big_commit_threshold = 50;
  let min_count = 2;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out") outPath = args[++i]!;
    else if (args[i] === "--since-days") since_days = Number(args[++i]);
    else if (args[i] === "--big") big_commit_threshold = Number(args[++i]);
    else if (args[i] === "--min") min_count = Number(args[++i]);
  }
  const pairs = collectCoChange({ repo_path, since_days, big_commit_threshold, min_count });
  if (outPath) {
    writeCoChangeJsonl(pairs, outPath);
    console.log(`[co-change] wrote ${pairs.length} pairs to ${outPath}`);
  } else {
    for (const p of pairs) console.log(JSON.stringify(p));
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("co-change.ts");
if (isDirect) main();

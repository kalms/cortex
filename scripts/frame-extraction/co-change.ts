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

/** Stream individual `FilePair` events from a `git log --name-status` block.
 *  Each event has `count: 1`; the caller aggregates. Pair endpoints are
 *  sorted so `(b, a)` collapses to `(a, b)`.
 *
 *  Renames are resolved: an R-status line registers the old path as an
 *  alias for the new path. Because git emits commits newest-first, older
 *  commits referencing the pre-rename name are processed AFTER the rename
 *  is recorded, and their paths resolve to the current name. A new file
 *  created at a previously-renamed-away path is NOT aliased — its commit
 *  was processed before the rename was seen, so the alias map was empty
 *  for that path at emit time.
 *
 *  Pure function — fully testable. */
export function* parseCoChangeLog(
  log: string,
  opts: ParseOptions,
): Iterable<FilePair> {
  // Format (with --name-status --pretty=format:%H):
  //   <40-char SHA>\n
  //   <status>\t<path> | R<sim>\t<old>\t<new>\n   (repeated)
  //   \n   (commit boundary; absent on the last commit)
  //
  // Walk newest-first (git log's default order). Maintain a transitive
  // alias map historical → current. Resolve every emitted path through
  // it; re-resolve at end-of-commit to handle chained renames inside one
  // commit (rare but possible).
  const lines = log.split("\n");
  const aliasMap = new Map<string, string>();
  let files: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === "") {
      yield* flushCommit(files, aliasMap, opts);
      files = [];
      i += 1;
      continue;
    }
    // A SHA line is exactly 40 hex chars. Tightening to {40} avoids
    // swallowing hex-only filenames as if they were second SHAs.
    if (files.length === 0 && /^[0-9a-f]{40}$/.test(line)) {
      i += 1;
      continue;
    }
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      // Rename or copy: STATUS\tOLD\tNEW
      const oldPath = parts[1] ?? "";
      const newPath = parts[2] ?? "";
      if (status.startsWith("R")) {
        // Register the rename. Resolve newPath through the existing map
        // first so chained renames register against the head of the chain.
        aliasMap.set(oldPath, resolveAlias(aliasMap, newPath));
      }
      // The commit touched the new path. Resolve through the (possibly
      // just-updated) map. Copy semantics: both old and new exist in HEAD,
      // so we record the new path's touch; the old path isn't aliased.
      files.push(resolveAlias(aliasMap, newPath));
    } else {
      // A | M | D | T : STATUS\tPATH
      const path = parts[1] ?? "";
      if (path !== "") files.push(resolveAlias(aliasMap, path));
    }
    i += 1;
  }
  if (files.length > 0) yield* flushCommit(files, aliasMap, opts);
}

/** Walk the alias chain. Loops are defensively prevented by the seen set. */
function resolveAlias(map: Map<string, string>, path: string): string {
  const seen = new Set<string>();
  while (map.has(path) && !seen.has(path)) {
    seen.add(path);
    path = map.get(path)!;
  }
  return path;
}

function* flushCommit(
  files: string[],
  aliasMap: Map<string, string>,
  opts: ParseOptions,
): Iterable<FilePair> {
  // Re-resolve in case a chain extended after this commit's earlier lines
  // emitted (e.g. multiple renames inside one commit).
  const resolved = files.map((f) => resolveAlias(aliasMap, f));
  yield* pairsForCommit(resolved, opts);
}

function* pairsForCommit(
  files: string[],
  opts: ParseOptions,
): Iterable<FilePair> {
  if (files.length < 2 || files.length >= opts.big_commit_threshold) return;
  // Dedupe (post-resolution two paths can collapse to the same current
  // name) and sort lexically. Sorting is the deduplication step that
  // collapses (b, a) and (a, b) into a single canonical pair.
  const unique = Array.from(new Set(files)).sort();
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      yield { a: unique[i]!, b: unique[j]!, count: 1 };
    }
  }
}

/** Run `git log` against the repo and aggregate raw pair events into
 *  a single `FilePair[]` sorted descending by count. Filter by
 *  `min_count` to drop singletons.
 *
 *  Uses `--name-status -M` (rather than `--name-only -M`) so we can
 *  detect rename markers and unify pre/post-rename references to the
 *  same file under its current name. See `parseCoChangeLog` for details. */
export function collectCoChange(opts: CoChangeOptions): FilePair[] {
  const args = [
    "log",
    "--name-status",
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

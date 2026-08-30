import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Scorecard, Target } from "./assertions/types.js";
import { evalIndexerEnv } from "../../src/cli/commands/eval.js";

export type AcquiredTarget = {
  name: string;
  workdir: string;             // absolute path to the source tree
  graphDbPath: string;         // absolute path to the graph.db this harness writes (under evals/cache/<name>/)
  source_sha?: string;
  indexer_seconds: number | null;
};

const CACHE_ROOT = resolve(process.cwd(), "evals/cache");
const INDEXER_BIN = resolve(process.cwd(), "bin/cortex-indexer");

export function acquireTarget(target: Target, pathOverride?: string): AcquiredTarget {
  const graphDbPath = join(CACHE_ROOT, target.name, "graph.db");

  if (target.local_path || pathOverride) {
    const workdir = resolve(pathOverride ?? target.local_path!);
    if (!existsSync(workdir)) {
      throw new Error(`Target ${target.name}: local path does not exist: ${workdir}`);
    }
    return {
      name: target.name,
      workdir,
      graphDbPath,
      indexer_seconds: maybeReindex(workdir, graphDbPath),
    };
  }

  if (!target.repo_url || !target.sha) {
    throw new Error(`Target ${target.name}: requires either local_path or repo_url+sha`);
  }

  const workdir = join(CACHE_ROOT, target.name, "src");
  if (!existsSync(workdir)) {
    mkdirSync(dirname(workdir), { recursive: true });
    execFileSync("git", ["clone", "--depth", "50", target.repo_url, workdir], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", workdir, "fetch", "--depth", "50", "origin", target.sha], { stdio: "inherit" });
  execFileSync("git", ["-C", workdir, "checkout", "--detach", target.sha], { stdio: "inherit" });
  const head = execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  return {
    name: target.name,
    workdir,
    graphDbPath,
    source_sha: head,
    indexer_seconds: maybeReindex(workdir, graphDbPath),
  };
}

function maybeReindex(workdir: string, graphDbPath: string): number | null {
  // Skip indexing if the graph.db exists and is newer than the workdir's git HEAD.
  // For local_path targets without .git, treat as always-stale (always reindex).
  if (existsSync(graphDbPath)) {
    const graphMtime = statSync(graphDbPath).mtimeMs;
    const headFile = join(workdir, ".git/HEAD");
    if (existsSync(headFile)) {
      const headMtime = statSync(headFile).mtimeMs;
      if (graphMtime >= headMtime) return null;
    }
  }

  mkdirSync(dirname(graphDbPath), { recursive: true });
  const start = Date.now();
  execFileSync(
    INDEXER_BIN,
    ["cli", "index_repository", JSON.stringify({ repo_path: workdir })],
    {
      stdio: "inherit",
      // Redirect the indexer's slug cache + durable home into evals/cache
      // (already gitignored eval scratch space) so corpus-target indexing
      // never leaks entries into the real ~/.cache/cortex-indexer or
      // ~/.cortex.
      env: { ...process.env, CORTEX_DB: graphDbPath, ...evalIndexerEnv(CACHE_ROOT) },
    },
  );
  return (Date.now() - start) / 1000;
}

/** Edge types excluded from the determinism comparison because they are known
 *  to vary across identical runs (todo T-48qt: SEMANTICALLY_RELATED measured
 *  at 146/145/148 on an unchanged repo). Everything else is expected to be
 *  bit-stable, so any difference is a real defect. */
const NONDETERMINISTIC_EDGE_TYPES = new Set(["SEMANTICALLY_RELATED"]);

export function compareGraphShape(
  a: Scorecard,
  b: Scorecard,
): { stable: boolean; differences: string[] } {
  const differences: string[] = [];

  for (const key of new Set([...Object.keys(a.nodes_by_label), ...Object.keys(b.nodes_by_label)])) {
    const x = a.nodes_by_label[key] ?? 0;
    const y = b.nodes_by_label[key] ?? 0;
    if (x !== y) differences.push(`nodes.${key}: ${x} vs ${y}`);
  }

  for (const key of new Set([...Object.keys(a.edges_by_type), ...Object.keys(b.edges_by_type)])) {
    if (NONDETERMINISTIC_EDGE_TYPES.has(key)) continue;
    const x = a.edges_by_type[key] ?? 0;
    const y = b.edges_by_type[key] ?? 0;
    if (x !== y) differences.push(`edges.${key}: ${x} vs ${y}`);
  }

  return { stable: differences.length === 0, differences };
}

/** Index unconditionally. maybeReindex skips when the cached graph.db is newer
 *  than the workdir's .git/HEAD, which would make a determinism run compare a
 *  graph against itself and always report stable. */
export function forceReindex(workdir: string, graphDbPath: string): number {
  rmSync(graphDbPath, { force: true });
  rmSync(`${graphDbPath}-shm`, { force: true });
  rmSync(`${graphDbPath}-wal`, { force: true });
  const seconds = maybeReindex(workdir, graphDbPath);
  return seconds ?? 0;
}

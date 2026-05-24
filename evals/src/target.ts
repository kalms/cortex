import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Target } from "./assertions/types.js";

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
      env: { ...process.env, CORTEX_DB: graphDbPath },
    },
  );
  return (Date.now() - start) / 1000;
}

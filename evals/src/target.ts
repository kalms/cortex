import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Target } from "./assertions/types.js";

export type AcquiredTarget = {
  name: string;
  workdir: string;             // absolute path to the source tree
  graphDbPath: string;         // absolute path to .cortex/graph.db
  source_sha?: string;
  indexer_seconds: number | null;
};

const CACHE_ROOT = resolve(process.cwd(), "evals/cache");
const INDEXER_BIN = resolve(process.cwd(), "bin/cortex-indexer");

export function acquireTarget(target: Target, pathOverride?: string): AcquiredTarget {
  if (target.local_path || pathOverride) {
    const workdir = resolve(pathOverride ?? target.local_path!);
    if (!existsSync(workdir)) {
      throw new Error(`Target ${target.name}: local path does not exist: ${workdir}`);
    }
    return {
      name: target.name,
      workdir,
      graphDbPath: join(workdir, ".cortex/graph.db"),
      indexer_seconds: maybeReindex(workdir, target.name),
    };
  }

  if (!target.repo_url || !target.sha) {
    throw new Error(`Target ${target.name}: requires either local_path or repo_url+sha`);
  }

  const workdir = join(CACHE_ROOT, target.name);
  if (!existsSync(workdir)) {
    execFileSync("git", ["clone", "--depth", "50", target.repo_url, workdir], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", workdir, "fetch", "--depth", "50", "origin", target.sha], { stdio: "inherit" });
  execFileSync("git", ["-C", workdir, "checkout", "--detach", target.sha], { stdio: "inherit" });
  const head = execFileSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();

  return {
    name: target.name,
    workdir,
    graphDbPath: join(workdir, ".cortex/graph.db"),
    source_sha: head,
    indexer_seconds: maybeReindex(workdir, target.name),
  };
}

function maybeReindex(workdir: string, projectName: string): number | null {
  // Skip indexing if .cortex/graph.db exists and is newer than the workdir's
  // newest tracked file. Cheap heuristic — pessimistic skip; user can blow
  // away evals/cache/<name>/.cortex/ to force a rebuild.
  const graphDb = join(workdir, ".cortex/graph.db");
  if (existsSync(graphDb)) {
    const graphMtime = statSync(graphDb).mtimeMs;
    const headMtime = existsSync(join(workdir, ".git/HEAD"))
      ? statSync(join(workdir, ".git/HEAD")).mtimeMs
      : 0;
    if (graphMtime >= headMtime) return null;
  }
  const start = Date.now();
  execFileSync(INDEXER_BIN, ["index_repository", "--path", workdir, "--project", projectName], {
    stdio: "inherit",
  });
  return (Date.now() - start) / 1000;
}

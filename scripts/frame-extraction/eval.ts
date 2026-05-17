// scripts/frame-extraction/eval.ts
/**
 * Eval a single (algorithm, repo) cluster output against cross-signal data.
 *
 * Inputs (CLI):
 *   --cluster <path>     ClusterResult JSON (required)
 *   --repo <path>        Repo root, used for graph DB + co-change defaults
 *   --co-change <path>   Co-change JSONL (default: .tmp/frame-extraction/co-change/<slug>.jsonl)
 *   --out <path>         Output markdown path (default: docs/specs/cortex-v0.3/phase-2-eval/<slug>.md)
 *   --repo-slug <name>   Human-readable slug to display in the report (default: dir basename)
 *
 * Output: a markdown report file at --out.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type {
  ClusterAssignment,
  ClusterResult,
  EvalMetrics,
  EvalReport,
  FilePair,
  ImportEdge,
} from "./types.js";
import {
  agreementScore,
  buildFileToClusterMap,
  clusterCount,
  noiseRate,
} from "./eval-metrics.js";
import { collectCallsEdges } from "./eval-edges.js";
import { renderEvalReport } from "./eval-report.js";
import { deriveProjectName } from "./cluster-tfidf-hdbscan.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DEFAULT_OUT_DIR = join(REPO_ROOT, "docs", "specs", "cortex-v0.3", "phase-2-eval");
const DEFAULT_CO_CHANGE_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "co-change");

interface CliArgs {
  cluster: string;
  repo: string;
  co_change?: string;
  out?: string;
  repo_slug?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cluster") out.cluster = argv[++i];
    else if (argv[i] === "--repo") out.repo = argv[++i];
    else if (argv[i] === "--co-change") out.co_change = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--repo-slug") out.repo_slug = argv[++i];
  }
  if (!out.cluster || !out.repo) {
    console.error("usage: tsx eval.ts --cluster <path> --repo <path> [--co-change <path>] [--out <path>] [--repo-slug <name>]");
    process.exit(2);
  }
  return out as CliArgs;
}

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

function commonPrefix(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  let prefix = paths[0]!;
  for (const p of paths.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < p.length && prefix[i] === p[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") return "";
  }
  // Truncate to the last separator so we don't return half-path-prefixes.
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : prefix;
}

function buildClusterSummary(
  clusters: ClusterAssignment[],
  topTokensByCluster: Record<string, string[]>,
): EvalReport["cluster_summary"] {
  return clusters
    .filter((c) => c.cluster_id !== -1)
    .map((c) => ({
      cluster_id: c.cluster_id,
      member_count: c.member_paths.length,
      path_prefix: commonPrefix(c.member_paths),
      top_tokens: topTokensByCluster[String(c.cluster_id)] ?? [],
      sample_paths: c.member_paths.slice(0, 5),
    }))
    .sort((x, y) => y.member_count - x.member_count);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const clusterPath = resolve(args.cluster);
  const repoPath = resolve(args.repo);
  const project = deriveProjectName(repoPath);
  const repoSlug = args.repo_slug ?? basename(repoPath);
  const slugSafe = project.replace(/[^A-Za-z0-9._-]/g, "_");

  const cluster = JSON.parse(readFileSync(clusterPath, "utf-8")) as ClusterResult;
  const coChangePath = args.co_change ?? join(DEFAULT_CO_CHANGE_DIR, `${slugSafe}.jsonl`);
  const pairs = loadJsonl<FilePair>(coChangePath);

  const graphDbPath = join(repoPath, ".cortex", "graph.db");
  let edges: ImportEdge[] = [];
  if (existsSync(graphDbPath)) {
    const db = new Database(graphDbPath, { readonly: true });
    try {
      edges = collectCallsEdges(db, project);
    } finally {
      db.close();
    }
  }

  const fileToCluster = buildFileToClusterMap(cluster.clusters);
  const totalFiles = cluster.total_files;

  const metrics: EvalMetrics = {
    cluster_count: clusterCount(cluster.clusters),
    noise_rate: cluster.noise_count / Math.max(totalFiles, 1),
    total_files: totalFiles,
    co_change_agreement: agreementScore(pairs, fileToCluster),
    import_agreement: agreementScore(edges, fileToCluster),
    cluster_elapsed_seconds: null, // not yet plumbed through from the algorithm
  };

  const topTokens = (cluster.parameters?.top_tokens_per_cluster ?? {}) as Record<string, string[]>;
  const silhouette = (cluster.parameters?.silhouette_score ?? null) as number | null;
  const vocab = (cluster.parameters?.vocabulary_size ?? null) as number | null;

  const report: EvalReport = {
    algorithm: cluster.algorithm,
    repo_slug: repoSlug,
    generated_at: new Date().toISOString(),
    metrics,
    internal: {
      silhouette_score: silhouette,
      vocabulary_size: vocab,
      top_tokens_per_cluster: topTokens,
    },
    cluster_summary: buildClusterSummary(cluster.clusters, topTokens),
  };

  const md = renderEvalReport(report);
  const outPath = args.out ?? join(DEFAULT_OUT_DIR, `${slugSafe}.md`);
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  writeFileSync(outPath, md);

  console.log(`[eval] ${cluster.algorithm} / ${repoSlug}`);
  console.log(`[eval]   files=${metrics.total_files} clusters=${metrics.cluster_count} noise=${metrics.noise_rate.toFixed(3)}`);
  console.log(`[eval]   co_change_agreement=${metrics.co_change_agreement?.toFixed(3) ?? "—"} import_agreement=${metrics.import_agreement?.toFixed(3) ?? "—"}`);
  console.log(`[eval]   silhouette=${silhouette?.toFixed(3) ?? "—"} vocab=${vocab ?? "—"}`);
  console.log(`[eval] wrote ${outPath}`);
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("eval.ts");
if (isDirect) main();

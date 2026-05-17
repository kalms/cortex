// scripts/frame-extraction/cluster-tfidf-hdbscan.ts
/**
 * TF-IDF + HDBSCAN clustering candidate for Cortex frame extraction Phase 2.
 *
 * Flow: open the repo's `.cortex/graph.db`, extract per-file blobs via
 * text-blob.ts, write JSONL to .tmp/frame-extraction/blobs/, spawn the
 * Python script, parse the resulting JSON.
 *
 * CLI: tsx scripts/frame-extraction/cluster-tfidf-hdbscan.ts <repo-path> [--out <path>]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { collectBlobsFromGraph } from "./text-blob.js";
import type { ClusterResult, FileBlob } from "./types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const PYTHON_BIN = join(REPO_ROOT, "scripts", "frame-extraction", "python", ".venv", "bin", "python");
const PYTHON_SCRIPT = join(REPO_ROOT, "scripts", "frame-extraction", "python", "tfidf_hdbscan.py");
const DEFAULT_OUT_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "clusters");
const BLOBS_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "blobs");

export interface RunOptions {
  /** Absolute path to a repo containing .cortex/graph.db. */
  repo_path: string;
  /** Project name (matches what cortex-indexer stored — usually derived
   *  from the repo path). If null, defaults to the directory basename. */
  project_name?: string | null;
  /** Where to write the cluster JSON. If null, default path under
   *  .tmp/frame-extraction/clusters/<slug>.json is used. */
  out_path?: string | null;
  min_df?: number;
  max_df?: number;
  min_cluster_size?: number;
}

export interface RunResult {
  result: ClusterResult;
  /** Absolute path to the written cluster JSON. */
  out_path: string;
  /** Absolute path to the intermediate blob JSONL (kept for debugging). */
  blobs_path: string;
}

/** Run the full pipeline: extract blobs, spawn Python, parse output.
 *  Throws on failure with a descriptive message. */
export function runTfIdfHdbscan(opts: RunOptions): RunResult {
  if (!existsSync(PYTHON_BIN)) {
    throw new Error(
      `Python venv not found at ${PYTHON_BIN}. ` +
      `Run \`npm run setup-python\` first.`,
    );
  }
  const graphDbPath = join(opts.repo_path, ".cortex", "graph.db");
  if (!existsSync(graphDbPath)) {
    throw new Error(
      `No graph DB at ${graphDbPath}. ` +
      `Index the repo with cortex-indexer first.`,
    );
  }
  // deriveProjectName is byte-equivalent to the C indexer when given an
  // absolute path — resolve first so programmatic callers don't need to.
  const project = opts.project_name ?? deriveProjectName(resolve(opts.repo_path));
  const slug = project.replace(/[^A-Za-z0-9._-]/g, "_");

  // 1. Extract blobs from the graph DB.
  const db = new Database(graphDbPath, { readonly: true });
  let blobs: FileBlob[];
  try {
    blobs = collectBlobsFromGraph(db, project);
  } finally {
    db.close();
  }

  // 2. Write blob JSONL. Intentionally not cleaned up on Python failure —
  //    inspecting the blob input is the first debugging step, and the file
  //    is overwritten on the next successful run keyed on the same slug.
  mkdirSync(BLOBS_DIR, { recursive: true });
  const blobsPath = join(BLOBS_DIR, `${slug}.jsonl`);
  writeFileSync(
    blobsPath,
    blobs.map((b) => JSON.stringify(b)).join("\n") + "\n",
  );

  // 3. Resolve output path.
  mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  const outPath = opts.out_path ?? join(DEFAULT_OUT_DIR, `${slug}.json`);

  // 4. Spawn Python.
  const args = [
    PYTHON_SCRIPT,
    "--in", blobsPath,
    "--out", outPath,
    "--min-df", String(opts.min_df ?? 2),
    "--max-df", String(opts.max_df ?? 0.8),
    "--min-cluster-size", String(opts.min_cluster_size ?? 5),
  ];
  const proc = spawnSync(PYTHON_BIN, args, { encoding: "utf-8" });
  if (proc.error) {
    throw new Error(`Python spawn failed: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    throw new Error(
      `Python script exited with status ${proc.status}\n` +
      `STDOUT: ${proc.stdout?.slice(0, 1000)}\n` +
      `STDERR: ${proc.stderr?.slice(0, 1000)}`,
    );
  }

  // 5. Parse output.
  const result = JSON.parse(readFileSync(outPath, "utf-8")) as ClusterResult;
  return { result, out_path: outPath, blobs_path: blobsPath };
}

export function deriveProjectName(absPath: string): string {
  // Byte-equivalent port of ctx_project_name_from_path from
  // internal/indexer/src/pipeline/fqn.c (verified against
  // internal/indexer/tests/test_fqn.c). Steps, in order:
  //   1. Empty / null input → "root"
  //   2. Normalize separators: \ → /
  //   3. Replace / and : with -
  //   4. Collapse consecutive dashes
  //   5. Trim leading AND trailing dashes
  //   6. If the result is empty (e.g. input was "///"), → "root"
  //
  // The C function processes the input string as-is — no path resolution.
  // Callers must pass an absolute path; the CLI's `main` already does this
  // via `resolve(args[0])`.
  if (!absPath) return "root";
  const result = absPath
    .replace(/\\/g, "/")
    .replace(/[/:]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return result || "root";
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("usage: tsx cluster-tfidf-hdbscan.ts <repo-path> [--out <path>] [--project <name>] [--min-df N] [--max-df F] [--min-cluster-size N]");
    process.exit(2);
  }
  const opts: RunOptions = { repo_path: resolve(args[0]!) };
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out") opts.out_path = args[++i]!;
    else if (args[i] === "--project") opts.project_name = args[++i]!;
    else if (args[i] === "--min-df") opts.min_df = Number(args[++i]);
    else if (args[i] === "--max-df") opts.max_df = Number(args[++i]);
    else if (args[i] === "--min-cluster-size") opts.min_cluster_size = Number(args[++i]);
  }
  const { result, out_path } = runTfIdfHdbscan(opts);
  const nonNoiseCount = result.clusters.filter((c) => c.cluster_id !== -1).length;
  console.log(`[tfidf-hdbscan] ${result.total_files} files, ${nonNoiseCount} clusters, ${result.noise_count} noise`);
  console.log(`[tfidf-hdbscan] wrote ${out_path}`);
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("cluster-tfidf-hdbscan.ts");
if (isDirect) main();

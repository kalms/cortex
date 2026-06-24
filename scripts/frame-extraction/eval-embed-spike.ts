// scripts/frame-extraction/eval-embed-spike.ts
/**
 * SPIKE (discardable) — embedding-signal clustering vs the TF-IDF baseline.
 *
 * For each repo: build blobs, export per-file embeddings (mean of the int8
 * function/method vectors the indexer stored in ctx_node_vectors), then run
 * the clustering twice — Arm 0 (TF-IDF baseline) and Arm 1 (pure embedding,
 * embed_gamma=1.0) — and score both for the metrics that matter:
 *
 *   - cluster_n_count  : # frames whose label falls back to `cluster:N`  (PRIMARY)
 *   - clusters_below_f1: # clusters below the F1 floor
 *   - label_f1_weighted: member-weighted label quality (guardrail: must hold)
 *   - cluster_count / noise_rate
 *
 * Also re-runs Arm 1 once more and asserts byte-identical cluster membership
 * (determinism gate). Pure-module reuse; the only production change is the
 * additive `--embeddings` flag on tfidf_hdbscan.py.
 *
 * Usage: tsx scripts/frame-extraction/eval-embed-spike.ts [repoPath ...]
 *   default repo: the cortex checkout this script lives in.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { collectBlobsFromGraph } from "../../src/frame-extraction/text-blob.js";
import {
  runTfIdfHdbscan,
  deriveProjectName,
} from "../../src/frame-extraction/cluster-tfidf-hdbscan.js";
import { buildFrameAssignments } from "../../src/frame-extraction/inject-frames.js";
import {
  buildCorpusIndex,
  scoreClusters,
  aggregateLabelQuality,
} from "../../src/frame-extraction/label-quality.js";
import type { ClusterResult, FileBlob } from "../../src/frame-extraction/types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const TMP = join(REPO_ROOT, ".tmp", "frame-extraction", "embed-spike");

/** Resolve a readable graph DB for a repo: prefer in-repo .cortex/db, then the
 *  shared indexer cache (~/.cache/cortex-indexer/<project>.db), then graph.db. */
function resolveGraphDb(repoPath: string, project: string): string | null {
  const candidates = [
    join(repoPath, ".cortex", "db"),
    join(homedir(), ".cache", "cortex-indexer", `${project}.db`),
    join(repoPath, ".cortex", "graph.db"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Export a per-file embedding by mean-aggregating the int8 vectors of every
 *  function/method the file DEFINES. ctx_node_vectors.node_id is the integer
 *  suffix of nodes.id ('ctx-<int>'); vectors are 768-dim signed int8 BLOBs. */
function exportFileEmbeddings(
  db: Database.Database,
  project: string,
): { embeddings: Map<string, number[]>; dim: number; filesCovered: number } {
  // Does the vectors table even exist?
  const hasTable = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='ctx_node_vectors'`,
    )
    .get();
  const embeddings = new Map<string, number[]>();
  if (!hasTable) return { embeddings, dim: 0, filesCovered: 0 };

  const rows = db
    .prepare(
      `SELECT n.file_path AS file_path, v.vector AS vector
         FROM ctx_node_vectors v
         JOIN nodes n ON n.id = 'ctx-' || v.node_id
        WHERE v.project = ?
          AND n.kind IN ('function','method')
          AND n.file_path IS NOT NULL AND n.file_path != ''
        ORDER BY n.file_path`,
    )
    .all(project) as Array<{ file_path: string; vector: Buffer }>;

  // Accumulate float sums per file, then divide by count → mean vector.
  const sums = new Map<string, { sum: Float64Array; n: number }>();
  let dim = 0;
  for (const r of rows) {
    const buf = r.vector;
    const d = buf.length; // bytes == int8 dims
    if (dim === 0) dim = d;
    if (d !== dim) continue; // skip malformed
    let acc = sums.get(r.file_path);
    if (!acc) {
      acc = { sum: new Float64Array(dim), n: 0 };
      sums.set(r.file_path, acc);
    }
    for (let i = 0; i < dim; i++) acc.sum[i] += buf.readInt8(i);
    acc.n += 1;
  }
  for (const [path, acc] of sums) {
    if (acc.n === 0) continue;
    const mean = new Array<number>(dim);
    for (let i = 0; i < dim; i++) mean[i] = acc.sum[i] / acc.n;
    embeddings.set(path, mean);
  }
  return { embeddings, dim, filesCovered: embeddings.size };
}

interface ArmScore {
  arm: string;
  cluster_count: number;
  noise_rate: number;
  cluster_n_count: number;
  clusters_below_f1: number;
  label_f1_weighted: number;
  label_f1_mean: number;
}

/** Count frames whose final label falls back to `cluster:N`, and score label
 *  quality — both off the SAME ClusterResult the viewer would consume. */
function scoreArm(arm: string, result: ClusterResult, blobs: FileBlob[]): ArmScore {
  const assignments = buildFrameAssignments(result);
  // One label per frame_id; count distinct frames whose label is cluster:N.
  const labelByFrame = new Map<number, string>();
  for (const a of assignments) labelByFrame.set(a.frame_id, a.frame_label);
  let clusterN = 0;
  for (const label of labelByFrame.values()) {
    if (label.startsWith("cluster:")) clusterN += 1;
  }

  const topTokens = (result.parameters?.top_tokens_per_cluster ?? {}) as Record<string, string[]>;
  const idx = buildCorpusIndex(blobs);
  const scores = scoreClusters(result.clusters, topTokens, idx);
  const agg = aggregateLabelQuality(scores);

  const real = result.clusters.filter((c) => c.cluster_id !== -1);
  let noiseMembers = 0;
  let total = 0;
  for (const c of result.clusters) {
    total += c.member_paths.length;
    if (c.cluster_id === -1) noiseMembers += c.member_paths.length;
  }
  return {
    arm,
    cluster_count: real.length,
    noise_rate: total === 0 ? 0 : noiseMembers / total,
    cluster_n_count: clusterN,
    clusters_below_f1: agg.clusters_below,
    label_f1_weighted: agg.f1_weighted,
    label_f1_mean: agg.f1_mean,
  };
}

/** A stable signature of cluster membership for the determinism check. */
function membershipSignature(result: ClusterResult): string {
  return result.clusters
    .map((c) => `${c.cluster_id}:${[...c.member_paths].sort().join(",")}`)
    .sort()
    .join("|");
}

function runRepo(repoPath: string): { slug: string; rows: ArmScore[]; note: string } {
  const abs = resolve(repoPath);
  const project = deriveProjectName(abs);
  const slug = basename(abs);
  const dbPath = resolveGraphDb(abs, project);
  if (!dbPath) return { slug, rows: [], note: `no graph DB for ${project}` };

  // Blobs (for TF-IDF + the corpus index used by the label scorer).
  const db = new Database(dbPath, { readonly: true });
  let blobs: FileBlob[];
  let emb: ReturnType<typeof exportFileEmbeddings>;
  try {
    blobs = collectBlobsFromGraph(db, project);
    emb = exportFileEmbeddings(db, project);
  } finally {
    db.close();
  }
  if (blobs.length === 0) return { slug, rows: [], note: "no blobs" };

  mkdirSync(TMP, { recursive: true });
  const safe = project.replace(/[^A-Za-z0-9._-]/g, "_");
  const embPath = join(TMP, `${safe}.emb.jsonl`);
  writeFileSync(
    embPath,
    [...emb.embeddings.entries()]
      .map(([path, embedding]) => JSON.stringify({ path, embedding }))
      .join("\n") + "\n",
  );
  const coverage = blobs.length > 0 ? emb.filesCovered / blobs.length : 0;
  const note =
    `dim=${emb.dim} embeddable_files=${emb.filesCovered}/${blobs.length} ` +
    `(${(coverage * 100).toFixed(0)}%)`;

  // Arm 0 — TF-IDF baseline.
  const base = runTfIdfHdbscan({
    repo_path: abs, project_name: project, db_path: dbPath,
    co_change_path: null, // pure topical baseline
    out_path: join(TMP, `${safe}.base.json`),
  });
  // Arm 1 — pure embedding (embed_gamma = 1.0).
  const arm1 = runTfIdfHdbscan({
    repo_path: abs, project_name: project, db_path: dbPath,
    embeddings_path: embPath, embed_gamma: 1.0,
    out_path: join(TMP, `${safe}.embed.json`),
  });
  // Determinism: re-run Arm 1, compare membership.
  const arm1b = runTfIdfHdbscan({
    repo_path: abs, project_name: project, db_path: dbPath,
    embeddings_path: embPath, embed_gamma: 1.0,
    out_path: join(TMP, `${safe}.embed2.json`),
  });
  const deterministic =
    membershipSignature(arm1.result) === membershipSignature(arm1b.result);

  const rows = [
    scoreArm("baseline (tfidf)", base.result, blobs),
    scoreArm("embedding (eg=1.0)", arm1.result, blobs),
  ];
  return {
    slug,
    rows,
    note: `${note} | determinism=${deterministic ? "PASS" : "FAIL"}`,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const repos = argv.length > 0 ? argv : [REPO_ROOT];
  const out: Array<{ slug: string; rows: ArmScore[]; note: string }> = [];
  for (const r of repos) {
    process.stderr.write(`[embed-spike] ${r}\n`);
    const res = runRepo(r);
    out.push(res);
    process.stderr.write(`[embed-spike]   ${res.note}\n`);
  }

  // Print a comparison table.
  const fmt = (n: number) => n.toFixed(3);
  for (const repo of out) {
    console.log(`\n## ${repo.slug}`);
    console.log(`   ${repo.note}`);
    if (repo.rows.length === 0) { console.log("   (skipped)"); continue; }
    console.log(
      `   ${"arm".padEnd(20)} ${"clusters".padEnd(9)} ${"cluster:N".padEnd(10)} ` +
      `${"<F1floor".padEnd(9)} ${"f1_wt".padEnd(7)} ${"noise".padEnd(6)}`,
    );
    for (const row of repo.rows) {
      console.log(
        `   ${row.arm.padEnd(20)} ${String(row.cluster_count).padEnd(9)} ` +
        `${String(row.cluster_n_count).padEnd(10)} ${String(row.clusters_below_f1).padEnd(9)} ` +
        `${fmt(row.label_f1_weighted).padEnd(7)} ${fmt(row.noise_rate).padEnd(6)}`,
      );
    }
  }

  mkdirSync(TMP, { recursive: true });
  const reportPath = join(TMP, "embed-spike-report.json");
  writeFileSync(reportPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`\n[embed-spike] wrote ${reportPath}`);
}

main();

#!/usr/bin/env tsx
/*
 * Corpus survey runner — Phase 1 of frame-extraction work.
 *
 * For each repo in BATCH:
 *   1. shallow-clone into ~/.cache/cortex-corpus/<owner>--<name>/
 *   2. invoke bin/cortex-indexer cli index_repository against it
 *   3. read the resulting <clone>/.cortex/db and compute calibration stats
 *   4. append the result to docs/corpus/results.json (overwriting any prior
 *      entry for the same slug)
 *   5. delete the clone — the content-hash cache at ~/.cache/cortex/<key>.db
 *      preserves the index for cheap re-runs
 *
 * Usage: tsx scripts/corpus/run-survey.ts
 *
 * Idempotent. Safe to interrupt mid-run; partial results are persisted after
 * each repo. Re-running with the same BATCH replaces those entries.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const INDEXER = join(REPO_ROOT, "bin", "cortex-indexer");
const CORPUS_DIR = join(homedir(), ".cache", "cortex-corpus");
const RESULTS_PATH = join(REPO_ROOT, "docs", "corpus", "results.json");

type RepoSpec = {
  slug: string;
  url: string;
  archetype: string;
  notes?: string;
};

type RepoResult = RepoSpec & {
  commit_sha: string;
  tree_sha: string;
  indexed_at: string;
  index_duration_ms: number;
  stats: {
    entity_count: number;
    edge_count: number;
    edge_density: number;
    file_count: number;
    directory_depth_max: number;
    directory_depth_p50: number;
    language_mix: Record<string, number>;
    kind_mix: Record<string, number>;
  };
};

type ResultsDoc = {
  generated_at: string;
  indexer_version: string;
  repos: RepoResult[];
};

function indexerVersion(): string {
  return execSync(`${INDEXER} --version`, { encoding: "utf8" }).trim();
}

function safeDirName(slug: string): string {
  return slug.replace(/\//g, "--");
}

function shallowClone(spec: RepoSpec): { repoDir: string; commit: string; tree: string } {
  const repoDir = join(CORPUS_DIR, safeDirName(spec.slug));
  if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  mkdirSync(CORPUS_DIR, { recursive: true });
  execSync(`git clone --depth=1 ${spec.url}.git "${repoDir}"`, {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const commit = execSync("git rev-parse HEAD", { cwd: repoDir, encoding: "utf8" }).trim();
  const tree = execSync("git rev-parse HEAD^{tree}", { cwd: repoDir, encoding: "utf8" }).trim();
  return { repoDir, commit, tree };
}

function runIndex(repoDir: string): { elapsedMs: number; project: string } {
  const dbPath = join(repoDir, ".cortex", "db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const start = Date.now();
  const result = spawnSync(
    INDEXER,
    ["cli", "index_repository", JSON.stringify({ repo_path: repoDir })],
    {
      env: { ...process.env, CORTEX_DB: dbPath },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30 * 60 * 1000,
    },
  );
  const elapsedMs = Date.now() - start;
  if (result.status !== 0) {
    throw new Error(`index_repository exit ${result.status}: ${result.stderr.slice(0, 500)}`);
  }
  // Indexer wraps responses in MCP envelope; isError signals failure.
  // The inner text payload includes the canonical project name — parse it
  // out rather than re-deriving (indexer collapses runs of "-" so a clone
  // dir like "owner--repo" becomes "owner-repo" in the project name).
  let envelope: { isError?: boolean; content?: { text?: string }[] };
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    throw new Error(`indexer returned non-JSON: ${result.stdout.slice(0, 500)}`);
  }
  if (envelope.isError) {
    throw new Error(`indexer reported error: ${envelope.content?.[0]?.text ?? "(no detail)"}`);
  }
  const text = envelope.content?.[0]?.text;
  if (!text) throw new Error("indexer response missing content");
  const inner = JSON.parse(text) as { project: string };
  return { elapsedMs, project: inner.project };
}

function computeStats(dbPath: string, project: string): RepoResult["stats"] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const { c: entityCount } = db
      .prepare(
        "SELECT COUNT(*) AS c FROM nodes WHERE project = ? AND kind NOT IN ('decision','pr','todo')",
      )
      .get(project) as { c: number };
    const { c: edgeCount } = db
      .prepare("SELECT COUNT(*) AS c FROM edges WHERE project = ?")
      .get(project) as { c: number };

    const filePaths = (
      db
        .prepare(
          "SELECT DISTINCT file_path FROM nodes WHERE project = ? AND file_path IS NOT NULL AND file_path != ''",
        )
        .all(project) as { file_path: string }[]
    ).map((r) => r.file_path);

    const fileCount = filePaths.length;
    const depths = filePaths.map((p) => p.split("/").length - 1);
    depths.sort((a, b) => a - b);
    const depthMax = depths.at(-1) ?? 0;
    const depthP50 = depths[Math.floor(depths.length / 2)] ?? 0;

    const extCounts: Record<string, number> = {};
    for (const p of filePaths) {
      const ext = extname(p).toLowerCase().replace(/^\./, "") || "<none>";
      extCounts[ext] = (extCounts[ext] ?? 0) + 1;
    }
    const languageMix: Record<string, number> = {};
    for (const [ext, count] of Object.entries(extCounts).sort((a, b) => b[1] - a[1])) {
      languageMix[ext] = fileCount > 0 ? +(count / fileCount).toFixed(4) : 0;
    }

    const kindRows = db
      .prepare(
        "SELECT kind, COUNT(*) AS c FROM nodes WHERE project = ? GROUP BY kind ORDER BY c DESC",
      )
      .all(project) as { kind: string; c: number }[];
    const kindMix: Record<string, number> = {};
    for (const r of kindRows) kindMix[r.kind] = r.c;

    return {
      entity_count: entityCount,
      edge_count: edgeCount,
      edge_density: entityCount > 0 ? +(edgeCount / entityCount).toFixed(2) : 0,
      file_count: fileCount,
      directory_depth_max: depthMax,
      directory_depth_p50: depthP50,
      language_mix: languageMix,
      kind_mix: kindMix,
    };
  } finally {
    db.close();
  }
}

function loadDoc(): ResultsDoc {
  if (existsSync(RESULTS_PATH)) {
    return JSON.parse(readFileSync(RESULTS_PATH, "utf8"));
  }
  return { generated_at: new Date().toISOString(), indexer_version: indexerVersion(), repos: [] };
}

function saveDoc(doc: ResultsDoc): void {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(doc, null, 2) + "\n");
}

function cleanup(slug: string): void {
  const dir = join(CORPUS_DIR, safeDirName(slug));
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

const BATCH: RepoSpec[] = [
  {
    slug: "millionco/react-doctor",
    url: "https://github.com/millionco/react-doctor",
    archetype: "ts-tooling",
    notes: "small TS focused React linter (trending 2026-05-11)",
  },
  {
    slug: "rasbt/LLMs-from-scratch",
    url: "https://github.com/rasbt/LLMs-from-scratch",
    archetype: "research-notebook",
    notes: "matches spec's research/notebook archetype",
  },
];

function main(): void {
  const doc = loadDoc();
  doc.generated_at = new Date().toISOString();
  doc.indexer_version = indexerVersion();

  for (const spec of BATCH) {
    doc.repos = doc.repos.filter((r) => r.slug !== spec.slug);
    try {
      console.log(`\n[${spec.slug}] cloning...`);
      const { repoDir, commit, tree } = shallowClone(spec);
      console.log(`[${spec.slug}] indexing...`);
      const { elapsedMs, project } = runIndex(repoDir);
      const dbPath = join(repoDir, ".cortex", "db");
      const stats = computeStats(dbPath, project);
      doc.repos.push({
        ...spec,
        commit_sha: commit,
        tree_sha: tree,
        indexed_at: new Date().toISOString(),
        index_duration_ms: elapsedMs,
        stats,
      });
      saveDoc(doc);
      console.log(
        `[${spec.slug}] OK — entities=${stats.entity_count} edges=${stats.edge_count} files=${stats.file_count} elapsed=${(elapsedMs / 1000).toFixed(1)}s`,
      );
      cleanup(spec.slug);
    } catch (e) {
      console.error(`[${spec.slug}] FAILED: ${(e as Error).message}`);
    }
  }

  console.log(`\nDone. Wrote ${doc.repos.length} repo(s) to ${RESULTS_PATH}`);
}

main();

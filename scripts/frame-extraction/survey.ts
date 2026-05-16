// scripts/frame-extraction/survey.ts
/**
 * Phase 1 calibration survey. Reads corpus.json, indexes each repo,
 * collects (entity_count, edge_density, directory_depth, language_mix),
 * and emits per-repo JSONL to .tmp/frame-extraction/results.jsonl.
 *
 * Usage:  tsx scripts/frame-extraction/survey.ts
 *   --corpus <path>   Override the default corpus.json path
 *   --only <slug>     Run only matching repos (substring match on slug)
 *   --skip-clone      Reuse existing checkouts but don't fetch new ones
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClone } from "./clone.js";
import { callIndexer } from "./indexer.js";
import { deriveGraphStats } from "./graph-stats.js";
import { collectFsStats } from "./fs-stats.js";
import type { CorpusFile, SurveyResult, RepoStatus, RepoSpec } from "./types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const OUTPUT_DIR = join(REPO_ROOT, ".tmp", "frame-extraction");
const OUTPUT_FILE = join(OUTPUT_DIR, "results.jsonl");

function parseArgs(argv: string[]) {
  const args: { corpus?: string; only?: string; skipClone?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus") args.corpus = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--skip-clone") args.skipClone = true;
  }
  return args;
}

async function runRepo(repo: RepoSpec): Promise<SurveyResult> {
  const t0 = Date.now();
  const make = (result: RepoStatus, commit_sha: string | null = null): SurveyResult => ({
    slug: repo.slug,
    archetype: repo.archetype,
    size_hint: repo.size_hint,
    primary_language: repo.primary_language,
    commit_sha,
    result,
    elapsed_seconds: (Date.now() - t0) / 1000,
  });

  const clone = ensureClone(repo);
  if (!clone.ok) {
    return make({ ok: false, phase: "clone", message: clone.error ?? "unknown clone error" });
  }

  const idx = callIndexer<{ project: string; status: string; error?: string }>(
    "index_repository",
    { repo_path: clone.path },
  );
  if (!idx.ok) {
    return make({ ok: false, phase: "index", message: `${idx.error_phase}: ${idx.error}` }, clone.commit_sha);
  }
  const projectName = idx.data.project;

  const arch = callIndexer<{
    project: string;
    total_nodes: number;
    total_edges: number;
    node_labels: { label: string; count: number }[];
  }>("get_architecture", { aspects: ["structure"], project: projectName });
  if (!arch.ok) {
    return make({ ok: false, phase: "graph_stats", message: `${arch.error_phase}: ${arch.error}` }, clone.commit_sha);
  }

  let fs;
  try {
    fs = collectFsStats(clone.path);
  } catch (err) {
    return make({ ok: false, phase: "fs_stats", message: String(err) }, clone.commit_sha);
  }

  return make({ ok: true, stats: { ...deriveGraphStats(arch.data), ...fs } }, clone.commit_sha);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusPath = args.corpus ?? join(REPO_ROOT, "scripts", "frame-extraction", "corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as CorpusFile;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  if (existsSync(OUTPUT_FILE)) unlinkSync(OUTPUT_FILE);

  const filtered = args.only
    ? corpus.repos.filter(r => r.slug.includes(args.only!))
    : corpus.repos;

  console.log(`[survey] ${filtered.length} repos to process. Output: ${OUTPUT_FILE}`);
  for (const repo of filtered) {
    console.log(`[survey] → ${repo.slug} (${repo.archetype})`);
    const result = await runRepo(repo);
    appendFileSync(OUTPUT_FILE, JSON.stringify(result) + "\n");
    if (!result.result.ok) {
      console.log(`[survey]   ✗ ${result.result.phase}: ${result.result.message.slice(0, 120)}`);
    } else {
      const s = result.result.stats;
      console.log(`[survey]   ✓ entities=${s.entity_count} edges=${s.total_edges} density=${s.edge_density.toFixed(3)} files=${s.file_count} max_depth=${s.max_depth}`);
    }
  }
  console.log(`[survey] done. Run \`tsx scripts/frame-extraction/report.ts\` to render the report.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

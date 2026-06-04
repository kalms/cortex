// scripts/frame-extraction/eval-all.ts
/**
 * Corpus-wide frame-extraction eval runner.
 *
 * For each repo in scripts/frame-extraction/corpus.json: clone + index +
 * cluster, compute cross-signal metrics (cluster_count, noise_rate,
 * import_agreement_strict over CALLS edges), run the label-quality checker,
 * and aggregate one row per repo into a single JSON output.
 *
 * Per-repo failures are caught and recorded — one bad repo never aborts the
 * corpus run.
 *
 * Usage:  tsx scripts/frame-extraction/eval-all.ts
 *   --out <path>      Output JSON path (default: .tmp/frame-extraction/eval-all.json)
 *   --only <slug>     Run only repos whose slug includes <slug>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ensureClone } from "./clone.js";
import { callIndexer } from "./indexer.js";
import { collectCallsEdges } from "./eval-edges.js";
import { agreementScore, buildFileToClusterMap, clusterCount, noiseRate } from "./eval-metrics.js";
import {
  runTfIdfHdbscan,
  deriveProjectName,
} from "../../src/frame-extraction/cluster-tfidf-hdbscan.js";
import { checkLabelQuality } from "../../src/frame-extraction/eval-labels.js";
import { hasVenv } from "../../src/frame-extraction/venv.js";
import { cachePathForProject } from "../../src/cli/context.js";
import type { CorpusFile, RepoSpec, ImportEdge } from "../../src/frame-extraction/types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DEFAULT_OUT = join(REPO_ROOT, ".tmp", "frame-extraction", "eval-all.json");

interface CliArgs {
  out: string;
  only?: string;
  keep?: boolean;
}

interface RepoEvalRow {
  slug: string;
  ok: boolean;
  /** Resolved indexer project name (slug-form). Present on success; used by
   *  teardown to deregister git-cloned corpus projects after the run. */
  project?: string;
  error?: string;
  cluster_count?: number;
  noise_rate?: number;
  import_agreement_strict?: number | null;
  label_violations?: number;
  violation_rules?: Record<string, number>;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = resolve(argv[++i]!);
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--keep") args.keep = true;
  }
  return args;
}

/**
 * Project names to deregister after a corpus run. Only **git-cloned** corpus
 * repos are returned — never `local_path` fixtures (e.g. `self/cortex`,
 * `local/anthill-cloud`), which are real registered projects the user owns.
 * Rows without a resolved `project` (clone/index failures) are skipped.
 *
 * Pure: takes the repos that ran + their result rows, returns names to delete.
 * This is the contract that keeps the eval from polluting the global project
 * registry: measurement must leave no trace.
 */
export function teardownTargets(repos: RepoSpec[], rows: RepoEvalRow[]): string[] {
  const clonedSlugs = new Set(repos.filter((r) => r.git !== null).map((r) => r.slug));
  const out: string[] = [];
  for (const row of rows) {
    if (!clonedSlugs.has(row.slug)) continue;
    if (row.project) out.push(row.project);
  }
  return out;
}

/** Run the full eval pipeline for one repo. Never throws — failures are
 *  caught and returned as { ok: false, error }. */
function evalRepo(repo: RepoSpec): RepoEvalRow {
  try {
    const clone = ensureClone(repo);
    if (!clone.ok) {
      return { slug: repo.slug, ok: false, error: `clone: ${clone.error ?? "unknown clone error"}` };
    }

    const idx = callIndexer<{ project: string; status: string; error?: string }>(
      "index_repository",
      { repo_path: clone.path },
    );
    if (!idx.ok) {
      return { slug: repo.slug, ok: false, error: `index: ${idx.error_phase}: ${idx.error}` };
    }
    const project = idx.data.project ?? deriveProjectName(resolve(clone.path));

    // The standalone indexer writes the graph DB to the shared cache
    // (~/.cache/cortex-indexer/<project>.db), not into the repo's .cortex
    // dir. Resolve that first; fall back to an in-repo .cortex DB if present.
    const graphDbPath = [
      cachePathForProject(project),
      join(clone.path, ".cortex", "db"),
      join(clone.path, ".cortex", "graph.db"),
    ].find((p) => existsSync(p));
    if (!graphDbPath) {
      return { slug: repo.slug, ok: false, error: `no graph DB found for project ${project}` };
    }

    const { result } = runTfIdfHdbscan({
      repo_path: clone.path,
      project_name: project,
      db_path: graphDbPath,
    });

    const fileToCluster = buildFileToClusterMap(result.clusters);

    // Cross-signal import agreement over CALLS edges from the graph DB.
    let edges: ImportEdge[] = [];
    {
      const db = new Database(graphDbPath, { readonly: true });
      try {
        edges = collectCallsEdges(db, project);
      } finally {
        db.close();
      }
    }
    const importAgreementStrict = agreementScore(edges, fileToCluster, "strict");

    const topTokens = (result.parameters?.top_tokens_per_cluster ?? {}) as Record<string, string[]>;
    const violations = checkLabelQuality(result.clusters, topTokens);
    const violationRules: Record<string, number> = {};
    for (const v of violations) violationRules[v.rule] = (violationRules[v.rule] ?? 0) + 1;

    return {
      slug: repo.slug,
      ok: true,
      project,
      cluster_count: clusterCount(result.clusters),
      noise_rate: noiseRate(result.clusters),
      import_agreement_strict: importAgreementStrict,
      label_violations: violations.length,
      violation_rules: violationRules,
    };
  } catch (err) {
    return { slug: repo.slug, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!hasVenv()) {
    console.error(
      "[eval-all] Python venv not found. Run `cortex setup frames` first.",
    );
    process.exit(2);
  }

  const corpusPath = join(REPO_ROOT, "scripts", "frame-extraction", "corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as CorpusFile;

  const filtered = args.only
    ? corpus.repos.filter((r) => r.slug.includes(args.only!))
    : corpus.repos;

  console.log(`[eval-all] ${filtered.length} repos to process. Output: ${args.out}`);

  const rows: RepoEvalRow[] = [];
  for (const repo of filtered) {
    console.log(`[eval-all] → ${repo.slug} (${repo.archetype})`);
    const row = evalRepo(repo);
    rows.push(row);
    if (!row.ok) {
      console.log(`[eval-all]   ✗ ${(row.error ?? "").slice(0, 160)}`);
    } else {
      const agree = row.import_agreement_strict;
      console.log(
        `[eval-all]   ✓ clusters=${row.cluster_count} ` +
          `noise=${row.noise_rate?.toFixed(3)} ` +
          `agree=${agree === null || agree === undefined ? "—" : agree.toFixed(3)} ` +
          `labelViol=${row.label_violations}`,
      );
    }
  }

  mkdirSync(resolve(args.out, ".."), { recursive: true });
  writeFileSync(
    args.out,
    JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2),
  );
  console.log(`[eval-all] wrote ${args.out}`);

  // Teardown: deregister the git-cloned corpus projects we just indexed, so
  // the eval leaves the global project registry as it found it. Local fixtures
  // (self/cortex, anthill-cloud) are never touched. Opt out with --keep.
  if (args.keep) {
    console.log("[eval-all] --keep set: corpus projects left registered.");
    return;
  }
  const targets = teardownTargets(filtered, rows);
  for (const project of targets) {
    const del = callIndexer<{ status?: string }>("delete_project", { project });
    console.log(
      del.ok
        ? `[eval-all]   ⌫ deregistered ${project}`
        : `[eval-all]   ⚠ could not deregister ${project}: ${del.error}`,
    );
  }
  if (targets.length > 0) {
    console.log(`[eval-all] teardown: deregistered ${targets.length} corpus project(s) (use --keep to retain).`);
  }
}

const isDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("eval-all.ts");
if (isDirect) main();

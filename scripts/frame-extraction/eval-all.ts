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
import { buildCorpusIndex, scoreClusters, aggregateLabelQuality } from "../../src/frame-extraction/label-quality.js";
import { evaluateF1Gate, F1_GATE_DEFAULTS } from "../../src/frame-extraction/eval-gate.js";
import type { CorpusFile, RepoSpec, ImportEdge, FileBlob } from "../../src/frame-extraction/types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DEFAULT_OUT = join(REPO_ROOT, ".tmp", "frame-extraction", "eval-all.json");
const DEFAULT_BASELINE = join(REPO_ROOT, "scripts", "frame-extraction", "baselines", "2026-06-06.json");

interface CliArgs {
  out: string;
  only?: string;
  keep?: boolean;
  validate?: boolean;       // opt-in LLM intruder phase
  validateSample?: number;  // max trials per repo (default 15)
  model?: string;
  seed?: number;            // PRNG seed for reproducible intruder sampling
  gate?: boolean;           // F1 regression gate (default on; --no-gate to skip)
  baseline?: string;        // baseline JSON path for the gate
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
  label_f1_mean?: number;
  label_f1_weighted?: number;
  label_coverage_mean?: number;
  label_specificity_mean?: number;
  label_clusters_below_f1?: number;
  validation?: {
    sampled: number;
    not_validated: number;
    trials: { cluster_id: number; label: string; f1: number; intruder_found: boolean }[];
  };
}

/** Mulberry32 PRNG — small, seedable, good enough for shuffling trial order. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = s + 0x6d2b79f5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = resolve(argv[++i]!);
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--keep") args.keep = true;
    else if (argv[i] === "--validate") args.validate = true;
    else if (argv[i] === "--validate-sample") args.validateSample = Number(argv[++i]);
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--seed") args.seed = Number(argv[++i]);
    else if (argv[i] === "--no-gate") args.gate = false;
    else if (argv[i] === "--baseline") args.baseline = resolve(argv[++i]!);
  }
  return args;
}

/** Run the F1 regression gate against the committed baseline. Prints a report
 *  and returns true when an ENFORCED regression was detected (caller exits
 *  non-zero). Skips quietly when disabled or no baseline file exists. */
function runF1Gate(args: CliArgs, rows: RepoEvalRow[]): boolean {
  if (args.gate === false) return false;
  const baselinePath = args.baseline ?? DEFAULT_BASELINE;
  if (!existsSync(baselinePath)) {
    console.log(`\n[eval-all] F1 gate: no baseline at ${baselinePath} — skipping (commit one to enable).`);
    return false;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8")) as { rows?: RepoEvalRow[] };
  const gate = evaluateF1Gate(rows, baseline.rows ?? []);
  console.log(`\n[eval-all] F1 regression gate (vs ${baselinePath}):`);
  if (gate.currentMean !== null) {
    console.log(`[eval-all]   corpus mean weighted F1 = ${gate.currentMean} vs baseline ${gate.baselineMean} (Δ ${gate.delta}) over ${gate.comparedRepos} comparable repos`);
  }
  for (const w of gate.warnings) console.log(`[eval-all]   ⚠ ${w}`);
  if (!gate.enforced) {
    console.log(`[eval-all]   gate not enforced (${gate.comparedRepos}/${F1_GATE_DEFAULTS.minReposToEnforce} comparable repos needed).`);
    return false;
  }
  if (gate.pass) {
    console.log(`[eval-all]   ✓ gate passed.`);
    return false;
  }
  for (const f of gate.failures) console.log(`[eval-all]   ✗ ${f}`);
  return true;
}

/**
 * Project names to deregister after a corpus run. Only **git-cloned** corpus
 * repos are returned — never `local_path` fixtures (e.g. `self/cortex`),
 * which are real registered projects the user owns.
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
async function evalRepo(repo: RepoSpec, opts: { validate: boolean; validateSample: number; model: string; seed?: number }): Promise<RepoEvalRow> {
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

    const { result, blobs_path } = runTfIdfHdbscan({
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

    if (!existsSync(blobs_path)) {
      return { slug: repo.slug, ok: false, error: `blobs file not found: ${blobs_path}` };
    }
    const blobs = readFileSync(blobs_path, "utf-8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FileBlob);
    const corpusIndex = buildCorpusIndex(blobs);
    const labelScores = scoreClusters(result.clusters, topTokens, corpusIndex);
    // aggregateLabelQuality's own cluster_count is not surfaced; RepoEvalRow.cluster_count already carries it.
    const labelAgg = aggregateLabelQuality(labelScores);

    const row: RepoEvalRow = {
      slug: repo.slug,
      ok: true,
      project,
      cluster_count: clusterCount(result.clusters),
      noise_rate: noiseRate(result.clusters),
      import_agreement_strict: importAgreementStrict,
      label_violations: violations.length,
      violation_rules: violationRules,
      label_f1_mean: labelAgg.f1_mean,
      label_f1_weighted: labelAgg.f1_weighted,
      label_coverage_mean: labelAgg.coverage_mean,
      label_specificity_mean: labelAgg.specificity_mean,
      label_clusters_below_f1: labelAgg.clusters_below,
    };

    if (opts.validate) {
      try {
        const { buildIntruderTrials } = await import("./intruder.js");
        const realClusterCount = result.clusters.filter((c) => c.cluster_id !== -1).length;
        // Build a seeded pick function if a seed was supplied, for reproducible sampling.
        const intruderOpts = Number.isFinite(opts.seed)
          ? (() => { const rng = mulberry32(opts.seed!); return { membersPerTrial: 5, pick: (n: number) => Math.floor(rng() * n) }; })()
          : { membersPerTrial: 5 };
        const allTrials = buildIntruderTrials(result.clusters, intruderOpts);
        // Guard against NaN from a missing/garbage --validate-sample value.
        const validateSample = Number.isFinite(opts.validateSample) ? opts.validateSample : 15;
        const trials = allTrials.slice(0, validateSample);
        const labelByCluster = new Map(labelScores.map((s) => [s.cluster_id, s.label]));
        const f1ByCluster = new Map(labelScores.map((s) => [s.cluster_id, s.f1]));
        const { runIntruderValidation } = await import("./validate-labels.js");
        const results = await runIntruderValidation({
          repoPath: clone.path,
          model: opts.model,
          trials,
          labelByCluster,
          f1ByCluster,
        });
        row.validation = {
          sampled: trials.length,
          // clusters that yielded no trial: too-few-members or no intruder source, plus
          // any beyond the sample cap.
          not_validated: realClusterCount - results.length,
          trials: results,
        };
        console.log(`[eval-all]   ⟳ validated ${results.length}/${realClusterCount} clusters (sample cap ${validateSample})`);
      } catch (err) {
        console.log(`[eval-all]   ⚠ validation skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return row;
  } catch (err) {
    return { slug: repo.slug, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function main() {
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
    // Sonnet is plenty for the intruder-detection task (single-index odd-one-out
    // over short snippets) and far cheaper across hundreds of corpus-wide calls;
    // override with --model claude-opus-4-8 to spot-check sensitivity.
    const row = await evalRepo(repo, { validate: !!args.validate, validateSample: args.validateSample ?? 15, model: args.model ?? "claude-sonnet-4-6", seed: args.seed });
    rows.push(row);
    if (!row.ok) {
      console.log(`[eval-all]   ✗ ${(row.error ?? "").slice(0, 160)}`);
    } else {
      const agree = row.import_agreement_strict;
      console.log(
        `[eval-all]   ✓ clusters=${row.cluster_count} ` +
          `noise=${row.noise_rate?.toFixed(3)} ` +
          `agree=${agree === null || agree === undefined ? "—" : agree.toFixed(3)} ` +
          `labelViol=${row.label_violations} ` +
          `labelF1=${row.label_f1_weighted?.toFixed(3)}`,
      );
    }
  }

  mkdirSync(resolve(args.out, ".."), { recursive: true });
  writeFileSync(
    args.out,
    JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2),
  );
  console.log(`[eval-all] wrote ${args.out}`);

  if (args.validate) {
    const trials = rows.flatMap((r) => r.validation?.trials ?? []);
    if (trials.length > 0) {
      const acc = (xs: typeof trials) =>
        xs.length > 0 ? xs.filter((t) => t.intruder_found).length / xs.length : 0;
      const high = trials.filter((t) => t.f1 >= 0.5);
      const low = trials.filter((t) => t.f1 < 0.5);
      const blindSpots = trials.filter((t) => t.f1 >= 0.5 && !t.intruder_found);
      console.log(`\n[eval-all] intruder-detection (corpus-wide, ${trials.length} clusters):`);
      console.log(`[eval-all]   overall accuracy = ${acc(trials).toFixed(3)}`);
      console.log(`[eval-all]   accuracy | F1>=0.5 = ${acc(high).toFixed(3)} (n=${high.length})`);
      console.log(`[eval-all]   accuracy | F1<0.5  = ${acc(low).toFixed(3)} (n=${low.length})`);
      if (blindSpots.length > 0) {
        console.log(`[eval-all]   blind-spot candidates (high F1, intruder missed):`);
        for (const t of blindSpots) {
          console.log(`[eval-all]     cluster=${t.cluster_id} label="${t.label}" f1=${t.f1.toFixed(3)}`);
        }
      }
    }
  }

  // F1 regression gate (computed before teardown; exit deferred to the end so
  // cleanup always runs regardless of the verdict).
  const gateFailed = runF1Gate(args, rows);

  // Teardown: deregister the git-cloned corpus projects we just indexed, so
  // the eval leaves the global project registry as it found it. Local fixtures
  // (self/cortex) are never touched. Opt out with --keep.
  if (args.keep) {
    console.log("[eval-all] --keep set: corpus projects left registered.");
  } else {
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

  // Non-zero exit on an enforced regression, after cleanup.
  if (gateFailed) {
    console.error("[eval-all] F1 regression gate FAILED.");
    process.exit(3);
  }
}

const isDirect =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("eval-all.ts");
if (isDirect) main().catch((e) => { console.error(e); process.exit(1); });

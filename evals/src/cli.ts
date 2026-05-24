#!/usr/bin/env tsx
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireTarget } from "./target.js";
import { computeScorecard } from "./scorecard.js";
import { runAssertion } from "./assertions/runner.js";
import { runToolAssertion } from "./assertions/tool-runner.js";
import { ALL_ASSERTIONS } from "./assertions/registry.js";
import { writeReportArtifacts, type TargetReport } from "./report.js";
import type {
  Targets,
  Target,
  AssertionResult,
  Baseline,
} from "./assertions/types.js";

type Args = {
  target?: string;
  path?: string;
  captureBaseline?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const a of argv.slice(2)) {
    if (a.startsWith("--target=")) args.target = a.slice("--target=".length);
    else if (a.startsWith("--path=")) args.path = a.slice("--path=".length);
    else if (a.startsWith("--capture-baseline=")) args.captureBaseline = a.slice("--capture-baseline=".length);
  }
  return args;
}

function loadTargets(): Targets {
  const txt = readFileSync(resolve("evals/targets.json"), "utf-8");
  return JSON.parse(txt) as Targets;
}

function loadBaseline(target: string): Baseline | null {
  const p = resolve("evals/baselines", `${target}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as Baseline;
}

function loadFixture(target: string): { vue_file_path: string; vue_component_name: string } | null {
  const p = resolve("evals/fixtures", `${target}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function runTarget(target: Target, pathOverride?: string): TargetReport {
  const acquired = acquireTarget(target, pathOverride);
  const scorecard = computeScorecard(acquired.graphDbPath, acquired.name);
  scorecard.indexer_seconds = acquired.indexer_seconds;

  const fixture = loadFixture(acquired.name);
  const decisionsDbPath = join(resolve("evals/cache"), acquired.name, "decisions.db");

  const results: AssertionResult[] = [];
  for (const a of ALL_ASSERTIONS) {
    if (a.query.kind === "tool_call") {
      if (!fixture) {
        // Skip tool-behavior assertions when no fixture file exists for the target.
        continue;
      }
      results.push(runToolAssertion(a, {
        dbPath: acquired.graphDbPath,
        fixture,
        project: acquired.name,
        decisionsDbPath,
      }));
    } else {
      results.push(runAssertion(a, { dbPath: acquired.graphDbPath }));
    }
  }

  const baseline = loadBaseline(acquired.name);
  return { target: acquired.name, scorecard, results, baseline };
}

function captureBaseline(target: Target, pathOverride?: string): void {
  const report = runTarget(target, pathOverride);
  const baseline: Baseline = {
    target: target.name,
    captured_at: new Date().toISOString(),
    source_sha: undefined,
    nodes_by_label: report.scorecard.nodes_by_label,
    edges_by_type: report.scorecard.edges_by_type,
    per_assertion: Object.fromEntries(
      report.results.map((r) => {
        const obs = typeof r.observed === "object" && r.observed !== null && "text" in r.observed
          ? (r.observed as { text: string }).text
          : (r.observed as number | string[]);
        return [r.assertion.name, obs];
      }),
    ),
  };
  mkdirSync(resolve("evals/baselines"), { recursive: true });
  writeFileSync(resolve("evals/baselines", `${target.name}.json`), JSON.stringify(baseline, null, 2));
  console.log(`Baseline captured for ${target.name}.`);
}

function main(): void {
  const args = parseArgs(process.argv);
  const { targets } = loadTargets();

  if (args.captureBaseline) {
    const t = targets.find((x) => x.name === args.captureBaseline);
    if (!t) {
      console.error(`Unknown target: ${args.captureBaseline}`);
      process.exit(1);
    }
    captureBaseline(t, args.path);
    return;
  }

  const selected = args.target ? targets.filter((x) => x.name === args.target) : targets;
  if (selected.length === 0) {
    console.error(`No matching targets`);
    process.exit(1);
  }

  const reports: TargetReport[] = [];
  for (const t of selected) {
    try {
      reports.push(runTarget(t, args.path));
    } catch (e) {
      console.error(`[${t.name}] failed:`, e instanceof Error ? e.message : e);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/T/, "_").slice(0, 16);
  const reportsDir = resolve("evals/reports", stamp);
  const { summaryPath } = writeReportArtifacts(reportsDir, reports);
  console.log(`Eval complete. Summary: ${summaryPath}`);
}

main();

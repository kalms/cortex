import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Scorecard,
  AssertionResult,
  Baseline,
} from "./assertions/types.js";

export type TargetReport = {
  target: string;
  scorecard: Scorecard;
  results: AssertionResult[];
  baseline: Baseline | null;
};

export function renderSummary(reports: TargetReport[]): string {
  const lines: string[] = ["# Eval Run Summary", ""];

  for (const r of reports) {
    lines.push(`## ${r.target}`, "");
    const surprises = r.results.filter((x) => x.surprised);
    if (surprises.length > 0) {
      lines.push(`  Surprises (${surprises.length}):`);
      for (const s of surprises) {
        const mark = s.passed ? "✓" : "✗";
        const tail = s.passed
          ? `(fix #${s.assertion.fix_id})`
          : s.assertion.baseline_expected === "pass"
            ? "(REGRESSION)"
            : `(fix #${s.assertion.fix_id} regression)`;
        const obs = formatObserved(s.observed);
        lines.push(`    ${mark} ${s.assertion.name} — ${obs} ${tail}`);
      }
      lines.push("");
    }
    if (r.baseline) {
      lines.push("  Scorecard delta:");
      const labels = new Set([
        ...Object.keys(r.scorecard.nodes_by_label),
        ...Object.keys(r.baseline.nodes_by_label),
      ]);
      for (const label of labels) {
        const before = r.baseline.nodes_by_label[label] ?? 0;
        const after = r.scorecard.nodes_by_label[label] ?? 0;
        if (before !== after) {
          lines.push(`    nodes.${label}: ${fmt(before)} → ${fmt(after)}`);
        }
      }
      const edges = new Set([
        ...Object.keys(r.scorecard.edges_by_type),
        ...Object.keys(r.baseline.edges_by_type),
      ]);
      for (const e of edges) {
        const before = r.baseline.edges_by_type[e] ?? 0;
        const after = r.scorecard.edges_by_type[e] ?? 0;
        if (before !== after) {
          lines.push(`    edges.${e}: ${fmt(before)} → ${fmt(after)}`);
        }
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

function formatObserved(obs: AssertionResult["observed"]): string {
  if (typeof obs === "number") return `now ${obs}`;
  if (Array.isArray(obs)) return `${obs.length} rows`;
  return obs.text || "(empty)";
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function writeReportArtifacts(
  reportsDir: string,
  reports: TargetReport[],
): { summaryPath: string; perTargetPaths: { target: string; json: string; md: string }[] } {
  mkdirSync(reportsDir, { recursive: true });
  const summaryPath = join(reportsDir, "summary.md");
  writeFileSync(summaryPath, renderSummary(reports), "utf-8");

  const perTargetPaths = reports.map((r) => {
    const json = join(reportsDir, `${r.target}.json`);
    writeFileSync(json, JSON.stringify({ scorecard: r.scorecard, results: r.results }, null, 2));
    const md = join(reportsDir, `${r.target}.md`);
    writeFileSync(md, renderPerTarget(r), "utf-8");
    return { target: r.target, json, md };
  });
  return { summaryPath, perTargetPaths };
}

function renderPerTarget(r: TargetReport): string {
  const lines: string[] = [
    `# ${r.target}`,
    "",
    "| Fix | Name | Passed | Surprised | Observed |",
    "|---|---|---|---|---|",
  ];
  for (const x of r.results) {
    const observed = formatObserved(x.observed).replace(/\|/g, "\\|");
    lines.push(
      `| ${x.assertion.fix_id} | ${x.assertion.name} | ${x.passed ? "✓" : "✗"} | ${x.surprised ? "*" : ""} | ${observed} |`,
    );
  }
  return lines.join("\n");
}

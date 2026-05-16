// scripts/frame-extraction/report.ts
/**
 * Render docs/specs/cortex-v0.3/phase-1-results.md from the JSONL emitted
 * by survey.ts. Single entry point: tsx scripts/frame-extraction/report.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SurveyResult } from "./types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const INPUT_FILE = join(REPO_ROOT, ".tmp", "frame-extraction", "results.jsonl");
const OUTPUT_FILE = join(REPO_ROOT, "docs", "specs", "cortex-v0.3", "phase-1-results.md");

export function renderReport(results: SurveyResult[]): string {
  const ok = results.filter(r => r.result.ok);
  const failed = results.filter(r => !r.result.ok);

  const entityCounts = ok.map(r => (r.result.ok ? r.result.stats.entity_count : 0)).sort((a, b) => a - b);
  const densities = ok.map(r => (r.result.ok ? r.result.stats.edge_density : 0)).sort((a, b) => a - b);

  const lines: string[] = [];
  lines.push(`# Phase 1 — Index-Stats Survey Results`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Corpus size: ${results.length} (${ok.length} ok, ${failed.length} failed)`);
  lines.push("");
  lines.push(`## Per-repo stats`);
  lines.push("");
  lines.push(`| slug | archetype | lang | files | entities | edges | density | max_depth | mean_depth | aux_dirs | secs |`);
  lines.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|`);
  for (const r of ok) {
    if (!r.result.ok) continue;
    const s = r.result.stats;
    lines.push(`| \`${r.slug}\` | ${r.archetype} | ${r.primary_language} | ${s.file_count} | ${s.entity_count} | ${s.total_edges} | ${s.edge_density.toFixed(3)} | ${s.max_depth} | ${s.mean_depth.toFixed(2)} | ${s.auxiliary_directories.join(", ") || "—"} | ${r.elapsed_seconds.toFixed(1)} |`);
  }
  lines.push("");

  if (failed.length > 0) {
    lines.push(`## Failures`);
    lines.push("");
    for (const r of failed) {
      if (r.result.ok) continue;
      lines.push(`- \`${r.slug}\` (${r.archetype}): **${r.result.phase}** — ${r.result.message}`);
    }
    lines.push("");
  }

  lines.push(`## Distribution`);
  lines.push("");
  lines.push(`### entity_count`);
  lines.push(`- min: ${entityCounts[0] ?? 0}`);
  lines.push(`- p25: ${percentile(entityCounts, 0.25)}`);
  lines.push(`- median: ${percentile(entityCounts, 0.5)}`);
  lines.push(`- p75: ${percentile(entityCounts, 0.75)}`);
  lines.push(`- max: ${entityCounts[entityCounts.length - 1] ?? 0}`);
  lines.push("");
  lines.push(`### edge_density`);
  lines.push(`- min: ${densities[0]?.toFixed(3) ?? "0.000"}`);
  lines.push(`- p25: ${percentile(densities, 0.25).toFixed(3)}`);
  lines.push(`- median: ${percentile(densities, 0.5).toFixed(3)}`);
  lines.push(`- p75: ${percentile(densities, 0.75).toFixed(3)}`);
  lines.push(`- max: ${densities[densities.length - 1]?.toFixed(3) ?? "0.000"}`);
  lines.push("");

  const suggestedEntity = percentile(entityCounts, 0.25);
  const suggestedDensity = percentile(densities, 0.25);
  lines.push(`## Suggested threshold`);
  lines.push("");
  lines.push(`Starter target from the spec: \`entity_count > 300 OR edge_density > 0.05\`. p25 of the surveyed corpus is **entity_count=${suggestedEntity}**, **edge_density=${suggestedDensity.toFixed(3)}** — repos below the p25 are the calibration floor for "low complexity" (step-3 ACDC refinement skips). Tune downstream by checking how Phase-2 outputs degrade as the threshold shifts.`);
  lines.push("");

  return lines.join("\n");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function main() {
  const text = readFileSync(INPUT_FILE, "utf-8");
  const results: SurveyResult[] = text.split("\n").filter(Boolean).map(l => JSON.parse(l));
  const md = renderReport(results);
  writeFileSync(OUTPUT_FILE, md);
  console.log(`[report] wrote ${OUTPUT_FILE}`);
}

// Only run main when invoked directly, not when imported by tests.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("report.ts");
if (isDirect) main();

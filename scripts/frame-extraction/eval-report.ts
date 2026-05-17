// scripts/frame-extraction/eval-report.ts
import type { EvalReport } from "./types.js";

function fmt(n: number | null, decimals = 3): string {
  return n === null ? "—" : n.toFixed(decimals);
}

export function renderEvalReport(r: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Phase 2 Eval — \`${r.algorithm}\` on \`${r.repo_slug}\``);
  lines.push("");
  lines.push(`Generated: ${r.generated_at}`);
  lines.push("");

  lines.push(`## Cross-signal + sanity metrics`);
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push(`|---|---:|`);
  lines.push(`| total_files | ${r.metrics.total_files} |`);
  lines.push(`| cluster_count | ${r.metrics.cluster_count} |`);
  lines.push(`| noise_rate | ${fmt(r.metrics.noise_rate, 3)} |`);
  lines.push(`| co_change_agreement | ${fmt(r.metrics.co_change_agreement)} |`);
  lines.push(`| import_agreement | ${fmt(r.metrics.import_agreement)} |`);
  lines.push(`| cluster_elapsed_seconds | ${fmt(r.metrics.cluster_elapsed_seconds, 1)} |`);
  lines.push("");

  lines.push(`## Algorithm-internal metrics`);
  lines.push("");
  lines.push(`| metric | value |`);
  lines.push(`|---|---:|`);
  lines.push(`| silhouette_score | ${fmt(r.internal.silhouette_score)} |`);
  lines.push(`| vocabulary_size | ${r.internal.vocabulary_size ?? "—"} |`);
  lines.push("");

  if (r.cluster_summary.length > 0) {
    lines.push(`## Cluster summary`);
    lines.push("");
    lines.push(`| cluster | files | path prefix | top tokens | sample |`);
    lines.push(`|---:|---:|---|---|---|`);
    for (const c of r.cluster_summary) {
      const tokens = c.top_tokens.slice(0, 6).join(", ") || "—";
      const sample = c.sample_paths.slice(0, 3).map((p) => `\`${p}\``).join(", ") || "—";
      lines.push(`| ${c.cluster_id} | ${c.member_count} | \`${c.path_prefix || "(mixed)"}\` | ${tokens} | ${sample} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

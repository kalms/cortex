import type { BriefingFacts } from "./types.js";

/** Build the bounded (≤5-line) briefing headline. Pure. */
export function formatHeadline(f: BriefingFacts): string {
  const lines: string[] = [];
  if (f.decision) {
    const tag = f.decision.verdict === "match" ? "governs" : "⚠ governs";
    lines.push(`${tag} ${f.decision.id} "${f.decision.title}" (${f.decision.displayState})`);
  }
  if (f.basisMoved) {
    lines.push("⚠ basis moved since it was authored — re-judge before editing");
  }
  if (f.callerCount >= f.fanoutThreshold) {
    lines.push(`blast radius: ${f.callerCount} callers — trace_path(mode="callers") to see them`);
  } else if (f.decision) {
    lines.push(`${f.callerCount} callers`);
  }
  if (f.pr) lines.push(`linked PR #${f.pr}`);
  lines.push(`full context: context_pack("${f.target}")`);
  return lines.join("\n");
}

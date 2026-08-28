import type { StalenessReport } from "./types.js";

const MAX_ITEMS = 5;
const MAX_TITLE = 60;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/**
 * One bounded line for `cortex index` stdout, or null when there is nothing to
 * say. A clean index prints NOTHING rather than a reassuring zero: a line that
 * appears on every run is read as decoration and stops carrying information.
 *
 * The never-referenced backlog alone never earns a line — it is static, and
 * nothing the current index did changed it.
 */
export function formatIndexLine(r: StalenessReport): string | null {
  const { itemized, outstanding, no_reference_point } = r.counts;
  // `outstanding` alone never earns a line. It is a PERSISTENT count — a todo
  // whose basis moved has no way to clear it at all (todos are never
  // reconciled) — so gating on it would print "0 newly flagged, 1 outstanding"
  // on every index forever, led by a reassuring zero. That is the wallpaper
  // this design rejects. Outstanding rides as a trailing count behind news.
  if (itemized === 0) return null;
  const parts = [`staleness: ${itemized} newly flagged`];
  if (outstanding > 0) parts.push(`${outstanding} outstanding`);
  if (no_reference_point > 0) parts.push(`${no_reference_point} without a reference point`);
  if (r.concluded_branches.length > 0) parts.push(`${r.concluded_branches.length} concluded branch(es)`);
  return parts.join(", ");
}

/**
 * The SessionStart headline. Empty when nothing was newly flagged.
 *
 * This replaces the raw drifted-decision count the hook used to print, which
 * fired every session with the whole never-reconciled backlog and no delta —
 * the wallpaper §C2 warns about, and a channel that cries wolf once is ignored
 * permanently. The backlog still appears, but as a trailing count behind
 * something that actually moved.
 */
export function formatHeadline(r: StalenessReport): string {
  if (r.itemized.length === 0) return "";
  const lines = [
    `↻ cortex staleness: ${r.itemized.length} authored row(s) whose basis moved in the last index.`,
  ];
  for (const row of r.itemized.slice(0, MAX_ITEMS)) {
    const gone = row.branch_concluded ? ", branch gone" : "";
    const origin = row.origin_branch ? ` [${row.origin_branch}${gone}]` : "";
    lines.push(`  ${row.id} ${truncate(row.title, MAX_TITLE)}${origin}`);
  }
  if (r.itemized.length > MAX_ITEMS) {
    lines.push(`  …and ${r.itemized.length - MAX_ITEMS} more`);
  }
  lines.push(
    `  Judge: decision({action:"pending"}) / todo({action:"get"}). ` +
    `${r.counts.outstanding} outstanding, ${r.counts.no_reference_point} without a reference point.`,
  );
  return lines.join("\n");
}

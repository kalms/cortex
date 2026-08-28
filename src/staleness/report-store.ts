import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StalenessReport } from "./types.js";

/**
 * `<checkout>/.cortex/staleness.json`.
 *
 * Checkout-scoped, like the graph store and the briefing ledger that already
 * live in `.cortex/` — the report describes the tree the sweep ran in, and
 * `.cortex/` is gitignored and disposable. Never the canonical root: a report
 * keyed to repo identity would be shared by every worktree while describing
 * only one of them.
 */
export function reportPath(repoPath: string): string {
  return join(repoPath, ".cortex", "staleness.json");
}

/** Write the report via a temp sibling + rename, so a concurrent reader never
 *  sees a half-written file. Best-effort: a failed write must never fail an
 *  index — the cost is one missing headline. */
export function writeReport(repoPath: string, report: StalenessReport): void {
  try {
    const p = reportPath(repoPath);
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, p);
  } catch {
    /* best-effort */
  }
}

/** Read the report, or null when absent, unreadable, or written by a different
 *  report version. Version-gating makes an old report INVISIBLE rather than
 *  misparsed — a shape mismatch would surface as a wrong count, not an error. */
export function readReport(repoPath: string): StalenessReport | null {
  try {
    const parsed = JSON.parse(readFileSync(reportPath(repoPath), "utf8")) as StalenessReport;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

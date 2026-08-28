import { readReport } from "../../staleness/report-store.js";
import { formatHeadline } from "../../staleness/format.js";
import { worktreeRoot } from "../../db/git-root.js";

/**
 * `cortex staleness [--json]` — print the last index-time sweep's headline.
 *
 * SILENT (exit 0) when there is no report or nothing was newly flagged: the
 * SessionStart hook pipes this straight into its banner, so "nothing to say"
 * must produce no bytes at all rather than a reassuring zero line.
 *
 * Anchored to the CHECKOUT root, matching where the sweep wrote the report —
 * a linked worktree reads its own, never the main checkout's.
 */
export function runStalenessCommand(
  flags: Record<string, string | boolean>,
  startDir: string = process.cwd(),
): void {
  if (process.env.CORTEX_STALENESS === "0") return;
  const report = readReport(worktreeRoot(startDir));
  if (!report) return;
  if (flags.json === true) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  const headline = formatHeadline(report);
  if (headline) process.stdout.write(headline + "\n");
}

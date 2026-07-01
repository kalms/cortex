import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { GraphStore } from "../graph/store.js";

export interface GateSetDeps {
  /** Source of governed paths — must return only active decisions' governed path target_refs. */
  decisionsLinks: { findGovernedPaths: () => string[] };
  store: GraphStore;
  project: string;
  fanoutThreshold: number;
}

/** Returns the absolute path where the gate-cache file lives for the given repo root. */
export function gateCachePath(repoPath: string): string {
  return join(repoPath, ".cortex", ".brief-gate-cache");
}

/**
 * Build the gate set: union of (a) governed paths from active decisions and
 * (b) high-fanout files whose inbound CALLS/IMPORTS fan-in >= fanoutThreshold.
 * Returned list is deduped.
 */
export function buildGateSet(deps: GateSetDeps): string[] {
  const governed = deps.decisionsLinks.findGovernedPaths();
  const rows = deps.store.queryRaw<{ file_path: string }>(
    `SELECT n.file_path AS file_path
       FROM edges e JOIN nodes n ON n.id = e.target_id AND n.project = e.project
      WHERE e.project = ? AND e.relation IN ('CALLS','IMPORTS') AND e.source_id != e.target_id
      GROUP BY n.file_path
     HAVING COUNT(DISTINCT e.source_id) >= ?`,
    [deps.project, deps.fanoutThreshold],
  );
  const highFanout = rows.map((r) => r.file_path).filter(Boolean);
  return Array.from(new Set([...governed, ...highFanout]));
}

/**
 * Write the gate-cache entries (one per line) to `<repoPath>/.cortex/.brief-gate-cache`.
 * Best-effort: swallows errors to avoid blocking an edit.
 */
export function writeGateCache(repoPath: string, entries: string[]): void {
  try {
    const p = gateCachePath(repoPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, entries.join("\n") + (entries.length ? "\n" : ""));
  } catch {
    /* best-effort */
  }
}

// scripts/frame-extraction/eval-edges.ts
import type Database from "better-sqlite3";
import type { ImportEdge } from "./types.js";

/** Read CALLS edges from a Cortex graph DB, join both endpoints to file
 *  paths, drop intra-file + null-path + cross-project, dedupe by sorted
 *  pair, return sorted by weight desc. */
export function collectCallsEdges(db: Database.Database, project: string): ImportEdge[] {
  const rows = db
    .prepare(
      `SELECT n1.file_path AS src, n2.file_path AS dst
       FROM edges e
       JOIN nodes n1 ON n1.id = e.source_id
       JOIN nodes n2 ON n2.id = e.target_id
       WHERE e.relation = 'CALLS'
         AND n1.project = ?
         AND n2.project = ?
         AND n1.file_path IS NOT NULL AND n1.file_path != ''
         AND n2.file_path IS NOT NULL AND n2.file_path != ''
         AND n1.file_path != n2.file_path`,
    )
    .all(project, project) as Array<{ src: string; dst: string }>;

  const counts = new Map<string, ImportEdge>();
  for (const row of rows) {
    const [a, b] = row.src < row.dst ? [row.src, row.dst] : [row.dst, row.src];
    const key = `${a}\t${b}`;
    const existing = counts.get(key);
    if (existing) existing.weight += 1;
    else counts.set(key, { a, b, weight: 1 });
  }
  return [...counts.values()].sort((x, y) => y.weight - x.weight);
}

import type { GraphStore } from "../graph/store.js";

/**
 * Direct inbound fan-in for `target`, deduped by source node.
 * - `file::member` qn → callers of that one node (excluding itself).
 * - bare file path     → callers into any node of the file, excluding same-file sources.
 */
export function blastRadius(store: GraphStore, project: string, target: string): number {
  if (target.includes("::")) {
    const rows = store.queryRaw<{ n: number }>(
      `SELECT COUNT(DISTINCT e.source_id) AS n
         FROM edges e
         JOIN nodes tn ON tn.id = e.target_id AND tn.project = e.project
        WHERE e.project = ? AND tn.qualified_name = ?
          AND e.relation IN ('CALLS','IMPORTS') AND e.source_id != e.target_id`,
      [project, target],
    );
    return rows[0]?.n ?? 0;
  }
  const rows = store.queryRaw<{ n: number }>(
    `WITH file_nodes AS (SELECT id FROM nodes WHERE project = ? AND file_path = ?)
     SELECT COUNT(DISTINCT e.source_id) AS n
       FROM edges e
      WHERE e.project = ?
        AND e.target_id IN (SELECT id FROM file_nodes)
        AND e.source_id NOT IN (SELECT id FROM file_nodes)
        AND e.relation IN ('CALLS','IMPORTS')`,
    [project, target, project],
  );
  return rows[0]?.n ?? 0;
}

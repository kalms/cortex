import { GraphStore } from "./store.js";

export interface CbmNode {
  id: number;
  project: string;
  label: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  properties: string;
}

export interface CbmEdge {
  id: number;
  project: string;
  source_id: number;
  target_id: number;
  type: string;
  properties: string;
}

export interface CbmProject {
  name: string;
  indexed_at: string;
  root_path: string;
}

export function searchGraph(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; label?: string; qn_pattern?: string }
): CbmNode[] {
  const conditions: string[] = ["project = ?"];
  const values: unknown[] = [project];

  if (params.name_pattern) {
    conditions.push("name LIKE ?");
    values.push(`%${params.name_pattern}%`);
  }
  if (params.label) {
    conditions.push("label = ?");
    values.push(params.label);
  }
  if (params.qn_pattern) {
    conditions.push("qualified_name LIKE ?");
    values.push(params.qn_pattern);
  }

  return store.queryRaw<CbmNode>(
    `SELECT * FROM cbm.nodes WHERE ${conditions.join(" AND ")} LIMIT 100`,
    values
  );
}

// 5I: getGraphSchema now returns counts alongside names
export function getGraphSchema(
  store: GraphStore,
  project: string
): { labels: Array<{ name: string; count: number }>; edgeTypes: Array<{ name: string; count: number }> } {
  const labels = store.queryRaw<{ name: string; count: number }>(
    "SELECT label AS name, COUNT(*) AS count FROM cbm.nodes WHERE project = ? GROUP BY label ORDER BY name",
    [project]
  );

  const edgeTypes = store.queryRaw<{ name: string; count: number }>(
    "SELECT type AS name, COUNT(*) AS count FROM cbm.edges WHERE project = ? GROUP BY type ORDER BY name",
    [project]
  );

  return { labels, edgeTypes };
}

// 5G: tracePath now returns {node, depth}[] and accepts optional max_depth
export function tracePath(
  store: GraphStore,
  project: string,
  params: { function_name: string; mode: string; max_depth?: number }
): Array<{ node: CbmNode; depth: number }> {
  const startNodes = store.queryRaw<CbmNode>(
    "SELECT * FROM cbm.nodes WHERE project = ? AND name = ? LIMIT 1",
    [project, params.function_name]
  );
  if (startNodes.length === 0) return [];

  const startId = startNodes[0].id;
  const direction = params.mode === "callers" ? "inbound" : "outbound";
  const maxDepth = params.max_depth ?? 3;

  const recursive =
    direction === "outbound"
      ? "SELECT e.target_id, t.depth + 1 FROM cbm.edges e JOIN trace t ON e.source_id = t.node_id"
      : "SELECT e.source_id, t.depth + 1 FROM cbm.edges e JOIN trace t ON e.target_id = t.node_id";

  const sql = `WITH RECURSIVE trace(node_id, depth) AS (
    SELECT ?, 0
    UNION ALL
    ${recursive}
    WHERE e.project = ? AND e.type IN ('CALLS', 'IMPORTS') AND t.depth < ?
  )
  SELECT n.*, MIN(t.depth) AS depth FROM cbm.nodes n
  JOIN trace t ON n.id = t.node_id
  WHERE n.id != ?
  GROUP BY n.id
  ORDER BY depth, n.name`;

  const rows = store.queryRaw<CbmNode & { depth: number }>(sql, [startId, project, maxDepth, startId]);
  return rows.map(({ depth, ...node }) => ({ node, depth: depth as number }));
}

export function listProjects(store: GraphStore): CbmProject[] {
  return store.queryRaw<CbmProject>("SELECT * FROM cbm.projects");
}

export function indexStatus(store: GraphStore, rootPath: string): CbmProject | null {
  const results = store.queryRaw<CbmProject>(
    "SELECT * FROM cbm.projects WHERE root_path = ?",
    [rootPath]
  );
  return results[0] ?? null;
}

import { GraphStore } from "./store.js";

/**
 * After Phase 4, code-entity rows live in `nodes` with `kind` as discriminator.
 * The TS-side type used by code-tools.ts and tests keeps the field name `kind`
 * (matching the storage column), `relation` for edges, `data` for the JSON blob.
 *
 * Type name `CbmNode` is preserved through Phase 4 for diff continuity; Phase 8
 * cleanup renames to `IndexerNode`.
 */
export interface CbmNode {
  id: string;
  project: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  data: string;
}

export interface CbmEdge {
  id: string;
  project: string;
  source_id: string;
  target_id: string;
  relation: string;
  data: string;
}

export interface CbmProject {
  name: string;
  indexed_at: string;
  root_path: string;
}

const CODE_KIND_FILTER = "kind NOT IN ('decision', 'pr', 'todo')";

export function searchGraph(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; label?: string; qn_pattern?: string }
): CbmNode[] {
  const conditions: string[] = ["project = ?", CODE_KIND_FILTER];
  const values: unknown[] = [project];

  if (params.name_pattern) {
    conditions.push("name LIKE ?");
    values.push(`%${params.name_pattern}%`);
  }
  if (params.label) {
    // The tool's input parameter is named `label` for backwards compatibility,
    // but the storage column is `kind`. Lowercase the value to match the
    // post-Phase-4 lowercase-kind convention.
    conditions.push("kind = ?");
    values.push(params.label.toLowerCase());
  }
  if (params.qn_pattern) {
    conditions.push("qualified_name LIKE ?");
    values.push(params.qn_pattern);
  }

  return store.queryRaw<CbmNode>(
    `SELECT * FROM nodes WHERE ${conditions.join(" AND ")} LIMIT 100`,
    values
  );
}

export function getGraphSchema(
  store: GraphStore,
  project: string
): { labels: Array<{ name: string; count: number }>; edgeTypes: Array<{ name: string; count: number }> } {
  const labels = store.queryRaw<{ name: string; count: number }>(
    `SELECT kind AS name, COUNT(*) AS count FROM nodes
     WHERE project = ? AND ${CODE_KIND_FILTER}
     GROUP BY kind ORDER BY name`,
    [project]
  );

  const edgeTypes = store.queryRaw<{ name: string; count: number }>(
    "SELECT relation AS name, COUNT(*) AS count FROM edges WHERE project = ? GROUP BY relation ORDER BY name",
    [project]
  );

  return { labels, edgeTypes };
}

export function tracePath(
  store: GraphStore,
  project: string,
  params: { function_name: string; mode: string; max_depth?: number }
): Array<{ node: CbmNode; depth: number }> {
  const startNodes = store.queryRaw<CbmNode>(
    `SELECT * FROM nodes WHERE project = ? AND name = ? AND ${CODE_KIND_FILTER} LIMIT 1`,
    [project, params.function_name]
  );
  if (startNodes.length === 0) return [];

  const startId = startNodes[0].id;
  const direction = params.mode === "callers" ? "inbound" : "outbound";
  const maxDepth = params.max_depth ?? 3;

  const recursive =
    direction === "outbound"
      ? "SELECT e.target_id, t.depth + 1 FROM edges e JOIN trace t ON e.source_id = t.node_id"
      : "SELECT e.source_id, t.depth + 1 FROM edges e JOIN trace t ON e.target_id = t.node_id";

  const sql = `WITH RECURSIVE trace(node_id, depth) AS (
    SELECT ?, 0
    UNION ALL
    ${recursive}
    WHERE e.project = ? AND e.relation IN ('CALLS', 'IMPORTS') AND t.depth < ?
  )
  SELECT n.*, MIN(t.depth) AS depth FROM nodes n
  JOIN trace t ON n.id = t.node_id
  WHERE n.id != ? AND n.project = ? AND ${CODE_KIND_FILTER}
  GROUP BY n.id
  ORDER BY depth, n.name`;

  const rows = store.queryRaw<CbmNode & { depth: number }>(sql, [
    startId, project, maxDepth, startId, project,
  ]);
  return rows.map(({ depth, ...node }) => ({ node, depth: depth as number }));
}

export function listProjects(store: GraphStore): CbmProject[] {
  return store.queryRaw<CbmProject>("SELECT * FROM ctx_projects");
}

export function indexStatus(store: GraphStore, rootPath: string): CbmProject | null {
  const results = store.queryRaw<CbmProject>(
    "SELECT * FROM ctx_projects WHERE root_path = ?",
    [rootPath]
  );
  return results[0] ?? null;
}

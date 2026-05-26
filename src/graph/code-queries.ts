import { GraphStore } from "./store.js";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * After Phase 4, code-entity rows live in `nodes` with `kind` as discriminator.
 * The TS-side type used by code-tools.ts and tests keeps the field name `kind`
 * (matching the storage column), `relation` for edges, `data` for the JSON blob.
 */
export interface IndexerNode {
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

export interface IndexerEdge {
  id: string;
  project: string;
  source_id: string;
  target_id: string;
  relation: string;
  data: string;
}

export interface IndexerProject {
  name: string;
  indexed_at: string;
  root_path: string;
}

const CODE_KIND_FILTER = "kind NOT IN ('decision', 'pr', 'todo')";

export function searchGraph(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; label?: string; qn_pattern?: string }
): IndexerNode[] {
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

  return store.queryRaw<IndexerNode>(
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
): Array<{ node: IndexerNode; depth: number }> {
  const startNodes = store.queryRaw<IndexerNode>(
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

  const rows = store.queryRaw<IndexerNode & { depth: number }>(sql, [
    startId, project, maxDepth, startId, project,
  ]);
  return rows.map(({ depth, ...node }) => ({ node, depth: depth as number }));
}

export function listProjects(store: GraphStore): IndexerProject[] {
  return store.queryRaw<IndexerProject>("SELECT * FROM ctx_projects");
}

/* Union of (a) the bound store's ctx_projects (Cortex-Vue's local .cortex/db)
 * and (b) every .db file in the standalone-indexer cache (~/.cache/cortex-indexer).
 * The bound store wins on name conflict so embedder-fresher data takes precedence.
 * Opens cache .db files briefly (read-only) to read their ctx_projects row;
 * suitable for low-volume endpoints (project switcher, list_projects tool). */
export function listProjectsUnified(store: GraphStore): IndexerProject[] {
  const out = new Map<string, IndexerProject>();

  try {
    for (const p of listProjects(store)) {
      out.set(p.name, p);
    }
  } catch (e) {
    if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
  }

  const cacheDir = join(homedir(), ".cache", "cortex-indexer");
  let entries: string[] = [];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return Array.from(out.values());
  }

  for (const name of entries) {
    if (!name.endsWith(".db") || name.startsWith("tmp-") || name.startsWith("_")) continue;
    const projectName = name.slice(0, -3);
    if (out.has(projectName)) continue;

    const dbPath = join(cacheDir, name);
    let cacheStore: GraphStore | null = null;
    try {
      cacheStore = new GraphStore(dbPath, { readonly: true });
      const rows = cacheStore.queryRaw<IndexerProject>(
        "SELECT name, indexed_at, root_path FROM ctx_projects WHERE name = ?",
        [projectName],
      );
      if (rows[0]) out.set(projectName, rows[0]);
    } catch {
      // Skip unreadable / empty / pre-migration cache DBs.
    } finally {
      cacheStore?.close();
    }
  }

  return Array.from(out.values());
}

/* Resolve which GraphStore to read from for a given project request.
 *
 * Returns:
 *  - { store: boundStore, owned: false }  when the request is for the bound
 *    project (or no project specified) — caller must NOT close.
 *  - { store: <fresh read-only>, owned: true }  when the request is for a
 *    cache-resident project — caller MUST close in `finally`.
 *  - null when the requested project isn't in the cache either.
 *
 * The /api/* HTTP endpoints use this to serve multi-project queries without
 * the Cortex-Vue server needing to be restarted per-project. */
export function openProjectStore(
  boundStore: GraphStore,
  boundProject: string | null | undefined,
  requestedProject: string | null | undefined,
): { store: GraphStore; owned: boolean } | null {
  if (!requestedProject || requestedProject === boundProject) {
    return { store: boundStore, owned: false };
  }
  const cachePath = join(homedir(), ".cache", "cortex-indexer", `${requestedProject}.db`);
  if (!existsSync(cachePath)) return null;
  try {
    const store = new GraphStore(cachePath, { readonly: true });
    return { store, owned: true };
  } catch {
    return null;
  }
}

export function indexStatus(store: GraphStore, rootPath: string): IndexerProject | null {
  const results = store.queryRaw<IndexerProject>(
    "SELECT * FROM ctx_projects WHERE root_path = ?",
    [rootPath]
  );
  return results[0] ?? null;
}

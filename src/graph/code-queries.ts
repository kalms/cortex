import { GraphStore } from "./store.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Registry } from "../db/registry.js";
import { resolveGraphDbForRead } from "../db/resolve-path.js";

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
  /** Canonical repo root when this row is a linked worktree; null/absent for
   *  a main checkout. Only populated for rows folded in from the registry
   *  (see `listProjectsUnified`); optional so the bound store's ctx_projects
   *  rows (which predate the two-axis model) keep compiling unchanged. */
  worktree_of?: string | null;
  /** Branch at index time; null/absent when detached, unknown, or the row
   *  predates branch tracking. */
  branch?: string | null;
}

const CODE_KIND_FILTER = "kind NOT IN ('decision', 'pr', 'todo')";
const MAX_SEARCH_ROWS = 1000;

export function searchGraph(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; label?: string; qn_pattern?: string; kinds?: string[] }
): IndexerNode[] {
  const conditions: string[] = ["project = ?"];
  const values: unknown[] = [project];

  // Effective kind filter: an explicit kinds list (incl. the legacy `label`
  // alias) replaces the default; otherwise default to code kinds with
  // sections excluded.
  const kinds = [
    ...new Set(
      [...(params.kinds ?? []), ...(params.label ? [params.label] : [])].map((k) => k.toLowerCase()),
    ),
  ];
  if (kinds.length > 0) {
    conditions.push(`kind IN (${kinds.map(() => "?").join(", ")})`);
    values.push(...kinds);
  } else {
    conditions.push(CODE_KIND_FILTER);
    conditions.push("kind != 'section'");
  }

  if (params.name_pattern) {
    conditions.push("name LIKE ?");
    values.push(`%${params.name_pattern}%`);
  }
  if (params.qn_pattern) {
    conditions.push("qualified_name LIKE ?");
    values.push(params.qn_pattern);
  }

  return store.queryRaw<IndexerNode>(
    `SELECT * FROM nodes WHERE ${conditions.join(" AND ")} LIMIT ${MAX_SEARCH_ROWS}`,
    values
  );
}

/** Count section nodes matching the name/qn pattern — i.e. how many results
 *  the default (no-kinds) filter suppressed. The search_graph handler skips
 *  this call (reports 0) when the caller opted sections in via `kinds`. */
export function countSuppressedSections(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; qn_pattern?: string }
): number {
  const conditions: string[] = ["project = ?", "kind = 'section'"];
  const values: unknown[] = [project];
  if (params.name_pattern) {
    conditions.push("name LIKE ?");
    values.push(`%${params.name_pattern}%`);
  }
  if (params.qn_pattern) {
    conditions.push("qualified_name LIKE ?");
    values.push(params.qn_pattern);
  }
  const row = store.queryRaw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM nodes WHERE ${conditions.join(" AND ")}`,
    values
  )[0];
  return row?.n ?? 0;
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
 * and (b) the master Registry (~/.local/share/cortex-indexer/registry.db), which
 * records every repo indexed via the CLI or another MCP session. The bound
 * store wins on name conflict so embedder-fresher data takes precedence.
 *
 * Name conflicts MERGE rather than skip. The registry is the only source of
 * `worktree_of`/`branch`, and the bound store's ctx_projects always lists the
 * served checkout — so dropping the conflicting registry row outright meant
 * the ACTIVE project could never carry checkout metadata, and the viewer's
 * "<name> @ <branch>" label could never render for the checkout being served.
 * Store-derived fields the registry lacks (root_path, indexed_at, node/edge
 * counts) are left untouched; only the registry-exclusive fields fill in. */
export function listProjectsUnified(store: GraphStore): IndexerProject[] {
  const out = new Map<string, IndexerProject>();

  try {
    for (const p of listProjects(store)) {
      out.set(p.name, p);
    }
  } catch (e) {
    if (!(e instanceof Error && /no such table/i.test(e.message))) throw e;
  }

  try {
    const registry = new Registry();
    try {
      for (const r of registry.list()) {
        // RegistryRepo is a structural subset of IndexerProject; carry
        // worktree_of/branch through so callers (list_projects grouping,
        // the viewer's checkout label) have something to key on. No
        // nodes/edges counts here by design.
        const existing = out.get(r.name);
        if (existing) {
          // Merge, don't skip — see the header comment. Spreading `existing`
          // last would re-clobber with its absent metadata, so the two
          // registry-exclusive fields are applied on top explicitly, and only
          // when the store row hasn't already supplied them.
          out.set(r.name, {
            ...existing,
            worktree_of: existing.worktree_of ?? r.worktree_of,
            branch: existing.branch ?? r.branch,
          });
          continue;
        }
        out.set(r.name, {
          name: r.name,
          indexed_at: r.indexed_at,
          root_path: r.root_path,
          worktree_of: r.worktree_of,
          branch: r.branch,
        });
      }
    } finally {
      registry.close();
    }
  } catch {
    // Registry unavailable — bound store entries only.
  }

  return Array.from(out.values());
}

/* Resolve which GraphStore to read from for a given project request.
 *
 * Returns:
 *  - { store: boundStore, owned: false }  when the request is for the bound
 *    project (or no project specified) — caller must NOT close.
 *  - { store: <fresh read-only>, owned: true }  when the request is for a
 *    registry-resolved (or legacy-cache-fallback) project — caller MUST close in `finally`.
 *  - null when the requested project isn't in the cache either.
 *
 * The /api/* HTTP endpoints use this to serve multi-project queries without
 * the Cortex-Vue server needing to be restarted per-project. */
export function openProjectStore(
  boundStore: GraphStore,
  boundProject: string | null | undefined,
  requestedProject: string | null | undefined,
  opts: { registry?: Registry } = {},
): { store: GraphStore; owned: boolean } | null {
  if (!requestedProject || requestedProject === boundProject) {
    return { store: boundStore, owned: false };
  }

  // Resolve the requested project's root_path from the registry, then open the
  // freshest store via resolveGraphDbForRead (prefers .cortex/db; cache is the
  // last-resort fallback for un-migrated repos). Falls back to the legacy cache
  // path only when the project is unknown to the registry.
  const registry = opts.registry ?? new Registry();
  let rootPath: string | null = null;
  try {
    rootPath = registry.findByName(requestedProject)?.root_path ?? null;
  } finally {
    if (!opts.registry) registry.close();
  }

  let dbPath: string | null = null;
  if (rootPath) {
    dbPath = resolveGraphDbForRead(rootPath);
  }
  if (!dbPath) {
    const legacy = join(homedir(), ".cache", "cortex-indexer", `${requestedProject}.db`);
    dbPath = existsSync(legacy) ? legacy : null;
  }
  if (!dbPath) return null;

  try {
    const store = new GraphStore(dbPath, { readonly: true });
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

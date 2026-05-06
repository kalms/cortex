import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { CREATE_TABLES, CREATE_INDEXES, CREATE_FTS } from "./schema.js";

export interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string | null;
  file_path: string | null;
  data: string;
  tier: string;
  created_at: string;
  updated_at: string;
}

export interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  relation: string;
  data: string;
  created_at: string;
}

export interface EdgeAnnotationRow {
  id: string;
  decision_id: string;
  edge_id: string;
  created_at: string;
}

export interface DecisionContent {
  description?: string;
  rationale?: string;
  problem?: string | null;
  resolution?: string | null;
}

export class GraphStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(CREATE_TABLES);
    this.migrateSchemaFold();
    this.db.exec(CREATE_INDEXES);
    this.migrateFts();
    this.db.exec(CREATE_FTS);
  }

  private migrateFts(): void {
    // Detect whether decisions_fts exists and lacks the new columns.
    const existing = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_fts'")
      .get() as { name?: string } | undefined;
    if (!existing?.name) return; // fresh DB — CREATE_FTS will build the new shape

    const cols = (this.db
      .prepare("PRAGMA table_info(decisions_fts)")
      .all() as Array<{ name: string }>)
      .map((r) => r.name);
    if (cols.includes("problem") && cols.includes("resolution")) return;

    // Drop and repopulate atomically.
    const repopulate = this.db.transaction(() => {
      this.db.exec("DROP TABLE decisions_fts;");
      this.db.exec(`
        CREATE VIRTUAL TABLE decisions_fts USING fts5(
          title, description, rationale, problem, resolution,
          node_id UNINDEXED
        );
      `);
      const rows = this.db
        .prepare("SELECT id, name, data FROM nodes WHERE kind = 'decision'")
        .all() as { id: string; name: string; data: string }[];
      const insert = this.db.prepare(
        "INSERT INTO decisions_fts (title, description, rationale, problem, resolution, node_id) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const row of rows) {
        const data = JSON.parse(row.data || "{}");
        insert.run(
          row.name ?? "",
          data.description ?? "",
          data.rationale ?? "",
          data.problem ?? "",
          data.resolution ?? "",
          row.id
        );
      }
    });
    repopulate();
  }

  /**
   * Phase 4 schema fold: cbm_nodes/cbm_edges → nodes/edges with kind discriminator.
   *
   * Two-part migration:
   *
   * Part A (always runs): Ensures nodes/edges have the Phase-4 columns
   * (start_line, end_line, project). Runs probe-based ALTER TABLE since
   * SQLite ALTER doesn't support IF NOT EXISTS.
   *
   * Part B (cbm_* fold, only when cbm_nodes exists): Copies cbm_nodes →
   * nodes and cbm_edges → edges, drops old data tables, renames bookkeeping
   * tables to ctx_*, rebuilds FTS5. Runs inside a single transaction with
   * FK enforcement off so cascade-deletes don't fire prematurely.
   */
  private migrateSchemaFold(): void {
    // Part A: always add missing columns so CREATE_INDEXES (which references
    // the `project` column) never fails on a legacy DB that lacks them.
    const nodeCols = (this.db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>)
      .map((r) => r.name);
    if (!nodeCols.includes("start_line")) this.db.exec("ALTER TABLE nodes ADD COLUMN start_line INTEGER");
    if (!nodeCols.includes("end_line"))   this.db.exec("ALTER TABLE nodes ADD COLUMN end_line INTEGER");
    if (!nodeCols.includes("project"))    this.db.exec("ALTER TABLE nodes ADD COLUMN project TEXT");

    const edgeCols = (this.db.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string }>)
      .map((r) => r.name);
    if (!edgeCols.includes("project")) this.db.exec("ALTER TABLE edges ADD COLUMN project TEXT");

    // Part B: cbm_* fold — only runs when cbm_nodes exists (idempotent probe).
    const cbmNodesExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cbm_nodes'")
      .get() as { name?: string } | undefined;
    if (!cbmNodesExists?.name) return; // already migrated, or fresh DB

    // FK off for the duration: we DROP cbm_nodes after copying, and we don't want
    // ON DELETE CASCADE to wipe cbm_edges before we've copied them.
    this.db.pragma("foreign_keys = OFF");

    try {
      const tx = this.db.transaction(() => {
        // 1. Copy cbm_edges → edges. Done before nodes (logical, not strictly
        // required since FK is off).
        this.db.exec(`
          INSERT INTO edges (id, source_id, target_id, relation, data, created_at, project)
          SELECT
            'ctx-e' || CAST(id AS TEXT),
            'ctx-' || CAST(source_id AS TEXT),
            'ctx-' || CAST(target_id AS TEXT),
            type,
            properties,
            (SELECT indexed_at FROM cbm_projects WHERE name = cbm_edges.project),
            project
          FROM cbm_edges
        `);

        // 2. Copy cbm_nodes → nodes.
        this.db.exec(`
          INSERT INTO nodes (
            id, kind, name, qualified_name, file_path, data, tier,
            created_at, updated_at, start_line, end_line, project
          )
          SELECT
            'ctx-' || CAST(id AS TEXT),
            LOWER(label),
            name, qualified_name, file_path,
            properties,
            'shared',
            (SELECT indexed_at FROM cbm_projects WHERE name = cbm_nodes.project),
            (SELECT indexed_at FROM cbm_projects WHERE name = cbm_nodes.project),
            start_line, end_line, project
          FROM cbm_nodes
        `);

        // 3. Sanity check: row counts must match. If not, the copy is incomplete —
        // roll back the transaction (don't DROP) so we don't lose data.
        const srcEdges = (this.db.prepare("SELECT COUNT(*) AS c FROM cbm_edges").get() as { c: number }).c;
        const dstEdges = (this.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE id LIKE 'ctx-e%'").get() as { c: number }).c;
        if (srcEdges !== dstEdges) {
          throw new Error(`schema fold: edge count mismatch ${srcEdges} → ${dstEdges}`);
        }
        const srcNodes = (this.db.prepare("SELECT COUNT(*) AS c FROM cbm_nodes").get() as { c: number }).c;
        const dstNodes = (this.db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%'").get() as { c: number }).c;
        if (srcNodes !== dstNodes) {
          throw new Error(`schema fold: node count mismatch ${srcNodes} → ${dstNodes}`);
        }

        // 5. Drop old data tables.
        this.db.exec("DROP TABLE cbm_edges");
        this.db.exec("DROP TABLE cbm_nodes");

        // 6. Rename bookkeeping tables.
        this.db.exec("ALTER TABLE cbm_projects RENAME TO ctx_projects");
        this.db.exec("ALTER TABLE cbm_file_hashes RENAME TO ctx_file_hashes");
        this.db.exec("ALTER TABLE cbm_project_summaries RENAME TO ctx_project_summaries");

        // 7. FTS5 rebuild — virtual tables can't be ALTER RENAME'd.
        this.db.exec("DROP TABLE IF EXISTS cbm_nodes_fts");
        this.db.exec(`
          CREATE VIRTUAL TABLE ctx_nodes_fts USING fts5(
            name, qualified_name, kind, file_path,
            content='',
            tokenize='unicode61 remove_diacritics 2'
          )
        `);
        this.db.exec(`
          INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path)
          SELECT rowid, name, qualified_name, kind, file_path
          FROM nodes WHERE id LIKE 'ctx-%'
        `);
      });
      tx();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
  }

  listTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  listIndexes(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  createNode(input: {
    kind: string;
    name: string;
    qualified_name?: string;
    file_path?: string;
    data?: Record<string, unknown>;
    tier?: string;
  }): NodeRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO nodes (id, kind, name, qualified_name, file_path, data, tier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.kind,
        input.name,
        input.qualified_name ?? null,
        input.file_path ?? null,
        JSON.stringify(input.data ?? {}),
        input.tier ?? "personal",
        now,
        now
      );
    return this.getNode(id)!;
  }

  getNode(id: string): NodeRow | undefined {
    return this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  }

  updateNode(
    id: string,
    updates: Partial<Pick<NodeRow, "kind" | "name" | "qualified_name" | "file_path" | "data" | "tier">>
  ): NodeRow {
    const node = this.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);

    const fields: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }

    const nowMs = Date.now();
    const existingMs = new Date(node.updated_at).getTime();
    const updatedAt = new Date(Math.max(nowMs, existingMs + 1)).toISOString();

    fields.push("updated_at = ?");
    values.push(updatedAt);
    values.push(id);

    this.db.prepare(`UPDATE nodes SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getNode(id)!;
  }

  deleteNode(id: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
  }

  findNodes(filter: {
    kind?: string;
    name?: string;
    qualified_name?: string;
    file_path?: string;
    tier?: string;
  }): NodeRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        values.push(value);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM nodes ${where}`).all(...values) as NodeRow[];
  }

  // --- Edge CRUD ---

  createEdge(input: {
    source_id: string;
    target_id: string;
    relation: string;
    data?: Record<string, unknown>;
  }): EdgeRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO edges (id, source_id, target_id, relation, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.source_id, input.target_id, input.relation, JSON.stringify(input.data ?? {}), now);
    return this.getEdge(id)!;
  }

  getEdge(id: string): EdgeRow | undefined {
    return this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow | undefined;
  }

  deleteEdge(id: string): void {
    this.db.prepare("DELETE FROM edges WHERE id = ?").run(id);
  }

  findEdges(filter: { source_id?: string; target_id?: string; relation?: string }): EdgeRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        values.push(value);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM edges ${where}`).all(...values) as EdgeRow[];
  }

  // --- Edge Annotations ---

  createAnnotation(input: { decision_id: string; edge_id: string }): EdgeAnnotationRow {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO edge_annotations (id, decision_id, edge_id, created_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, input.decision_id, input.edge_id, now);
    return this.db.prepare("SELECT * FROM edge_annotations WHERE id = ?").get(id) as EdgeAnnotationRow;
  }

  deleteAnnotation(id: string): void {
    this.db.prepare("DELETE FROM edge_annotations WHERE id = ?").run(id);
  }

  findAnnotations(filter: { decision_id?: string; edge_id?: string }): EdgeAnnotationRow[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        values.push(value);
      }
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM edge_annotations ${where}`).all(...values) as EdgeAnnotationRow[];
  }

  getAllNodes(): NodeRow[] {
    return this.db.prepare("SELECT * FROM nodes").all() as NodeRow[];
  }

  getAllEdges(): EdgeRow[] {
    return this.db.prepare("SELECT * FROM edges").all() as EdgeRow[];
  }

  // --- FTS ---

  indexDecisionContent(id: string, name: string, data: DecisionContent): void {
    this.db
      .prepare(
        "INSERT INTO decisions_fts (title, description, rationale, problem, resolution, node_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(
        name,
        data.description ?? "",
        data.rationale ?? "",
        data.problem ?? "",
        data.resolution ?? "",
        id
      );
  }

  updateDecisionContent(id: string, name: string, data: DecisionContent): void {
    this.removeDecisionContent(id);
    this.indexDecisionContent(id, name, data);
  }

  removeDecisionContent(nodeId: string): void {
    this.db.prepare("DELETE FROM decisions_fts WHERE node_id = ?").run(nodeId);
  }

  searchDecisionContent(query: string): Array<{ node_id: string; rank: number }> {
    return this.db
      .prepare(
        `SELECT node_id, rank
         FROM decisions_fts
         WHERE decisions_fts MATCH ?
         ORDER BY rank`
      )
      .all(query) as Array<{ node_id: string; rank: number }>;
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    const run = this.db.transaction(fn);
    return run();
  }

  queryRaw<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private static readonly CBM_LABEL_MAP: Record<string, string> = {
    function: "function",
    method: "function",
    class: "component",
    module: "component",
    interface: "component",
    file: "path",
    package: "path",
    folder: "path",
  };

  getAllNodesUnified(cbmProject?: string): NodeRow[] {
    const cortexNodes = this.getAllNodes();

    if (!cbmProject) return cortexNodes;

    const cbmNodes = this.db
      .prepare(
        `SELECT
          'cbm-' || CAST(id AS TEXT) AS id,
          LOWER(label) AS kind,
          name,
          qualified_name,
          file_path,
          properties AS data,
          'personal' AS tier,
          (SELECT indexed_at FROM cbm_projects WHERE name = ?) AS created_at,
          (SELECT indexed_at FROM cbm_projects WHERE name = ?) AS updated_at
        FROM cbm_nodes WHERE project = ?`
      )
      .all(cbmProject, cbmProject, cbmProject) as NodeRow[];

    // Apply label-to-kind mapping
    for (const node of cbmNodes) {
      const mapped = GraphStore.CBM_LABEL_MAP[node.kind];
      if (mapped) node.kind = mapped;
    }

    return [...cortexNodes, ...cbmNodes];
  }

  getAllEdgesUnified(cbmProject?: string): EdgeRow[] {
    const cortexEdges = this.getAllEdges();

    if (!cbmProject) return cortexEdges;

    const cbmEdges = this.db
      .prepare(
        `SELECT
          'cbm-' || CAST(id AS TEXT) AS id,
          'cbm-' || CAST(source_id AS TEXT) AS source_id,
          'cbm-' || CAST(target_id AS TEXT) AS target_id,
          type AS relation,
          properties AS data,
          (SELECT indexed_at FROM cbm_projects WHERE name = ?) AS created_at
        FROM cbm_edges WHERE project = ?`
      )
      .all(cbmProject, cbmProject) as EdgeRow[];

    return [...cortexEdges, ...cbmEdges];
  }
}

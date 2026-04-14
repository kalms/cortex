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

export class GraphStore {
  private db: Database.Database;
  private cbmAttached = false;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(CREATE_TABLES);
    this.db.exec(CREATE_INDEXES);
    this.db.exec(CREATE_FTS);
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

  indexDecisionContent(nodeId: string, title: string, description: string, rationale: string): void {
    this.db
      .prepare("INSERT INTO decisions_fts (node_id, title, description, rationale) VALUES (?, ?, ?, ?)")
      .run(nodeId, title, description, rationale);
  }

  updateDecisionContent(nodeId: string, title: string, description: string, rationale: string): void {
    this.removeDecisionContent(nodeId);
    this.indexDecisionContent(nodeId, title, description, rationale);
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

  isCbmAttached(): boolean {
    return this.cbmAttached;
  }

  attachCbm(dbPath: string): void {
    try {
      this.db.exec(`ATTACH DATABASE '${dbPath}' AS cbm`);
      // Verify it has the expected tables
      const tables = this.db
        .prepare("SELECT name FROM cbm.sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      if (tableNames.includes("nodes") && tableNames.includes("edges") && tableNames.includes("projects")) {
        this.cbmAttached = true;
      } else {
        this.db.exec("DETACH DATABASE cbm");
      }
    } catch {
      this.cbmAttached = false;
    }
  }
}

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

  close(): void {
    this.db.close();
  }
}

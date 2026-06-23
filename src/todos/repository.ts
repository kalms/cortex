import type Database from "better-sqlite3";
import { toFtsMatch } from "../decisions/repository.js";
import type { TodoRecord } from "./types.js";

const COLS =
  "id, seq, summary, description, state, state_reason, proposed_by, proposed_at, started_at, closed_at, assignee, created_at, updated_at";

export class TodosRepository {
  constructor(private db: Database.Database) {}
  // FTS sync is handled by todos_ai/au/ad triggers; write only the content table.

  insert(rec: TodoRecord): void {
    this.db.prepare(
      `INSERT INTO todos (${COLS}) VALUES
       (@id, @seq, @summary, @description, @state, @state_reason, @proposed_by,
        @proposed_at, @started_at, @closed_at, @assignee, @created_at, @updated_at)`,
    ).run(rec);
  }

  get(id: string): TodoRecord | null {
    return (this.db.prepare(`SELECT ${COLS} FROM todos WHERE id = ?`).get(id) as TodoRecord | undefined) ?? null;
  }

  getBySeq(seq: number): TodoRecord | null {
    return (this.db.prepare(`SELECT ${COLS} FROM todos WHERE seq = ?`).get(seq) as TodoRecord | undefined) ?? null;
  }

  update(id: string, patch: Partial<TodoRecord>): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db.prepare(`UPDATE todos SET ${setClause} WHERE id = @id`).run({ ...patch, id });
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
  }

  list(): TodoRecord[] {
    return this.db.prepare(`SELECT ${COLS} FROM todos ORDER BY created_at DESC`).all() as TodoRecord[];
  }

  search(query: string): TodoRecord[] {
    const match = toFtsMatch(query);
    if (!match) return [];
    return this.db.prepare(
      `SELECT ${COLS.split(", ").map((c) => "t." + c).join(", ")}
       FROM todos t JOIN todos_fts f ON f.rowid = t.rowid
       WHERE todos_fts MATCH ? ORDER BY rank`,
    ).all(match) as TodoRecord[];
  }
}

import type Database from "better-sqlite3";
import type { TodoLinkRelation } from "./types.js";

export interface TodoLink {
  todo_id: string;
  target_kind: string;   // file|qn|path|frame|decision|pr|todo
  target_ref: string;
  relation: TodoLinkRelation;
  created_at: string;
}

const COLS = "todo_id, target_kind, target_ref, relation, created_at";

export class TodoLinksRepository {
  constructor(private db: Database.Database) {}

  add(link: TodoLink): void {
    this.db.prepare(
      `INSERT INTO todo_links (${COLS})
       VALUES (@todo_id, @target_kind, @target_ref, @relation, @created_at)`,
    ).run(link);
  }

  remove(todoId: string, targetKind: string, targetRef: string, relation: TodoLinkRelation): boolean {
    return this.db.prepare(
      `DELETE FROM todo_links
       WHERE todo_id = ? AND target_kind = ? AND target_ref = ? AND relation = ?`,
    ).run(todoId, targetKind, targetRef, relation).changes > 0;
  }

  findByTodo(todoId: string): TodoLink[] {
    return this.db.prepare(`SELECT ${COLS} FROM todo_links WHERE todo_id = ?`).all(todoId) as TodoLink[];
  }

  /** Derived `blocks`: todos that name `todoId` as their BLOCKED_BY target. */
  findBlocking(todoId: string): TodoLink[] {
    return this.db.prepare(
      `SELECT ${COLS} FROM todo_links
       WHERE target_kind = 'todo' AND target_ref = ? AND relation = 'BLOCKED_BY'`,
    ).all(todoId) as TodoLink[];
  }
}

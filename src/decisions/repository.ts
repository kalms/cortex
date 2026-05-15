import type Database from "better-sqlite3";

export interface DecisionRecord {
  id: string;
  title: string;
  description: string | null;
  rationale: string | null;
  problem: string | null;
  resolution: string | null;
  alternatives: string | null; // JSON array as text
  tier: string;
  status: string;
  superseded_by: string | null;
  author: string | null;
  created_at: string;
  updated_at: string;
}

export type DecisionUpdate = Partial<
  Omit<DecisionRecord, "id" | "created_at">
>;

const SELECT_COLS =
  "id, title, description, rationale, problem, resolution, alternatives, tier, status, superseded_by, author, created_at, updated_at";

export class DecisionsRepository {
  constructor(private db: Database.Database) {}

  insert(rec: DecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO decisions (${SELECT_COLS}) VALUES
         (@id, @title, @description, @rationale, @problem, @resolution, @alternatives,
          @tier, @status, @superseded_by, @author, @created_at, @updated_at)`,
      )
      .run(rec);
  }

  update(id: string, patch: DecisionUpdate): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
    this.db
      .prepare(`UPDATE decisions SET ${setClause} WHERE id = @id`)
      .run({ ...patch, id });
  }

  delete(id: string): boolean {
    const info = this.db.prepare("DELETE FROM decisions WHERE id = ?").run(id);
    return info.changes > 0;
  }

  get(id: string): DecisionRecord | null {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLS} FROM decisions WHERE id = ?`)
      .get(id) as DecisionRecord | undefined;
    return row ?? null;
  }

  list(): DecisionRecord[] {
    return this.db
      .prepare(`SELECT ${SELECT_COLS} FROM decisions ORDER BY created_at DESC`)
      .all() as DecisionRecord[];
  }
}

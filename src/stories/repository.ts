import type Database from "better-sqlite3";
import type { StoryRecord, StoryStepRecord } from "./types.js";

const STORY_COLS = "id, seq, title, description, status, created_by, created_at, updated_at";
const STEP_COLS = "story_id, step_index, caption, refs, emphasis_edges, layout_hint";

export class StoriesRepository {
  constructor(private db: Database.Database) {}

  insert(rec: StoryRecord): void {
    this.db.prepare(
      `INSERT INTO stories (${STORY_COLS}) VALUES
       (@id, @seq, @title, @description, @status, @created_by, @created_at, @updated_at)`,
    ).run(rec);
  }

  get(id: string): StoryRecord | null {
    return (this.db.prepare(`SELECT ${STORY_COLS} FROM stories WHERE id = ?`).get(id) as StoryRecord | undefined) ?? null;
  }

  getBySeq(seq: number): StoryRecord | null {
    return (this.db.prepare(`SELECT ${STORY_COLS} FROM stories WHERE seq = ?`).get(seq) as StoryRecord | undefined) ?? null;
  }

  list(): StoryRecord[] {
    return this.db.prepare(`SELECT ${STORY_COLS} FROM stories ORDER BY created_at DESC, seq DESC`).all() as StoryRecord[];
  }

  setStatus(id: string, status: string, updatedAt: string): void {
    this.db.prepare("UPDATE stories SET status = @status, updated_at = @updated_at WHERE id = @id").run({
      id,
      status,
      updated_at: updatedAt,
    });
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM stories WHERE id = ?").run(id).changes > 0;
  }

  /** story_id → COUNT(*), one GROUP BY query. */
  stepCounts(): Map<string, number> {
    const rows = this.db.prepare(
      "SELECT story_id, COUNT(*) AS n FROM story_steps GROUP BY story_id",
    ).all() as Array<{ story_id: string; n: number }>;
    return new Map(rows.map((r) => [r.story_id, r.n]));
  }
}

export class StoryStepsRepository {
  constructor(private db: Database.Database) {}

  insertAll(steps: StoryStepRecord[]): void {
    const insert = this.db.prepare(
      `INSERT INTO story_steps (${STEP_COLS}) VALUES
       (@story_id, @step_index, @caption, @refs, @emphasis_edges, @layout_hint)`,
    );
    const insertMany = this.db.transaction((rows: StoryStepRecord[]) => {
      for (const row of rows) insert.run(row);
    });
    insertMany(steps);
  }

  listByStory(storyId: string): StoryStepRecord[] {
    return this.db.prepare(
      `SELECT ${STEP_COLS} FROM story_steps WHERE story_id = ? ORDER BY step_index`,
    ).all(storyId) as StoryStepRecord[];
  }

  countByStory(storyId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS n FROM story_steps WHERE story_id = ?",
    ).get(storyId) as { n: number };
    return row.n;
  }
}

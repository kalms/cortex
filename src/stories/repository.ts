import type Database from "better-sqlite3";
import type { StoryRecord, StoryStepRecord } from "./types.js";
import type { OriginFields } from "../git/origin.js";

const STORY_COLS = "id, seq, title, description, status, created_by, created_at, updated_at";
const STEP_COLS = "story_id, step_index, caption, refs, emphasis_edges, layout_hint";

/** Git-identity columns — projected by every read, never by the INSERT column
 *  list (which spells them out separately). Mirrors `PROVENANCE_COLS` in
 *  ../decisions/repository.ts and ../todos/repository.ts. Stories carry
 *  origin + last-touched only: no `basis_hash` (a story governs nothing) and
 *  no `reconciled_*` (stories are never reconciled). */
const PROVENANCE_COLS =
  "origin_branch, origin_commit, origin_thread, " +
  "last_touched_branch, last_touched_commit, last_touched_thread";

const READ_COLS = `${STORY_COLS}, ${PROVENANCE_COLS}`;

export class StoriesRepository {
  constructor(private db: Database.Database) {}

  insert(rec: StoryRecord): void {
    this.db.prepare(
      `INSERT INTO stories (
         ${STORY_COLS},
         origin_branch, origin_commit, origin_thread,
         last_touched_branch, last_touched_commit, last_touched_thread
       ) VALUES (
         @id, @seq, @title, @description, @status, @created_by, @created_at, @updated_at,
         @origin_branch, @origin_commit, @origin_thread,
         @last_touched_branch, @last_touched_commit, @last_touched_thread
       )`,
    ).run({
      ...rec,
      origin_branch: rec.origin_branch ?? null,
      origin_commit: rec.origin_commit ?? null,
      origin_thread: rec.origin_thread ?? null,
      last_touched_branch: rec.last_touched_branch ?? null,
      last_touched_commit: rec.last_touched_commit ?? null,
      last_touched_thread: rec.last_touched_thread ?? null,
    });
  }

  get(id: string): StoryRecord | null {
    return (this.db.prepare(`SELECT ${READ_COLS} FROM stories WHERE id = ?`).get(id) as StoryRecord | undefined) ?? null;
  }

  getBySeq(seq: number): StoryRecord | null {
    return (this.db.prepare(`SELECT ${READ_COLS} FROM stories WHERE seq = ?`).get(seq) as StoryRecord | undefined) ?? null;
  }

  list(): StoryRecord[] {
    return this.db.prepare(`SELECT ${READ_COLS} FROM stories ORDER BY created_at DESC, seq DESC`).all() as StoryRecord[];
  }

  /** Closing a story is a mutation like any other — last_touched_* rewrites
   *  from the checkout `origin` was captured on; origin_* is never touched. */
  setStatus(id: string, status: string, updatedAt: string, origin?: OriginFields | null): void {
    this.db.prepare(
      `UPDATE stories SET
         status = @status, updated_at = @updated_at,
         last_touched_branch = @last_touched_branch,
         last_touched_commit = @last_touched_commit,
         last_touched_thread = @last_touched_thread
       WHERE id = @id`,
    ).run({
      id,
      status,
      updated_at: updatedAt,
      last_touched_branch: origin?.branch ?? null,
      last_touched_commit: origin?.commit ?? null,
      last_touched_thread: origin?.thread ?? null,
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

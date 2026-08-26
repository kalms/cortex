import type Database from "better-sqlite3";
import { toFtsMatch } from "../decisions/repository.js";
import type { TodoRecord } from "./types.js";

// origin_* is stamped once at create and is immutable thereafter — excluded
// here (mirrors DecisionUpdate in ../decisions/repository.ts) so a spread of
// a full TodoRecord can never silently rewrite it. last_touched_* is
// deliberately NOT excluded: rewriting it on every mutation is the point.
export type TodoRecordUpdate = Partial<
  Omit<TodoRecord, "id" | "seq" | "created_at" | "origin_branch" | "origin_commit" | "origin_thread">
>;

/** Runtime backstop for the same write-once set `TodoRecordUpdate` excludes
 *  at compile time — mirrors `WRITE_ONCE_KEYS` in ../decisions/repository.ts.
 *  The TS exclusion is walkable with `as never`, so it cannot be the actual
 *  enforcement of "origin is immutable after create"; this allow-list is.
 *  `update()` silently drops any of these keys rather than throwing. */
const WRITE_ONCE_KEYS = new Set<string>([
  "id", "seq", "created_at", "origin_branch", "origin_commit", "origin_thread",
]);

const COLS =
  "id, seq, summary, description, state, state_reason, proposed_by, proposed_at, started_at, closed_at, assignee, created_at, updated_at";

/** Git-identity columns — projected by every read, never by the INSERT column
 *  list (which spells them out separately). Mirrors `PROVENANCE_COLS` in
 *  ../decisions/repository.ts: a read that omits them makes a stamped row
 *  indistinguishable from an unstamped one. No `reconciled_*` — todos are
 *  never reconciled. */
const PROVENANCE_COLS =
  "origin_branch, origin_commit, origin_thread, " +
  "last_touched_branch, last_touched_commit, last_touched_thread, basis_hash";

const READ_COLS = `${COLS}, ${PROVENANCE_COLS}`;

export class TodosRepository {
  constructor(private db: Database.Database) {}
  // FTS sync is handled by todos_ai/au/ad triggers; write only the content table.

  insert(rec: TodoRecord): void {
    this.db.prepare(
      `INSERT INTO todos (
         ${COLS},
         origin_branch, origin_commit, origin_thread,
         last_touched_branch, last_touched_commit, last_touched_thread,
         basis_hash
       ) VALUES (
         @id, @seq, @summary, @description, @state, @state_reason, @proposed_by,
         @proposed_at, @started_at, @closed_at, @assignee, @created_at, @updated_at,
         @origin_branch, @origin_commit, @origin_thread,
         @last_touched_branch, @last_touched_commit, @last_touched_thread,
         @basis_hash
       )`,
    ).run({
      ...rec,
      origin_branch: rec.origin_branch ?? null,
      origin_commit: rec.origin_commit ?? null,
      origin_thread: rec.origin_thread ?? null,
      last_touched_branch: rec.last_touched_branch ?? null,
      last_touched_commit: rec.last_touched_commit ?? null,
      last_touched_thread: rec.last_touched_thread ?? null,
      basis_hash: rec.basis_hash ?? null,
    });
  }

  get(id: string): TodoRecord | null {
    return (this.db.prepare(`SELECT ${READ_COLS} FROM todos WHERE id = ?`).get(id) as TodoRecord | undefined) ?? null;
  }

  getBySeq(seq: number): TodoRecord | null {
    return (this.db.prepare(`SELECT ${READ_COLS} FROM todos WHERE seq = ?`).get(seq) as TodoRecord | undefined) ?? null;
  }

  update(id: string, patch: TodoRecordUpdate): void {
    const keys = Object.keys(patch).filter((k) => !WRITE_ONCE_KEYS.has(k));
    if (keys.length === 0) return;
    const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
    const params: Record<string, unknown> = { id };
    for (const k of keys) params[k] = (patch as Record<string, unknown>)[k];
    this.db.prepare(`UPDATE todos SET ${setClause} WHERE id = @id`).run(params);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM todos WHERE id = ?").run(id).changes > 0;
  }

  /** `filter.branch`/`filter.thread` narrow to an exact `origin_branch` /
   *  `origin_thread` match; omitted entirely, `list()` is unchanged from
   *  before provenance filtering existed. `origin_branch = @branch` is
   *  already NULL-safe in SQL — `NULL = 'x'` evaluates to NULL, not true —
   *  so a row with no recorded origin is excluded whenever a filter is
   *  present, never "on" any branch/thread. Do not rewrite this as
   *  `IS NOT DISTINCT FROM`: that would make NULL rows match an absent
   *  filter value, which is exactly the behavior this comment forbids. */
  list(filter?: { branch?: string; thread?: string }): TodoRecord[] {
    return this.db
      .prepare(
        `SELECT ${READ_COLS} FROM todos
         WHERE (@branch IS NULL OR origin_branch = @branch)
           AND (@thread IS NULL OR origin_thread = @thread)
         ORDER BY created_at DESC`,
      )
      .all({ branch: filter?.branch ?? null, thread: filter?.thread ?? null }) as TodoRecord[];
  }

  search(query: string): TodoRecord[] {
    const match = toFtsMatch(query);
    if (!match) return [];
    return this.db.prepare(
      `SELECT ${READ_COLS.split(", ").map((c) => "t." + c).join(", ")}
       FROM todos t JOIN todos_fts f ON f.rowid = t.rowid
       WHERE todos_fts MATCH ? ORDER BY rank`,
    ).all(match) as TodoRecord[];
  }
}

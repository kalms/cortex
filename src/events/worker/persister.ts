import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Event } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(__dirname, 'schema.sql');

/**
 * Opens/creates `events.db` and exposes insert + backfill + meta operations.
 *
 * Two instances exist in a running process:
 *   - Writer: owned by the worker thread. Only caller of `insert()` /
 *     `setMeta()`.
 *   - Reader: owned by the main thread for WS backfill queries. Only calls
 *     `backfill()` / `getMeta()`. Read-only use is safe under SQLite WAL
 *     with concurrent writers.
 *
 * The split keeps the WS server responsive to backfill requests without
 * blocking on the worker, and avoids serializing every backfill through a
 * MessagePort round-trip.
 *
 * Uses WAL mode so concurrent readers don't block the single writer.
 */
export class EventPersister {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private backfillNewestStmt: Database.Statement;
  private backfillBeforeStmt: Database.Statement;
  private setMetaStmt: Database.Statement;
  private getMetaStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf-8'));

    this.insertStmt = this.db.prepare(
      `INSERT INTO events (id, kind, actor, created_at, project_id, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.backfillNewestStmt = this.db.prepare(
      `SELECT id, kind, actor, created_at, project_id, payload
       FROM events ORDER BY id DESC LIMIT ?`,
    );
    this.backfillBeforeStmt = this.db.prepare(
      `SELECT id, kind, actor, created_at, project_id, payload
       FROM events WHERE id < ? ORDER BY id DESC LIMIT ?`,
    );
    this.setMetaStmt = this.db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    this.getMetaStmt = this.db.prepare(`SELECT value FROM meta WHERE key = ?`);
  }

  /** Inserts one event. Idempotent by ULID primary key: re-inserting an existing id throws. */
  insert(event: Event): void {
    this.insertStmt.run(
      event.id,
      event.kind,
      event.actor,
      event.created_at,
      event.project_id,
      JSON.stringify(event.payload),
    );
  }

  /**
   * Returns a page of events, newest first.
   *
   * `has_more` is computed by asking for one extra row; if it comes back,
   * we drop it and flag has_more = true.
   */
  backfill(opts: { before_id?: string; limit?: number }): {
    events: Event[];
    has_more: boolean;
  } {
    const limit = opts.limit ?? 50;
    const rows = opts.before_id
      ? (this.backfillBeforeStmt.all(opts.before_id, limit + 1) as RowShape[])
      : (this.backfillNewestStmt.all(limit + 1) as RowShape[]);
    const has_more = rows.length > limit;
    return {
      events: rows.slice(0, limit).map(rowToEvent),
      has_more,
    };
  }

  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  close(): void {
    this.db.close();
  }
}

interface RowShape {
  id: string;
  kind: string;
  actor: string;
  created_at: number;
  project_id: string;
  payload: string;
}

function rowToEvent(row: RowShape): Event {
  return {
    id: row.id,
    kind: row.kind,
    actor: row.actor,
    created_at: row.created_at,
    project_id: row.project_id,
    payload: JSON.parse(row.payload),
  } as Event;
}

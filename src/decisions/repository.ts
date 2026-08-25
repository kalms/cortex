import type Database from "better-sqlite3";

export interface DecisionRecord {
  id: string;
  seq: number;
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
  // JSON string holding a ProvenanceMeta. Optional only so pre-Task-2 inline
  // literals typecheck; DB rows always carry the column. Use null (not
  // omission) when constructing a record synthetically.
  provenance?: string | null;
  created_at: string;
  updated_at: string;
  // Reconciliation (code-alignment) — derived, cached. Null until first judged.
  reconciliation_verdict?: string | null;
  reconciled_at?: string | null;
  reconciled_source_hash?: string | null;
  reconciled_by?: string | null;
  nonconformant_nodes?: string | null; // JSON array of { ref, note }
  reconciliation_note?: string | null;
  // Git identity columns (authored-content provenance). Origin is stamped
  // once at create and never rewritten; last-touched is rewritten by every
  // mutating path. All optional so pre-existing inline literals typecheck —
  // DB rows always carry the columns (NULL until stamped).
  origin_branch?: string | null;
  origin_commit?: string | null;
  origin_thread?: string | null;
  last_touched_branch?: string | null;
  last_touched_commit?: string | null;
  last_touched_thread?: string | null;
  basis_hash?: string | null;
  // Reconciliation identity — the checkout the verdict was recorded from.
  // Written only by recordReconciliation(); same write-once-per-verdict
  // shape as the reconciliation columns above.
  reconciled_branch?: string | null;
  reconciled_commit?: string | null;
}

// provenance is machine-derived and write-once: excluded from updates so it
// cannot be silently overwritten by a spread of a full DecisionRecord. seq is
// assigned once at mint time and is likewise never patched. origin_* is
// stamped once at create and is immutable thereafter (same rationale as
// provenance) — excluded here so a spread of a full DecisionRecord can never
// silently rewrite it; last_touched_* is deliberately NOT excluded, since
// rewriting last_touched_* on every mutation is the entire point of this type.
export type DecisionUpdate = Partial<
  Omit<DecisionRecord, "id" | "seq" | "created_at" | "provenance" | "origin_branch" | "origin_commit" | "origin_thread">
>;

const SELECT_COLS =
  "id, seq, title, description, rationale, problem, resolution, alternatives, tier, status, superseded_by, author, provenance, created_at, updated_at";

const RECON_COLS =
  "reconciliation_verdict, reconciled_at, reconciled_source_hash, reconciled_by, nonconformant_nodes, reconciliation_note";
const READ_COLS = `${SELECT_COLS}, ${RECON_COLS}`;

/**
 * Turn a free-text user query into a safe FTS5 MATCH expression.
 *
 * Raw user text cannot go straight into `MATCH ?`: FTS5 interprets `-`, `:`,
 * `"`, `*`, `(`, `^`, and bareword `AND`/`OR`/`NOT`/`NEAR` as query operators,
 * so an ordinary query like `in-place` throws `no such column: place` (the
 * hyphen + colon parsing). Each whitespace-separated term is wrapped as a
 * double-quoted phrase (internal quotes doubled), which makes every term a
 * literal and neutralizes the operators while preserving implicit-AND keyword
 * search. Returns "" for an empty/blank query (caller short-circuits to []).
 */
export function toFtsMatch(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

export interface ReconciliationFields {
  reconciliation_verdict: string;
  reconciled_at: string;
  reconciled_source_hash: string;
  reconciled_by: string;
  nonconformant_nodes: string | null;
  reconciliation_note: string | null;
  // Git identity of the checkout the verdict was recorded from. Optional so
  // pre-existing callers (tests that predate this task) keep typechecking;
  // recordReconciliation() defaults every one to null when omitted.
  reconciled_branch?: string | null;
  reconciled_commit?: string | null;
  last_touched_branch?: string | null;
  last_touched_commit?: string | null;
  last_touched_thread?: string | null;
}

export class DecisionsRepository {
  constructor(private db: Database.Database) {}

  // FTS sync is handled by the decisions_ai/au/ad triggers defined in
  // src/decisions/db.ts. Repository methods write only to the content table.

  insert(rec: DecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO decisions (
           ${SELECT_COLS},
           origin_branch, origin_commit, origin_thread,
           last_touched_branch, last_touched_commit, last_touched_thread,
           basis_hash
         ) VALUES (
           @id, @seq, @title, @description, @rationale, @problem, @resolution, @alternatives,
           @tier, @status, @superseded_by, @author, @provenance, @created_at, @updated_at,
           @origin_branch, @origin_commit, @origin_thread,
           @last_touched_branch, @last_touched_commit, @last_touched_thread,
           @basis_hash
         )`,
      )
      .run({
        ...rec,
        seq: rec.seq ?? null,
        provenance: rec.provenance ?? null,
        origin_branch: rec.origin_branch ?? null,
        origin_commit: rec.origin_commit ?? null,
        origin_thread: rec.origin_thread ?? null,
        last_touched_branch: rec.last_touched_branch ?? null,
        last_touched_commit: rec.last_touched_commit ?? null,
        last_touched_thread: rec.last_touched_thread ?? null,
        basis_hash: rec.basis_hash ?? null,
      });
  }

  getBySeq(seq: number): DecisionRecord | null {
    const row = this.db
      .prepare(`SELECT ${READ_COLS} FROM decisions WHERE seq = ?`)
      .get(seq) as DecisionRecord | undefined;
    return row ?? null;
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
      .prepare(`SELECT ${READ_COLS} FROM decisions WHERE id = ?`)
      .get(id) as DecisionRecord | undefined;
    return row ?? null;
  }

  list(): DecisionRecord[] {
    return this.db
      .prepare(`SELECT ${READ_COLS} FROM decisions ORDER BY created_at DESC`)
      .all() as DecisionRecord[];
  }

  search(query: string): DecisionRecord[] {
    const match = toFtsMatch(query);
    if (!match) return [];
    return this.db
      .prepare(
        `SELECT ${READ_COLS.split(", ").map((c) => "d." + c).join(", ")}
         FROM decisions d
         JOIN decisions_fts f ON f.rowid = d.rowid
         WHERE decisions_fts MATCH ?
         ORDER BY rank`,
      )
      .all(match) as DecisionRecord[];
  }

  /** Stamp the latest reconciliation verdict. The caller (record_reconciliation
   *  tool) is responsible for computing reconciled_source_hash against the
   *  current working tree, so the verdict is always bound to real source.
   *  Also stamps reconciled_branch/reconciled_commit (the checkout the
   *  verdict was recorded from) and last_touched_* (recording a verdict is a
   *  mutation of the decision row like any other). */
  recordReconciliation(id: string, f: ReconciliationFields): void {
    this.db
      .prepare(
        `UPDATE decisions SET
           reconciliation_verdict = @reconciliation_verdict,
           reconciled_at          = @reconciled_at,
           reconciled_source_hash = @reconciled_source_hash,
           reconciled_by          = @reconciled_by,
           nonconformant_nodes    = @nonconformant_nodes,
           reconciliation_note    = @reconciliation_note,
           reconciled_branch      = @reconciled_branch,
           reconciled_commit      = @reconciled_commit,
           last_touched_branch    = @last_touched_branch,
           last_touched_commit    = @last_touched_commit,
           last_touched_thread    = @last_touched_thread
         WHERE id = @id`,
      )
      .run({
        ...f,
        id,
        reconciled_branch: f.reconciled_branch ?? null,
        reconciled_commit: f.reconciled_commit ?? null,
        last_touched_branch: f.last_touched_branch ?? null,
        last_touched_commit: f.last_touched_commit ?? null,
        last_touched_thread: f.last_touched_thread ?? null,
      });
  }
}

import type Database from "better-sqlite3";

export type TargetKind = "qn" | "path" | "decision" | "pr";

export type Relation =
  | "GOVERNS"
  | "REFERENCES"
  | "SUPERSEDES"
  | "DECISION_RELATED_TO"
  | "DECISION_DEPENDS_ON"
  | "PR_INTRODUCES_DECISION"
  | "PR_IMPLEMENTS_DECISION"
  | "PR_CHALLENGES_DECISION"
  | "PR_DISCUSSES_DECISION";

export interface DecisionLink {
  decision_id: string;
  target_kind: TargetKind;
  target_ref: string;
  relation: Relation;
  created_at: string;
}

const COLS = "decision_id, target_kind, target_ref, relation, created_at";

export class DecisionLinksRepository {
  constructor(private db: Database.Database) {}

  add(link: DecisionLink): void {
    this.db
      .prepare(
        `INSERT INTO decision_links (${COLS})
         VALUES (@decision_id, @target_kind, @target_ref, @relation, @created_at)`,
      )
      .run(link);
  }

  remove(
    decisionId: string,
    targetKind: TargetKind,
    targetRef: string,
    relation: Relation,
  ): boolean {
    const info = this.db
      .prepare(
        `DELETE FROM decision_links
         WHERE decision_id = ? AND target_kind = ? AND target_ref = ? AND relation = ?`,
      )
      .run(decisionId, targetKind, targetRef, relation);
    return info.changes > 0;
  }

  findByDecision(decisionId: string): DecisionLink[] {
    return this.db
      .prepare(`SELECT ${COLS} FROM decision_links WHERE decision_id = ?`)
      .all(decisionId) as DecisionLink[];
  }

  findByTarget(
    targetKind: TargetKind,
    targetRef: string,
    relation?: Relation,
  ): DecisionLink[] {
    if (relation) {
      return this.db
        .prepare(
          `SELECT ${COLS} FROM decision_links
           WHERE target_kind = ? AND target_ref = ? AND relation = ?`,
        )
        .all(targetKind, targetRef, relation) as DecisionLink[];
    }
    return this.db
      .prepare(
        `SELECT ${COLS} FROM decision_links WHERE target_kind = ? AND target_ref = ?`,
      )
      .all(targetKind, targetRef) as DecisionLink[];
  }
}

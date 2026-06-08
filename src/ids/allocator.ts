import type Database from "better-sqlite3";
import { EntityType, randomToken, formatCanonical } from "./short-id.js";

export interface MintedId {
  id: string;   // canonical, e.g. "D-9m2x"
  seq: number;  // per-repo per-type, e.g. 12
}

/**
 * Allocate (and persist) the next per-type seq, bumping id_sequences. Caller
 * must be inside a transaction if atomicity with other writes matters.
 */
export function allocateSeq(db: Database.Database, type: EntityType): number {
  const row = db
    .prepare("SELECT next_val FROM id_sequences WHERE entity_type = ?")
    .get(type) as { next_val: number } | undefined;
  const seq = row?.next_val ?? 1;
  db.prepare(
    `INSERT INTO id_sequences (entity_type, next_val) VALUES (?, ?)
     ON CONFLICT(entity_type) DO UPDATE SET next_val = ?`,
  ).run(type, seq + 1, seq + 1);
  return seq;
}

/**
 * Allocate a fresh seq (bumping id_sequences) and a collision-free canonical
 * id, in one transaction. `idExists` is the per-entity uniqueness check
 * (e.g. decisions.get(id) != null). `draw` and `maxTries` are injectable for
 * tests; production callers use the defaults.
 */
export function mintId(
  db: Database.Database,
  type: EntityType,
  idExists: (id: string) => boolean,
  draw?: () => string,
  maxTries = 10000,
): MintedId {
  return db.transaction((): MintedId => {
    const seq = allocateSeq(db, type);

    for (let i = 0; i < maxTries; i++) {
      const id = formatCanonical(type, randomToken(draw));
      if (!idExists(id)) return { id, seq };
    }
    throw new Error(`mintId: could not find a free ${type} id after ${maxTries} tries`);
  })();
}

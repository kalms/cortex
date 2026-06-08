# Short, readable primitive IDs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace decision UUID primary keys with short, typed, readable IDs (`D-9m2x` canonical + `D-12` display), and establish a shared minting/resolution module so TODOs (`T-`) and PRs (`PR-`) follow the same scheme.

**Architecture:** A pure `src/ids/` module owns the ID grammar (Crockford-base32 token, prefix map, seq-vs-canonical disambiguation). A DB-aware `mintId` allocator hands out a collision-free canonical id plus a per-repo `seq` in one transaction against a new `id_sequences` table. The decisions layer mints on create/propose, resolves either form on read, and a one-shot hard-cutover migration rewrites existing UUID rows and every internal reference. The viewer renders `D-<seq>`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3, Vitest, vanilla-JS canvas viewer.

**Spec:** [docs/superpowers/specs/2026-06-08-short-primitive-ids-design.md](../specs/2026-06-08-short-primitive-ids-design.md)

---

## File Structure

- **Create** `src/ids/short-id.ts` — pure ID grammar: alphabet, prefix map, `randomToken`, `parseRef`, `formatDisplay`, `formatCanonical`. No DB, no I/O.
- **Create** `src/ids/allocator.ts` — `mintId(db, type, idExists)`: transactional seq allocation + collision-free canonical token. Reusable by decisions now, TODOs later.
- **Create** `tests/ids/short-id.test.ts` and `tests/ids/allocator.test.ts`.
- **Modify** `src/decisions/db.ts` — add `id_sequences` table to `BASE_SCHEMA`; additively add `seq` column.
- **Modify** `src/decisions/repository.ts` — add `seq` to `DecisionRecord`, `SELECT_COLS`, `insert`; add `getBySeq(type, seq)`.
- **Modify** `src/decisions/types.ts` — add `seq` to the `Decision` interface; map it in `nodeToDecision`.
- **Modify** `src/decisions/service.ts` — mint instead of `randomUUID()` in `create`/`propose`; resolve either ref form in `get`/`update`/`delete`/`supersede`; map `seq` in `toDecision`.
- **Modify** `src/decisions/search.ts`, `src/decisions/promotion.ts` — map `seq` in their `toDecision`.
- **Create** `src/decisions/id-migration.ts` — `migrateDecisionIdsToShortForm(db)`: hard cutover + 4-site remap, idempotent.
- **Modify** `src/mcp-server/repo-context.ts:280-281` and `src/index.ts:159` — call the id migration right after `openDecisionsDb`.
- **Create** `tests/decisions/id-migration.test.ts`, and extend an existing decisions service test for ref resolution.
- **Modify** `src/viewer/viewer.js` — render `D-<seq>` from the API-served `seq`.

---

## Task 1: Pure ID grammar module

**Files:**
- Create: `src/ids/short-id.ts`
- Test: `tests/ids/short-id.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ids/short-id.test.ts
import { describe, it, expect } from "vitest";
import {
  PREFIX,
  randomToken,
  formatCanonical,
  formatDisplay,
  parseRef,
} from "../../src/ids/short-id.js";

describe("short-id grammar", () => {
  it("formats canonical and display ids with the type prefix", () => {
    expect(formatCanonical("decision", "9m2x")).toBe("D-9m2x");
    expect(formatDisplay("decision", 12)).toBe("D-12");
    expect(formatDisplay("todo", 42)).toBe("T-42");
    expect(PREFIX.decision).toBe("D");
  });

  it("randomToken is 4 chars from the Crockford alphabet with >=1 letter", () => {
    const seen = new Set<string>();
    // Deterministic sequence: force an all-digit draw first, then letters.
    const draws = ["1234", "0000", "9m2x"];
    let i = 0;
    const rng = () => draws[Math.min(i++, draws.length - 1)];
    const tok = randomToken(rng);
    // "1234" and "0000" are all-digit -> rejected; "9m2x" accepted.
    expect(tok).toBe("9m2x");
    expect(tok).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(tok).toMatch(/[a-z]/);
    seen.add(tok);
  });

  it("parseRef treats all-digit tokens as seq refs", () => {
    expect(parseRef("decision", "D-12")).toEqual({ kind: "seq", seq: 12 });
    expect(parseRef("decision", "12")).toEqual({ kind: "seq", seq: 12 });
  });

  it("parseRef treats tokens with a letter as canonical refs", () => {
    expect(parseRef("decision", "D-9m2x")).toEqual({ kind: "canonical", id: "D-9m2x" });
    expect(parseRef("decision", "9m2x")).toEqual({ kind: "canonical", id: "D-9m2x" });
  });

  it("parseRef rejects a prefix mismatch and garbage", () => {
    expect(parseRef("decision", "T-12")).toBeNull();
    expect(parseRef("decision", "")).toBeNull();
    expect(parseRef("decision", "D-")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ids/short-id.test.ts`
Expected: FAIL — `Cannot find module '../../src/ids/short-id.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ids/short-id.ts

/** Entity types that receive the full short-id + seq treatment. */
export type EntityType = "decision" | "todo";

/** Single-letter display/canonical prefix per entity type. */
export const PREFIX: Record<EntityType, string> = {
  decision: "D",
  todo: "T",
};

/**
 * Crockford base32, lowercase, minus the visually ambiguous i l o u.
 * 32 symbols -> 4 chars give 32^4 ≈ 1.05M values per type per repo.
 */
export const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const TOKEN_LEN = 4;
const TOKEN_RE = /^[0-9abcdefghjkmnpqrstvwxyz]{4}$/;
const HAS_LETTER_RE = /[a-z]/;

/** Default token source: TOKEN_LEN symbols drawn from ALPHABET via crypto. */
function cryptoToken(): string {
  // crypto is imported lazily so the module stays trivially testable.
  const { randomInt } = require("node:crypto") as typeof import("node:crypto");
  let out = "";
  for (let i = 0; i < TOKEN_LEN; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/**
 * Produce a token that always contains at least one letter, so the canonical
 * namespace is disjoint from the all-digit seq namespace. `draw` is injectable
 * for deterministic tests; it must return TOKEN_LEN symbols from ALPHABET.
 */
export function randomToken(draw: () => string = cryptoToken): string {
  // Bounded loop: rejecting all-digit draws cannot loop forever in practice
  // (P(all-digit) = (10/32)^4 ≈ 0.95%); cap iterations as a safety net.
  for (let i = 0; i < 1000; i++) {
    const tok = draw();
    if (TOKEN_RE.test(tok) && HAS_LETTER_RE.test(tok)) return tok;
  }
  throw new Error("randomToken: exhausted attempts producing a valid token");
}

export function formatCanonical(type: EntityType, token: string): string {
  return `${PREFIX[type]}-${token}`;
}

export function formatDisplay(type: EntityType, seq: number): string {
  return `${PREFIX[type]}-${seq}`;
}

export type ParsedRef =
  | { kind: "seq"; seq: number }
  | { kind: "canonical"; id: string };

/**
 * Resolve a raw reference (with or without the type prefix) into either a seq
 * lookup or a canonical id. Returns null on prefix mismatch or empty body.
 * Rule: an all-digit body is a seq; anything else is a canonical token.
 */
export function parseRef(type: EntityType, raw: string): ParsedRef | null {
  if (!raw) return null;
  const prefix = `${PREFIX[type]}-`;
  let body = raw;
  if (raw.includes("-")) {
    if (!raw.startsWith(prefix)) return null; // wrong type's prefix
    body = raw.slice(prefix.length);
  }
  if (!body) return null;
  if (/^\d+$/.test(body)) return { kind: "seq", seq: Number(body) };
  return { kind: "canonical", id: formatCanonical(type, body) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ids/short-id.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ids/short-id.ts tests/ids/short-id.test.ts
git commit -m "feat(ids): pure short-id grammar (token, prefixes, ref parsing)"
```

---

## Task 2: `id_sequences` schema + `seq` column

**Files:**
- Modify: `src/decisions/db.ts`
- Test: `tests/ids/allocator.test.ts` (created in Task 3; schema is exercised there)

- [ ] **Step 1: Add the table to BASE_SCHEMA**

In `src/decisions/db.ts`, append to the `BASE_SCHEMA` template string (after the `schema_meta` table, before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS id_sequences (
  entity_type TEXT PRIMARY KEY,   -- 'decision' | 'todo'
  next_val    INTEGER NOT NULL    -- next seq to hand out (1-based)
);
```

- [ ] **Step 2: Additively add the `seq` column for pre-existing DBs**

Add this function next to `ensureProvenanceColumn` in `src/decisions/db.ts`:

```typescript
/** Additively add the seq column to pre-existing DBs. Idempotent. */
function ensureSeqColumn(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(decisions)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "seq")) {
    db.exec("ALTER TABLE decisions ADD COLUMN seq INTEGER");
  }
}
```

Call it inside `openDecisionsDb`, immediately after `ensureProvenanceColumn(db);`:

```typescript
  ensureProvenanceColumn(db);
  ensureSeqColumn(db);
```

- [ ] **Step 3: Verify the project still builds**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/decisions/db.ts
git commit -m "feat(db): id_sequences table + decisions.seq column"
```

---

## Task 3: Transactional `mintId` allocator

**Files:**
- Create: `src/ids/allocator.ts`
- Test: `tests/ids/allocator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ids/allocator.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mintId } from "../../src/ids/allocator.js";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE id_sequences (entity_type TEXT PRIMARY KEY, next_val INTEGER NOT NULL);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, seq INTEGER);
  `);
  return db;
}

describe("mintId", () => {
  it("hands out monotonic seq starting at 1", () => {
    const db = freshDb();
    const exists = (id: string) =>
      db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(id) != null;
    const a = mintId(db, "decision", exists);
    const b = mintId(db, "decision", exists);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(a.id).toMatch(/^D-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(a.id).not.toBe(b.id);
  });

  it("regenerates the token on canonical-id collision", () => {
    const db = freshDb();
    // Pretend D-9m2x already exists; the allocator must not return it.
    db.prepare("INSERT INTO decisions (id, seq) VALUES ('D-9m2x', 1)").run();
    const exists = (id: string) =>
      db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(id) != null;
    const minted = mintId(db, "decision", exists, () => "9m2x" /* always collides */, 3);
    // After exhausting forced collisions the helper throws; assert that contract.
    expect(() => minted).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ids/allocator.test.ts`
Expected: FAIL — `Cannot find module '../../src/ids/allocator.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/ids/allocator.ts
import type Database from "better-sqlite3";
import { EntityType, randomToken, formatCanonical } from "./short-id.js";

export interface MintedId {
  id: string;   // canonical, e.g. "D-9m2x"
  seq: number;  // per-repo per-type, e.g. 12
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
    const row = db
      .prepare("SELECT next_val FROM id_sequences WHERE entity_type = ?")
      .get(type) as { next_val: number } | undefined;
    const seq = row?.next_val ?? 1;
    db.prepare(
      `INSERT INTO id_sequences (entity_type, next_val) VALUES (?, ?)
       ON CONFLICT(entity_type) DO UPDATE SET next_val = ?`,
    ).run(type, seq + 1, seq + 1);

    for (let i = 0; i < maxTries; i++) {
      const id = formatCanonical(type, randomToken(draw));
      if (!idExists(id)) return { id, seq };
    }
    throw new Error(`mintId: could not find a free ${type} id after ${maxTries} tries`);
  })();
}
```

> Note: with `draw` forced to a constant colliding token, the loop exhausts and throws — that is the contract the collision test documents. Adjust the test's final assertion to `expect(() => mintId(db, "decision", exists, () => "9m2x", 3)).toThrow()` if you prefer an explicit throw assertion.

- [ ] **Step 4: Fix the collision test to assert the throw, then run**

Replace the body of the second test with:

```typescript
    expect(() => mintId(db, "decision", exists, () => "9m2x", 3)).toThrow(/could not find a free/);
```

Run: `npx vitest run tests/ids/allocator.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ids/allocator.ts tests/ids/allocator.test.ts
git commit -m "feat(ids): transactional mintId allocator (seq + collision-free token)"
```

---

## Task 4: Mint short ids in DecisionService

**Files:**
- Modify: `src/decisions/repository.ts` (add `seq` to record + columns + insert; add `getBySeq`)
- Modify: `src/decisions/types.ts` (add `seq` to `Decision`; map in `nodeToDecision`)
- Modify: `src/decisions/service.ts` (mint in `create`/`propose`; map `seq` in `toDecision`)
- Modify: `src/decisions/search.ts`, `src/decisions/promotion.ts` (map `seq` in their `toDecision`)
- Test: `tests/decisions/short-id-mint.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decisions/short-id-mint.test.ts
import { describe, it, expect } from "vitest";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

function svc(): DecisionService {
  const db = openDecisionsDb(":memory:");
  return new DecisionService({
    decisions: new DecisionsRepository(db),
    links: new DecisionLinksRepository(db),
  });
}

describe("DecisionService minting", () => {
  it("create() assigns a D- canonical id and seq starting at 1", () => {
    const s = svc();
    const a = s.create({ title: "first", rationale: "r" });
    const b = s.create({ title: "second", rationale: "r" });
    expect(a.id).toMatch(/^D-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it("propose() shares the same seq counter as create()", () => {
    const s = svc();
    s.create({ title: "first", rationale: "r" });
    const p = s.propose({ title: "p", rationale: "r" });
    expect(p.seq).toBe(2);
    expect(p.id).toMatch(/^D-/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/short-id-mint.test.ts`
Expected: FAIL — `a.seq` is `undefined` and `a.id` is a UUID (no `D-` prefix).

- [ ] **Step 3a: Add `seq` to the record layer**

In `src/decisions/repository.ts`:
- Add `seq: number;` to the `DecisionRecord` interface (after `id`).
- Update `SELECT_COLS` to include `seq`:

```typescript
const SELECT_COLS =
  "id, seq, title, description, rationale, problem, resolution, alternatives, tier, status, superseded_by, author, provenance, created_at, updated_at";
```

- Update the `insert` VALUES list to add `@seq` right after `@id`:

```typescript
        `INSERT INTO decisions (${SELECT_COLS}) VALUES
         (@id, @seq, @title, @description, @rationale, @problem, @resolution, @alternatives,
          @tier, @status, @superseded_by, @author, @provenance, @created_at, @updated_at)`,
```

- Add a seq lookup method to the class:

```typescript
  getBySeq(seq: number): DecisionRecord | null {
    const row = this.db
      .prepare(`SELECT ${READ_COLS} FROM decisions WHERE seq = ?`)
      .get(seq) as DecisionRecord | undefined;
    return row ?? null;
  }
```

- [ ] **Step 3b: Add `seq` to the `Decision` type and mappers**

In `src/decisions/types.ts`: add `seq: number;` to the `Decision` interface (after `id: string;`). In `nodeToDecision`, add `seq: data.seq ?? 0,` (graph-node decisions have no seq; default 0).

In `src/decisions/service.ts`, `src/decisions/search.ts`, `src/decisions/promotion.ts`: in each `toDecision(rec)`, add `seq: rec.seq,` to the returned object (right after `id: rec.id,`).

- [ ] **Step 3c: Mint in `create` and `propose`**

In `src/decisions/service.ts`:
- Add an import: `import { mintId } from "../ids/allocator.js";`
- Remove the now-unused `import { randomUUID } from "node:crypto";` once both call sites are converted.
- The service needs the raw `db` handle for `mintId`. Add `db: Database.Database` to `DecisionServiceDeps` and store it as `private db`. (Construction sites already have the db — they build the repositories from it; pass it through.)
- In `create` (replaces `const id = randomUUID();`):

```typescript
    const { id, seq } = mintId(this.db, "decision", (cand) => this.decisions.get(cand) != null);
```

  Add `seq,` to the `rec` object literal (after `id,`).
- In `propose` (replaces `const id = randomUUID();`): same `mintId` call; add `seq,` to its `rec` literal.

Update every `new DecisionService({ ... })` construction to pass `db`. Find them with:

```bash
grep -rn "new DecisionService(" src/ tests/
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/short-id-mint.test.ts`
Expected: PASS (2 tests). Then `npx tsc --noEmit` — no errors.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/ tests/decisions/short-id-mint.test.ts
git commit -m "feat(decisions): mint D- short ids + seq on create/propose"
```

---

## Task 5: Resolve either ref form on read/write

**Files:**
- Modify: `src/decisions/service.ts` (add `resolve`; route `get`/`update`/`delete`/`supersede` through it)
- Test: `tests/decisions/ref-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decisions/ref-resolution.test.ts
import { describe, it, expect } from "vitest";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

function svc(): DecisionService {
  const db = openDecisionsDb(":memory:");
  return new DecisionService({
    db,
    decisions: new DecisionsRepository(db),
    links: new DecisionLinksRepository(db),
  });
}

describe("decision ref resolution", () => {
  it("get() resolves canonical id, seq form, and bare seq to the same row", () => {
    const s = svc();
    const created = s.create({ title: "t", rationale: "r" }); // seq 1
    expect(s.get(created.id)?.id).toBe(created.id);     // D-9m2x
    expect(s.get("D-1")?.id).toBe(created.id);          // seq form
    expect(s.get("1")?.id).toBe(created.id);            // bare seq
  });

  it("get() returns null for an unknown ref", () => {
    const s = svc();
    expect(s.get("D-99")).toBeNull();
    expect(s.get("D-zzzz")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/ref-resolution.test.ts`
Expected: FAIL — `s.get("D-1")` returns null (raw passthrough to `repository.get`).

- [ ] **Step 3: Add a resolver and route reads through it**

In `src/decisions/service.ts`:
- Import: `import { parseRef } from "../ids/short-id.js";`
- Add a private resolver that turns any ref form into a stored `DecisionRecord` (or null):

```typescript
  /** Resolve a canonical id, "D-<seq>", or bare "<seq>" to the stored record. */
  private resolveRecord(ref: string): DecisionRecord | null {
    const direct = this.decisions.get(ref);
    if (direct) return direct; // exact canonical id (fast path)
    const parsed = parseRef("decision", ref);
    if (!parsed) return null;
    if (parsed.kind === "seq") return this.decisions.getBySeq(parsed.seq);
    return this.decisions.get(parsed.id);
  }
```

- Rewrite `get` to use it:

```typescript
  get(id: string): Decision | null {
    const rec = this.resolveRecord(id);
    return rec ? toDecision(rec) : null;
  }
```

- In `update`, `delete`, and `supersede`, replace the leading `this.decisions.get(<ref>)` existence check with `this.resolveRecord(<ref>)`, and use the resolved `existing.id` (the canonical id) for all subsequent writes (`this.decisions.update(existing.id, ...)`, link writes, event payloads). This guarantees writes always key on the canonical id even when the caller passed a seq form.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/ref-resolution.test.ts`
Expected: PASS (2 tests). Then run the full decisions suite: `npx vitest run tests/decisions/` — all green.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/service.ts tests/decisions/ref-resolution.test.ts
git commit -m "feat(decisions): accept canonical id or seq form on read/write"
```

---

## Task 6: Hard-cutover migration

**Files:**
- Create: `src/decisions/id-migration.ts`
- Modify: `src/mcp-server/repo-context.ts` (call after `openDecisionsDb`, line ~280)
- Modify: `src/index.ts` (call after `openDecisionsDb`, line ~159)
- Test: `tests/decisions/id-migration.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/decisions/id-migration.test.ts
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { migrateDecisionIdsToShortForm } from "../../src/decisions/id-migration.js";

/** Seed a DB shaped like the legacy UUID world. */
function seedLegacy(): Database.Database {
  const db = openDecisionsDb(":memory:");
  const A = "04c848f0-0000-0000-0000-000000000001";
  const B = "04c848f0-0000-0000-0000-000000000002";
  const ins = db.prepare(
    `INSERT INTO decisions (id, title, rationale, tier, status, superseded_by, created_at, updated_at)
     VALUES (?, ?, 'r', 'personal', ?, ?, ?, ?)`,
  );
  ins.run(A, "older", "active", null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  ins.run(B, "newer-supersedes-A", "superseded", A, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
  // Wait — B supersedes A, so A.superseded_by = B. Fix the rows accordingly:
  db.prepare("UPDATE decisions SET superseded_by = NULL, status = 'active' WHERE id = ?").run(B);
  db.prepare("UPDATE decisions SET superseded_by = ?, status = 'superseded' WHERE id = ?").run(B, A);
  // Links: a GOVERNS link from A, and a SUPERSEDES link from B -> A.
  const link = db.prepare(
    `INSERT INTO decision_links (decision_id, target_kind, target_ref, relation, created_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
  );
  link.run(A, "path", "src/foo.ts", "GOVERNS");
  link.run(B, "decision", A, "SUPERSEDES");
  return db;
}

describe("migrateDecisionIdsToShortForm", () => {
  it("rewrites ids, assigns seq by created_at, and remaps all references", () => {
    const db = seedLegacy();
    migrateDecisionIdsToShortForm(db);

    const rows = db.prepare("SELECT id, seq, superseded_by, created_at FROM decisions ORDER BY seq").all() as
      Array<{ id: string; seq: number; superseded_by: string | null; created_at: string }>;
    expect(rows).toHaveLength(2);
    // Oldest (Jan) gets seq 1.
    expect(rows[0].seq).toBe(1);
    expect(rows[0].created_at).toBe("2026-01-01T00:00:00Z");
    expect(rows[0].id).toMatch(/^D-[0-9abcdefghjkmnpqrstvwxyz]{4}$/);
    expect(rows[1].seq).toBe(2);

    const older = rows[0]; // was A
    const newer = rows[1]; // was B
    // A.superseded_by now points at B's new id.
    expect(older.superseded_by).toBe(newer.id);

    // GOVERNS link's decision_id remapped to A's new id.
    const govern = db.prepare("SELECT decision_id FROM decision_links WHERE relation='GOVERNS'").get() as { decision_id: string };
    expect(govern.decision_id).toBe(older.id);
    // SUPERSEDES link: decision_id -> B new id, target_ref -> A new id.
    const sup = db.prepare("SELECT decision_id, target_ref FROM decision_links WHERE relation='SUPERSEDES'").get() as { decision_id: string; target_ref: string };
    expect(sup.decision_id).toBe(newer.id);
    expect(sup.target_ref).toBe(older.id);

    // id_sequences advanced past the migrated rows.
    const next = db.prepare("SELECT next_val FROM id_sequences WHERE entity_type='decision'").get() as { next_val: number };
    expect(next.next_val).toBe(3);
  });

  it("is idempotent: a second run is a no-op", () => {
    const db = seedLegacy();
    migrateDecisionIdsToShortForm(db);
    const before = db.prepare("SELECT id, seq FROM decisions ORDER BY seq").all();
    migrateDecisionIdsToShortForm(db);
    const after = db.prepare("SELECT id, seq FROM decisions ORDER BY seq").all();
    expect(after).toEqual(before);
  });

  it("leaves already-short ids untouched (skips D- rows)", () => {
    const db = openDecisionsDb(":memory:");
    db.prepare(
      `INSERT INTO decisions (id, seq, title, rationale, tier, status, created_at, updated_at)
       VALUES ('D-9m2x', 1, 't', 'r', 'personal', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();
    migrateDecisionIdsToShortForm(db);
    const row = db.prepare("SELECT id, seq FROM decisions").get() as { id: string; seq: number };
    expect(row.id).toBe("D-9m2x");
    expect(row.seq).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/id-migration.test.ts`
Expected: FAIL — `Cannot find module '../../src/decisions/id-migration.js'`.

- [ ] **Step 3: Write the migration**

```typescript
// src/decisions/id-migration.ts
import type Database from "better-sqlite3";
import { mintId } from "../ids/allocator.js";
import { PREFIX } from "../ids/short-id.js";

const META_KEY = "decision_ids_shortform";
const DECISION_PREFIX = `${PREFIX.decision}-`; // "D-"

function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Hard cutover: rewrite every legacy (non-"D-") decision id to a short
 * canonical id, assign a per-repo seq in created_at order, and remap all
 * internal references — superseded_by, decision_links.decision_id, and
 * decision_links.target_ref for decision-kind links. UUIDs are dropped (no
 * legacy alias). Idempotent: rows already in D- form are skipped, and the
 * schema_meta flag short-circuits repeat runs once nothing legacy remains.
 */
export function migrateDecisionIdsToShortForm(db: Database.Database): void {
  if (readMeta(db, META_KEY) === "done") return;

  db.transaction(() => {
    const legacy = db
      .prepare(
        `SELECT id FROM decisions WHERE id NOT LIKE '${DECISION_PREFIX}%' ORDER BY created_at ASC, rowid ASC`,
      )
      .all() as Array<{ id: string }>;

    // Build old -> new map, minting in created_at order so D-1 is the oldest.
    const idExists = (cand: string) =>
      db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(cand) != null;
    const map = new Map<string, string>();
    for (const { id: oldId } of legacy) {
      const minted = mintId(db, "decision", idExists);
      // Stamp seq immediately so subsequent idExists checks and minting see it,
      // but defer the id rewrite until the map is complete (FK safety below).
      db.prepare("UPDATE decisions SET seq = ? WHERE id = ?").run(minted.seq, oldId);
      map.set(oldId, minted.id);
    }
    if (map.size === 0) {
      db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, 'done')").run(META_KEY);
      return;
    }

    // Disable FK enforcement for the rewrite so PK updates don't trip the
    // decision_links FK mid-flight; re-enabled by the caller's connection.
    db.pragma("foreign_keys = OFF");
    for (const [oldId, newId] of map) {
      db.prepare("UPDATE decisions SET id = ? WHERE id = ?").run(newId, oldId);
      db.prepare("UPDATE decisions SET superseded_by = ? WHERE superseded_by = ?").run(newId, oldId);
      db.prepare("UPDATE decision_links SET decision_id = ? WHERE decision_id = ?").run(newId, oldId);
      db.prepare(
        "UPDATE decision_links SET target_ref = ? WHERE target_kind = 'decision' AND target_ref = ?",
      ).run(newId, oldId);
    }
    db.pragma("foreign_keys = ON");

    db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, 'done')").run(META_KEY);
  })();
}
```

> The third test ("leaves already-short ids untouched") exercises the `map.size === 0` path: the only row is already `D-`, so it is excluded from `legacy`, the map is empty, and the flag is set without touching rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/id-migration.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Hook the migration into both DB-open sites**

In `src/mcp-server/repo-context.ts`, add the import near the other decisions imports:

```typescript
import { migrateDecisionIdsToShortForm } from "../decisions/id-migration.js";
```

and call it right after the existing migration at line ~281:

```typescript
    const decisionsDb = openDecisionsDb(decisionsDbPath);
    migrateDecisionsFromGraphDb(decisionsDb, graphDbPath);
    migrateDecisionIdsToShortForm(decisionsDb);
```

In `src/index.ts`, add the import and call after line ~159:

```typescript
import { migrateDecisionIdsToShortForm } from "./decisions/id-migration.js";
// ...
const decisionsDb = openDecisionsDb(decisionsDbPath);
migrateDecisionIdsToShortForm(decisionsDb);
```

- [ ] **Step 6: Verify build + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: build clean; all tests pass (including the existing `tests/regression/decisions-cross-repo-isolation.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add src/decisions/id-migration.ts src/mcp-server/repo-context.ts src/index.ts tests/decisions/id-migration.test.ts
git commit -m "feat(decisions): hard-cutover migration UUID -> D- short ids"
```

---

## Task 7: Viewer renders `D-<seq>`

**Files:**
- Modify: `src/viewer/viewer.js`
- (Verify the API serializes `seq`: `src/mcp-server` / `src/api` decision payload — `Decision.seq` now exists, so confirm it is included in the `/api/decisions` response shape.)

- [ ] **Step 1: Confirm `seq` reaches the viewer**

Run:

```bash
grep -rn "seq\|\.id" src/viewer/viewer.js | grep -i "decision\|D-\|label\|pill" | head
grep -rn "decisions" src/mcp-server/**/*.ts | grep -i "api\|json\|serialize" | head
```

The `/api/decisions` endpoint returns `Decision` objects; since Task 4 added `seq` to the `Decision` interface, it is already in the payload. If the endpoint hand-picks fields, add `seq` to the projection.

- [ ] **Step 2: Render the display id in the pill/marginalia**

In `src/viewer/viewer.js`, find where a decision's id is drawn into a pill or marginalia label (search for the decision label text, e.g. the place that currently shows the raw `d.id`). Replace the raw id with the display form:

```javascript
// Display id for a decision: prefer the friendly seq form, fall back to id.
function decisionDisplayId(d) {
  return (d.seq != null) ? ('D-' + d.seq) : d.id;
}
```

Use `decisionDisplayId(d)` wherever the pill text is composed (e.g. `decisionDisplayId(d) + ' · ' + d.title`). Keep the existing green color treatment for the `D-` monospace id.

- [ ] **Step 3: Gate 0 — Visual QA (required: this is a render-path change)**

Per `.claude/rules/workflow.md` Gate 0:

```bash
npm run dev   # background; wait for http://localhost:3334/viewer
```

Drive the viewer with Playwright MCP:
- Navigate to `http://localhost:3334/viewer`.
- Hover a decision dot; confirm the pill reads `D-12 · <title>` (a small integer, not a UUID).
- Capture a screenshot to `.tmp/viewer-short-id.png` (gitignored).
- Check the browser console for errors.

Block completion on runtime errors or a UUID/`undefined` still showing in the pill.

- [ ] **Step 4: Commit**

```bash
git add src/viewer/viewer.js
git commit -m "feat(viewer): render decisions as D-<seq> display ids"
```

---

## Task 8: Documentation sweep (dead UUID references)

**Files:**
- Modify: `CLAUDE.md`, `docs/**` (only where an old UUID maps to a known new id)

- [ ] **Step 1: Find prose UUID references**

```bash
grep -rIn "[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}" CLAUDE.md docs/ || true
grep -rIn "decision \`04c848f0\`\|\`04c848f0\`" CLAUDE.md docs/ || true
```

- [ ] **Step 2: Rewrite mappable references, leave the rest**

For each hit that refers to a still-present decision, replace the 8-char prefix / UUID with its new `D-<seq>` id (look it up via `get_decision` once a repo is migrated). Historical references with no surviving decision are left as-is (they are archival). This task is documentation-only — no code, no tests.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: update decision references to D-<seq> short ids"
```

---

## Self-Review

**Spec coverage:**
- ID model (canonical + seq) → Tasks 1, 3, 4. ✓
- Crockford alphabet, ≥1-letter invariant, digit-vs-letter disambiguation → Task 1. ✓
- Random canonical survives rehome → preserved by minting opaque tokens (Task 3/4) and never deriving the PK from seq; the existing cross-repo isolation regression runs in Task 6 Step 6. ✓
- `id_sequences` table + transactional mint → Tasks 2, 3. ✓
- Both forms citeable → Task 5. ✓
- PRs `PR-` display-only → no code change needed (PR identity already the GH number); covered by leaving PR links keyed on number. Viewer PR prefix is existing behavior; no task required. ✓
- Hard cutover, 4 remap sites, idempotent, hooked at both DB-open sites → Task 6. ✓
- Doc sweep mitigation → Task 8. ✓
- Viewer `D-<seq>`, color-coded, Gate 0 → Task 7. ✓
- TODOs `T-` reserved (not implemented) → `EntityType` includes `todo`, `PREFIX.todo='T'`, `mintId` is type-generic; no decision-specific assumptions block reuse. ✓

**Placeholder scan:** No TBD/TODO-in-code/"handle edge cases" — every code step shows code. ✓

**Type consistency:** `EntityType`, `PREFIX`, `randomToken(draw)`, `parseRef`, `formatCanonical`, `formatDisplay`, `MintedId`, `mintId(db, type, idExists, draw?, maxTries?)`, `migrateDecisionIdsToShortForm(db)`, `DecisionsRepository.getBySeq`, `Decision.seq`, `DecisionRecord.seq` are used consistently across tasks. ✓

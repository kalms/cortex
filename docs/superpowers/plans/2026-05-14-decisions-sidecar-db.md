# Decisions Sidecar DB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move decisions out of the graph DB into a sibling `.cortex/decisions.db` so that `index_repository` cache-import and full-reindex no longer destroy user-authored decisions (Gap 10 in the harness adoption audit).

**Architecture:** Decisions become orthogonal to the graph. `.cortex/graph.db` stays a fully-replaceable derived artifact (cache copies it freely; full re-index deletes and recreates it). `.cortex/decisions.db` is the durable user-authored store — schema is `decisions`, `decision_links` (target by qualified-name string, not node id), and `decisions_fts`. Decision-to-decision edges (SUPERSEDES, DECISION_RELATED_TO, DECISION_DEPENDS_ON) live in `decision_links` too — both ends are decisions, so they're internal to this DB. PR ↔ decision edges (PR_INTRODUCES_DECISION etc.) key on PR number (stable across re-indexes), also in `decision_links`. Migration runs idempotently at server startup AND defensively at the top of `index_repository` so we can't lose decisions to a cache-import race.

**Tech Stack:** TypeScript, `better-sqlite3` (already in use), Vitest (existing test runner), Node 20+.

---

## File Structure

**New files (durable user-authored store):**
- `src/decisions/db.ts` — Open/close `decisions.db`, schema setup (idempotent CREATE TABLE IF NOT EXISTS), migration of existing data from the graph DB on first run.
- `src/decisions/repository.ts` — `DecisionsRepository`: CRUD over the `decisions` table (insert/update/delete/get/list).
- `src/decisions/links-repository.ts` — `DecisionLinksRepository`: CRUD over `decision_links` (add/remove/find by decision_id, target_qn, relation).
- `tests/decisions/db.test.ts`, `tests/decisions/repository.test.ts`, `tests/decisions/links-repository.test.ts`, `tests/decisions/migration.test.ts`, `tests/decisions/cache-survival.test.ts` — focused module tests + the end-to-end Gap-10 regression test.

**Modified files (rewired to use the new store):**
- `src/db/resolve-path.ts` — add `resolveDecisionsDbPath(startDir?)` matching the existing `resolveCortexDbPath` shape.
- `src/decisions/service.ts` — replace `GraphStore` calls for decision tables with the two repositories. Keep the `EventBus` integration unchanged. PR linking goes through PR number, not graph node id.
- `src/decisions/search.ts` — query `decision_links` by `target_qn` with hierarchy walk; no longer touches the graph node table to find decisions.
- `src/mcp-server/tools/decision-tools.ts` — inject the new repositories instead of (or alongside) the GraphStore.
- `src/mcp-server/server.ts` — open `decisions.db` at startup, run idempotent migration.
- `src/mcp-server/tools/code-tools.ts` — top of `index_repository`, defensively run the migration in case the user's first action is to index before anything else opened the decisions DB.

**Schema (`.cortex/decisions.db`):**

```sql
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  rationale    TEXT,
  problem      TEXT,
  resolution   TEXT,
  alternatives TEXT,           -- JSON array
  tier         TEXT NOT NULL DEFAULT 'personal',
  status       TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,          -- decision id or NULL
  author       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_links (
  rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id  TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_kind  TEXT NOT NULL,  -- 'qn' | 'path' | 'decision' | 'pr'
  target_ref   TEXT NOT NULL,  -- qualified_name, file path, decision id, or PR number (as text)
  relation     TEXT NOT NULL,  -- GOVERNS|REFERENCES|SUPERSEDES|DECISION_RELATED_TO|DECISION_DEPENDS_ON|PR_INTRODUCES_DECISION|PR_IMPLEMENTS_DECISION|PR_CHALLENGES_DECISION|PR_DISCUSSES_DECISION
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_links_decision ON decision_links(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_links_target   ON decision_links(target_kind, target_ref);

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, description, rationale, problem, resolution,
  content='decisions',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Used to track that migration from graph DB has been completed.
```

---

## Task 1: Resolve the sidecar DB path

**Files:**
- Modify: `src/db/resolve-path.ts`
- Test: `tests/db/resolve-path.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/db/resolve-path.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("resolveDecisionsDbPath", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cortex-test-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("returns <repo>/.cortex/decisions.db for a git repo", () => {
    mkdirSync(join(root, ".git"));
    expect(resolveDecisionsDbPath(root)).toBe(join(root, ".cortex", "decisions.db"));
  });

  it("walks up to the git root from a subdirectory", () => {
    mkdirSync(join(root, ".git"));
    const sub = join(root, "src", "nested");
    mkdirSync(sub, { recursive: true });
    expect(resolveDecisionsDbPath(sub)).toBe(join(root, ".cortex", "decisions.db"));
  });

  it("honors $CORTEX_DECISIONS_DB env override", () => {
    const override = join(root, "custom", "decisions.db");
    process.env.CORTEX_DECISIONS_DB = override;
    try {
      expect(resolveDecisionsDbPath(root)).toBe(override);
    } finally {
      delete process.env.CORTEX_DECISIONS_DB;
    }
  });

  it("falls back to <startDir>/.cortex/decisions.db when no .git is found", () => {
    expect(resolveDecisionsDbPath(root)).toBe(join(root, ".cortex", "decisions.db"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/db/resolve-path.test.ts`
Expected: FAIL — `resolveDecisionsDbPath is not exported`.

- [ ] **Step 3: Implement**

Add to `src/db/resolve-path.ts`:

```typescript
export function resolveDecisionsDbPath(startDir?: string): string {
  const override = process.env.CORTEX_DECISIONS_DB;
  if (override) return override;

  const start = startDir ?? process.cwd();
  const gitRoot = findGitRoot(start);
  const base = gitRoot ?? start;
  return join(base, ".cortex", "decisions.db");
}
```

(`findGitRoot` is the same private helper already used by `resolveCortexDbPath`.
If it isn't exported yet, leave it private and reuse it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/db/resolve-path.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/db/resolve-path.ts tests/db/resolve-path.test.ts
git commit -m "feat(decisions): resolveDecisionsDbPath helper for sidecar DB"
```

---

## Task 2: Open/close `decisions.db` with schema setup

**Files:**
- Create: `src/decisions/db.ts`
- Test: `tests/decisions/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/db.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";

describe("openDecisionsDb", () => {
  it("creates schema on first open and is idempotent on second open", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    try {
      const path = join(root, "decisions.db");

      const db1 = openDecisionsDb(path);
      const tables = db1
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain("decisions");
      expect(tableNames).toContain("decision_links");
      expect(tableNames).toContain("schema_meta");
      db1.close();

      // Re-open: schema setup should not throw.
      const db2 = openDecisionsDb(path);
      const count = (db2.prepare("SELECT COUNT(*) AS c FROM decisions").get() as { c: number }).c;
      expect(count).toBe(0);
      db2.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates the decisions_fts virtual table", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    try {
      const db = openDecisionsDb(join(root, "decisions.db"));
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decisions_fts'")
        .get() as { name: string } | undefined;
      expect(row?.name).toBe("decisions_fts");
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/db.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/decisions/db.ts`:

```typescript
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  rationale    TEXT,
  problem      TEXT,
  resolution   TEXT,
  alternatives TEXT,
  tier         TEXT NOT NULL DEFAULT 'personal',
  status       TEXT NOT NULL DEFAULT 'active',
  superseded_by TEXT,
  author       TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_links (
  rowid        INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id  TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  target_kind  TEXT NOT NULL,
  target_ref   TEXT NOT NULL,
  relation     TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decision_links_decision ON decision_links(decision_id);
CREATE INDEX IF NOT EXISTS idx_decision_links_target   ON decision_links(target_kind, target_ref);

CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, description, rationale, problem, resolution,
  content='decisions',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Open (and create if missing) the decisions sidecar DB. */
export function openDecisionsDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/db.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/db.ts tests/decisions/db.test.ts
git commit -m "feat(decisions): openDecisionsDb with schema bootstrap"
```

---

## Task 3: `DecisionsRepository` — CRUD over `decisions` table

**Files:**
- Create: `src/decisions/repository.ts`
- Test: `tests/decisions/repository.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/repository.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository, DecisionRecord } from "../../src/decisions/repository.js";

describe("DecisionsRepository", () => {
  let root: string;
  let db: Database.Database;
  let repo: DecisionsRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    repo = new DecisionsRepository(db);
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  function sample(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
    return {
      id: "d1",
      title: "Use vitest",
      description: "Standardize on vitest for unit tests.",
      rationale: "Same runner across packages, fast watch mode.",
      problem: "Mixed jest/mocha setups slow contributor onboarding.",
      resolution: "Convert all suites to vitest by end of quarter.",
      alternatives: JSON.stringify([{ name: "jest", reason_rejected: "slower watch mode" }]),
      tier: "personal",
      status: "active",
      superseded_by: null,
      author: "claude",
      created_at: "2026-05-14T10:00:00Z",
      updated_at: "2026-05-14T10:00:00Z",
      ...overrides,
    };
  }

  it("insert + get round-trips a full record", () => {
    repo.insert(sample());
    const got = repo.get("d1");
    expect(got).toEqual(sample());
  });

  it("update modifies only the changed fields", () => {
    repo.insert(sample());
    repo.update("d1", { status: "deprecated", updated_at: "2026-05-14T11:00:00Z" });
    const got = repo.get("d1");
    expect(got?.status).toBe("deprecated");
    expect(got?.updated_at).toBe("2026-05-14T11:00:00Z");
    expect(got?.title).toBe("Use vitest"); // unchanged
  });

  it("delete removes the record and returns true; returns false if missing", () => {
    repo.insert(sample());
    expect(repo.delete("d1")).toBe(true);
    expect(repo.get("d1")).toBeNull();
    expect(repo.delete("d1")).toBe(false);
  });

  it("list returns all decisions ordered by created_at desc", () => {
    repo.insert(sample({ id: "d1", created_at: "2026-05-14T10:00:00Z" }));
    repo.insert(sample({ id: "d2", created_at: "2026-05-14T11:00:00Z" }));
    const all = repo.list();
    expect(all.map((d) => d.id)).toEqual(["d2", "d1"]);
  });

  it("get returns null for missing id", () => {
    expect(repo.get("missing")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/decisions/repository.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/repository.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/repository.ts tests/decisions/repository.test.ts
git commit -m "feat(decisions): DecisionsRepository CRUD over sidecar DB"
```

---

## Task 4: `DecisionLinksRepository` — CRUD over `decision_links`

**Files:**
- Create: `src/decisions/links-repository.ts`
- Test: `tests/decisions/links-repository.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/links-repository.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository, TargetKind, Relation } from "../../src/decisions/links-repository.js";

describe("DecisionLinksRepository", () => {
  let root: string;
  let db: Database.Database;
  let decisions: DecisionsRepository;
  let links: DecisionLinksRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    decisions = new DecisionsRepository(db);
    links = new DecisionLinksRepository(db);
    decisions.insert({
      id: "d1", title: "t", description: null, rationale: null, problem: null,
      resolution: null, alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null, created_at: "2026-05-14T10:00:00Z",
      updated_at: "2026-05-14T10:00:00Z",
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("add + findByDecision round-trips", () => {
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "src/foo.ts::bar", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    const got = links.findByDecision("d1");
    expect(got).toHaveLength(1);
    expect(got[0].target_kind).toBe("qn");
    expect(got[0].target_ref).toBe("src/foo.ts::bar");
    expect(got[0].relation).toBe("GOVERNS");
  });

  it("findByTarget matches by (kind, ref)", () => {
    links.add({ decision_id: "d1", target_kind: "path", target_ref: "src/foo.ts", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    expect(links.findByTarget("path", "src/foo.ts")).toHaveLength(1);
    expect(links.findByTarget("qn", "src/foo.ts")).toHaveLength(0);
  });

  it("findByTarget supports relation filter", () => {
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "REFERENCES", created_at: "2026-05-14T10:00:00Z" });
    expect(links.findByTarget("qn", "x", "GOVERNS")).toHaveLength(1);
    expect(links.findByTarget("qn", "x")).toHaveLength(2);
  });

  it("remove deletes one link by (decision_id, target_kind, target_ref, relation)", () => {
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "REFERENCES", created_at: "2026-05-14T10:00:00Z" });
    expect(
      links.remove("d1", "qn", "x", "GOVERNS"),
    ).toBe(true);
    expect(links.findByDecision("d1").map((l) => l.relation)).toEqual(["REFERENCES"]);
  });

  it("CASCADE deletes links when the decision is deleted", () => {
    links.add({ decision_id: "d1", target_kind: "qn", target_ref: "x", relation: "GOVERNS", created_at: "2026-05-14T10:00:00Z" });
    decisions.delete("d1");
    expect(links.findByDecision("d1")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/links-repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/decisions/links-repository.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/links-repository.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/links-repository.ts tests/decisions/links-repository.test.ts
git commit -m "feat(decisions): DecisionLinksRepository over decision_links"
```

---

## Task 5: FTS search wired into `DecisionsRepository`

**Files:**
- Modify: `src/decisions/repository.ts:78-100` (extend the existing class)
- Test: `tests/decisions/repository.test.ts` (extend the existing file)

- [ ] **Step 1: Write the failing test**

Append to `tests/decisions/repository.test.ts`:

```typescript
describe("DecisionsRepository search", () => {
  let root: string;
  let db: Database.Database;
  let repo: DecisionsRepository;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    repo = new DecisionsRepository(db);
    repo.insert({
      id: "d1", title: "Use vitest", description: "vitest is fast.",
      rationale: "Single runner across packages.",
      problem: "Mixed jest/mocha.", resolution: "Convert.",
      alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null,
      created_at: "2026-05-14T10:00:00Z", updated_at: "2026-05-14T10:00:00Z",
    });
    repo.insert({
      id: "d2", title: "Use mimalloc", description: "Replace system malloc.",
      rationale: "Lower RSS, better fragmentation behavior.",
      problem: null, resolution: null,
      alternatives: null, tier: "personal", status: "active",
      superseded_by: null, author: null,
      created_at: "2026-05-14T11:00:00Z", updated_at: "2026-05-14T11:00:00Z",
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("search matches against title", () => {
    const hits = repo.search("vitest");
    expect(hits.map((h) => h.id)).toEqual(["d1"]);
  });

  it("search matches against rationale text", () => {
    const hits = repo.search("fragmentation");
    expect(hits.map((h) => h.id)).toEqual(["d2"]);
  });

  it("search returns empty array on no match", () => {
    expect(repo.search("zzz_no_match")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/repository.test.ts`
Expected: FAIL — `repo.search is not a function`.

- [ ] **Step 3: Implement**

Inside `DecisionsRepository` in `src/decisions/repository.ts`, override `insert` / `update` / `delete` to keep FTS in sync, and add `search`. Replace the existing methods:

```typescript
insert(rec: DecisionRecord): void {
  this.db.transaction(() => {
    this.db
      .prepare(
        `INSERT INTO decisions (${SELECT_COLS}) VALUES
         (@id, @title, @description, @rationale, @problem, @resolution, @alternatives,
          @tier, @status, @superseded_by, @author, @created_at, @updated_at)`,
      )
      .run(rec);
    this.db
      .prepare(
        `INSERT INTO decisions_fts (rowid, title, description, rationale, problem, resolution)
         SELECT rowid, title, description, rationale, problem, resolution FROM decisions WHERE id = ?`,
      )
      .run(rec.id);
  })();
}

update(id: string, patch: DecisionUpdate): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(", ");
  this.db.transaction(() => {
    this.db
      .prepare(`UPDATE decisions SET ${setClause} WHERE id = @id`)
      .run({ ...patch, id });
    this.db
      .prepare(`DELETE FROM decisions_fts WHERE rowid = (SELECT rowid FROM decisions WHERE id = ?)`)
      .run(id);
    this.db
      .prepare(
        `INSERT INTO decisions_fts (rowid, title, description, rationale, problem, resolution)
         SELECT rowid, title, description, rationale, problem, resolution FROM decisions WHERE id = ?`,
      )
      .run(id);
  })();
}

delete(id: string): boolean {
  return this.db.transaction(() => {
    this.db
      .prepare(`DELETE FROM decisions_fts WHERE rowid = (SELECT rowid FROM decisions WHERE id = ?)`)
      .run(id);
    const info = this.db.prepare("DELETE FROM decisions WHERE id = ?").run(id);
    return info.changes > 0;
  })();
}

search(query: string): DecisionRecord[] {
  if (!query.trim()) return [];
  return this.db
    .prepare(
      `SELECT ${SELECT_COLS.split(", ").map((c) => "d." + c).join(", ")}
       FROM decisions d
       JOIN decisions_fts f ON f.rowid = d.rowid
       WHERE decisions_fts MATCH ?
       ORDER BY rank`,
    )
    .all(query) as DecisionRecord[];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/repository.test.ts`
Expected: PASS, 8/8 (all 5 prior + 3 search).

- [ ] **Step 5: Commit**

```bash
git add src/decisions/repository.ts tests/decisions/repository.test.ts
git commit -m "feat(decisions): FTS5 search synced via insert/update/delete"
```

---

## Task 6: Migration from graph DB to decisions.db

**Files:**
- Create: `src/decisions/migration.ts`
- Test: `tests/decisions/migration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/migration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { migrateDecisionsFromGraphDb } from "../../src/decisions/migration.js";

describe("migrateDecisionsFromGraphDb", () => {
  let root: string;
  let graphPath: string;
  let decisionsPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    graphPath = join(root, "graph.db");
    decisionsPath = join(root, "decisions.db");
    const g = new Database(graphPath);
    g.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
        file_path TEXT, data TEXT, tier TEXT, created_at TEXT, updated_at TEXT,
        start_line INTEGER, end_line INTEGER, project TEXT
      );
      CREATE TABLE edges (
        id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT, relation TEXT,
        data TEXT, created_at TEXT, project TEXT
      );
    `);
    g.prepare(
      `INSERT INTO nodes (id, kind, name, data, tier, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "dec-1", "decision", "Use vitest",
      JSON.stringify({
        title: "Use vitest",
        description: "Standardize",
        rationale: "Speed",
        alternatives: [{ name: "jest", reason_rejected: "slow" }],
        status: "active", author: "claude", problem: null, resolution: null,
      }),
      "personal", "2026-05-14T10:00:00Z", "2026-05-14T10:00:00Z",
    );
    g.prepare(
      `INSERT INTO nodes (id, kind, name, file_path) VALUES (?, ?, ?, ?)`,
    ).run("path-1", "path", "foo.ts", "src/foo.ts");
    g.prepare(
      `INSERT INTO edges (id, source_id, target_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("e-1", "dec-1", "path-1", "GOVERNS", "2026-05-14T10:00:00Z");
    g.close();
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("migrates decision nodes + GOVERNS edges into decisions.db", () => {
    const decDb = openDecisionsDb(decisionsPath);
    try {
      const moved = migrateDecisionsFromGraphDb(decDb, graphPath);
      expect(moved.decisions).toBe(1);
      expect(moved.links).toBe(1);

      const decisions = new DecisionsRepository(decDb);
      const got = decisions.get("dec-1");
      expect(got?.title).toBe("Use vitest");
      expect(got?.rationale).toBe("Speed");
      expect(got?.alternatives).toBe(
        JSON.stringify([{ name: "jest", reason_rejected: "slow" }]),
      );

      const links = new DecisionLinksRepository(decDb);
      const lk = links.findByDecision("dec-1");
      expect(lk).toHaveLength(1);
      expect(lk[0].target_kind).toBe("path");
      expect(lk[0].target_ref).toBe("src/foo.ts");
      expect(lk[0].relation).toBe("GOVERNS");
    } finally {
      decDb.close();
    }
  });

  it("is idempotent: second call moves 0 decisions when meta flag is set", () => {
    const decDb = openDecisionsDb(decisionsPath);
    try {
      migrateDecisionsFromGraphDb(decDb, graphPath);
      const second = migrateDecisionsFromGraphDb(decDb, graphPath);
      expect(second.decisions).toBe(0);
      expect(second.links).toBe(0);
    } finally {
      decDb.close();
    }
  });

  it("no-ops gracefully when the graph DB does not exist", () => {
    const decDb = openDecisionsDb(decisionsPath);
    try {
      const moved = migrateDecisionsFromGraphDb(decDb, join(root, "nope.db"));
      expect(moved.decisions).toBe(0);
      expect(moved.links).toBe(0);
    } finally {
      decDb.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/migration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/decisions/migration.ts`:

```typescript
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { DecisionsRepository, DecisionRecord } from "./repository.js";
import { DecisionLinksRepository, TargetKind, Relation } from "./links-repository.js";

const META_KEY = "migrated_from_graph_db";

interface DecisionNodeRow {
  id: string; kind: string; name: string; data: string;
  tier: string; created_at: string; updated_at: string;
}
interface EdgeRow {
  source_id: string; target_id: string; relation: string; created_at: string;
}
interface PathNodeRow { id: string; file_path: string | null; }

const RELATION_TARGET_KIND: Record<string, TargetKind> = {
  GOVERNS: "path",          // overridden below if target is a decision/PR/code QN
  REFERENCES: "qn",
  SUPERSEDES: "decision",
  DECISION_RELATED_TO: "decision",
  DECISION_DEPENDS_ON: "decision",
  PR_INTRODUCES_DECISION: "pr",
  PR_IMPLEMENTS_DECISION: "pr",
  PR_CHALLENGES_DECISION: "pr",
  PR_DISCUSSES_DECISION: "pr",
};

export interface MigrationResult { decisions: number; links: number; }

export function migrateDecisionsFromGraphDb(
  decDb: Database.Database,
  graphDbPath: string,
): MigrationResult {
  if (alreadyMigrated(decDb)) return { decisions: 0, links: 0 };
  if (!existsSync(graphDbPath)) {
    markMigrated(decDb);
    return { decisions: 0, links: 0 };
  }

  const g = new Database(graphDbPath, { readonly: true });
  try {
    const decisionNodes = g
      .prepare(`SELECT id, kind, name, data, tier, created_at, updated_at FROM nodes WHERE kind = 'decision'`)
      .all() as DecisionNodeRow[];

    if (decisionNodes.length === 0) {
      markMigrated(decDb);
      return { decisions: 0, links: 0 };
    }

    const decisions = new DecisionsRepository(decDb);
    const links = new DecisionLinksRepository(decDb);
    let migrated = 0;
    let linkCount = 0;

    decDb.transaction(() => {
      for (const node of decisionNodes) {
        const data = safeParseJson(node.data);
        const rec: DecisionRecord = {
          id: node.id,
          title: data.title ?? node.name ?? "",
          description: data.description ?? null,
          rationale: data.rationale ?? null,
          problem: data.problem ?? null,
          resolution: data.resolution ?? null,
          alternatives: data.alternatives ? JSON.stringify(data.alternatives) : null,
          tier: node.tier ?? "personal",
          status: data.status ?? "active",
          superseded_by: data.superseded_by ?? null,
          author: data.author ?? null,
          created_at: node.created_at ?? new Date().toISOString(),
          updated_at: node.updated_at ?? new Date().toISOString(),
        };
        decisions.insert(rec);
        migrated++;

        const outgoing = g
          .prepare(`SELECT source_id, target_id, relation, created_at FROM edges WHERE source_id = ?`)
          .all(node.id) as EdgeRow[];
        for (const edge of outgoing) {
          const targetKind = resolveTargetKind(g, edge);
          if (!targetKind) continue;
          const targetRef = resolveTargetRef(g, edge, targetKind);
          if (!targetRef) continue;
          links.add({
            decision_id: node.id,
            target_kind: targetKind,
            target_ref: targetRef,
            relation: edge.relation as Relation,
            created_at: edge.created_at ?? rec.created_at,
          });
          linkCount++;
        }
      }
      markMigrated(decDb);
    })();

    return { decisions: migrated, links: linkCount };
  } finally {
    g.close();
  }
}

function alreadyMigrated(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
    .get(META_KEY) as { value: string } | undefined;
  return row?.value === "true";
}

function markMigrated(db: Database.Database): void {
  db.prepare(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)`).run(META_KEY, "true");
}

function safeParseJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}

function resolveTargetKind(g: Database.Database, edge: EdgeRow): TargetKind | null {
  const known = RELATION_TARGET_KIND[edge.relation];
  if (!known) return null;
  if (known === "path") {
    // The target may be a path node, a code qn, or another decision depending
    // on caller intent. Inspect the target node to pick the right kind.
    const target = g
      .prepare(`SELECT kind FROM nodes WHERE id = ?`)
      .get(edge.target_id) as { kind: string } | undefined;
    if (!target) return null;
    if (target.kind === "decision") return "decision";
    if (target.kind === "path") return "path";
    return "qn";
  }
  return known;
}

function resolveTargetRef(g: Database.Database, edge: EdgeRow, kind: TargetKind): string | null {
  if (kind === "decision") return edge.target_id;
  if (kind === "pr") {
    const pr = g
      .prepare(`SELECT data FROM nodes WHERE id = ?`)
      .get(edge.target_id) as { data: string } | undefined;
    if (!pr) return null;
    const parsed = safeParseJson(pr.data);
    const num = parsed.number;
    return typeof num === "number" || typeof num === "string" ? String(num) : null;
  }
  // 'path' and 'qn' targets
  const node = g
    .prepare(`SELECT file_path, qualified_name FROM nodes WHERE id = ?`)
    .get(edge.target_id) as PathNodeRow & { qualified_name: string | null } | undefined;
  if (!node) return null;
  if (kind === "path") return node.file_path ?? null;
  return node.qualified_name ?? node.file_path ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/migration.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/migration.ts tests/decisions/migration.test.ts
git commit -m "feat(decisions): idempotent migration from graph DB to sidecar"
```

---

## Task 7: Refactor `DecisionService` to use the sidecar repositories

**Files:**
- Modify: `src/decisions/service.ts` (whole file)
- Modify: existing decision-service tests to inject the new repositories (if they exist; otherwise skip)

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/service-sidecar.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService over sidecar DB", () => {
  let root: string;
  let db: Database.Database;
  let svc: DecisionService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("create returns a decision with an id", () => {
    const d = svc.create({
      title: "Use vitest",
      description: "Standardize.",
      rationale: "Speed.",
      alternatives: [{ name: "jest", reason_rejected: "slower" }],
    });
    expect(d.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(d.title).toBe("Use vitest");
  });

  it("create + get round-trips", () => {
    const d = svc.create({ title: "t", description: "x", rationale: "y" });
    const got = svc.get(d.id);
    expect(got?.title).toBe("t");
  });

  it("create with governs links populates decision_links", () => {
    const d = svc.create({
      title: "t", description: "x", rationale: "y",
      governs: ["src/foo.ts"],
    });
    const links = new DecisionLinksRepository(db).findByDecision(d.id);
    expect(links).toHaveLength(1);
    expect(links[0].target_kind).toBe("path");
    expect(links[0].target_ref).toBe("src/foo.ts");
    expect(links[0].relation).toBe("GOVERNS");
  });

  it("search hits FTS via DecisionsRepository", () => {
    svc.create({ title: "Use vitest", description: "fast", rationale: "single runner" });
    svc.create({ title: "Use mimalloc", description: "low rss", rationale: "fragmentation" });
    const hits = svc.search("fragmentation");
    expect(hits.map((h) => h.title)).toEqual(["Use mimalloc"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/service-sidecar.test.ts`
Expected: FAIL — `DecisionService` constructor signature mismatch.

- [ ] **Step 3: Implement**

Rewrite `src/decisions/service.ts`. Replace the entire file body — keep the
exported `DecisionService` name, change the constructor and method
implementations to use the repositories:

```typescript
import { randomUUID } from "node:crypto";
import type { Decision, CreateDecisionInput, UpdateDecisionInput, ProposeDecisionInput, SupersedeDecisionInput, DecisionWithRefs } from "./types.js";
import type { EventBus } from "../events/bus.js";
import type { Event } from "../events/types.js";
import { newUlid } from "../events/ulid.js";
import { DecisionsRepository, DecisionRecord } from "./repository.js";
import { DecisionLinksRepository, TargetKind, Relation } from "./links-repository.js";

export interface DecisionServiceDeps {
  decisions: DecisionsRepository;
  links: DecisionLinksRepository;
  bus?: EventBus;
  project_id?: string;
}

export class DecisionService {
  private decisions: DecisionsRepository;
  private links: DecisionLinksRepository;
  private bus: EventBus | undefined;
  private projectId: string;

  constructor(deps: DecisionServiceDeps) {
    this.decisions = deps.decisions;
    this.links = deps.links;
    this.bus = deps.bus;
    this.projectId = deps.project_id ?? "";
  }

  create(input: CreateDecisionInput): Decision {
    const now = new Date().toISOString();
    const id = randomUUID();
    const rec: DecisionRecord = {
      id,
      title: input.title,
      description: input.description ?? null,
      rationale: input.rationale,
      problem: input.problem ?? null,
      resolution: input.resolution ?? null,
      alternatives: input.alternatives ? JSON.stringify(input.alternatives) : null,
      tier: "personal",
      status: "active",
      superseded_by: null,
      author: input.author ?? "claude",
      created_at: now,
      updated_at: now,
    };
    this.decisions.insert(rec);

    if (input.governs) {
      for (const target of input.governs) {
        this.addLink(id, classifyTarget(target), target, "GOVERNS", now);
      }
    }
    if (input.references) {
      for (const ref of input.references) {
        this.addLink(id, classifyTarget(ref), ref, "REFERENCES", now);
      }
    }

    this.emit({
      id: newUlid(),
      kind: "decision.created",
      actor: rec.author ?? "claude",
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: id, title: input.title, rationale: input.rationale, governed_file_ids: input.governs ?? [], tags: [] },
    });

    return toDecision(rec);
  }

  get(id: string): Decision | null {
    const rec = this.decisions.get(id);
    return rec ? toDecision(rec) : null;
  }

  update(id: string, input: UpdateDecisionInput): Decision {
    const existing = this.decisions.get(id);
    if (!existing) throw new Error(`Decision not found: ${id}`);
    const now = new Date().toISOString();
    const patch: Partial<DecisionRecord> = { updated_at: now };
    if (input.title !== undefined) patch.title = input.title;
    if (input.description !== undefined) patch.description = input.description;
    if (input.rationale !== undefined) patch.rationale = input.rationale;
    if (input.alternatives !== undefined)
      patch.alternatives = JSON.stringify(input.alternatives);
    if (input.status !== undefined) patch.status = input.status;
    if (input.superseded_by !== undefined) patch.superseded_by = input.superseded_by;
    if (input.problem !== undefined) patch.problem = input.problem;
    if (input.resolution !== undefined) patch.resolution = input.resolution;
    if (input.author !== undefined) patch.author = input.author;
    this.decisions.update(id, patch);
    return toDecision({ ...existing, ...patch } as DecisionRecord);
  }

  delete(id: string): void {
    if (!this.decisions.delete(id)) throw new Error(`Decision not found: ${id}`);
    this.emit({
      id: newUlid(),
      kind: "decision.deleted",
      actor: "claude",
      created_at: Date.now(),
      project_id: this.projectId,
      payload: { decision_id: id, title: "" },
    });
  }

  search(query: string): Decision[] {
    return this.decisions.search(query).map(toDecision);
  }

  linkGoverns(decisionId: string, target: string): void {
    this.addLink(decisionId, classifyTarget(target), target, "GOVERNS", new Date().toISOString());
  }

  linkReference(decisionId: string, target: string): void {
    this.addLink(decisionId, classifyTarget(target), target, "REFERENCES", new Date().toISOString());
  }

  private addLink(
    decisionId: string, kind: TargetKind, ref: string, relation: Relation, createdAt: string,
  ): void {
    this.links.add({
      decision_id: decisionId, target_kind: kind, target_ref: ref,
      relation, created_at: createdAt,
    });
  }

  private emit(event: Event): void { this.bus?.emit(event); }
}

function classifyTarget(target: string): TargetKind {
  if (target.includes("::") || target.includes(".")) {
    return target.includes("/") ? "path" : "qn";
  }
  return "qn";
}

function toDecision(rec: DecisionRecord): Decision {
  return {
    id: rec.id,
    title: rec.title,
    description: rec.description ?? "",
    rationale: rec.rationale ?? "",
    alternatives: rec.alternatives ? JSON.parse(rec.alternatives) : [],
    tier: rec.tier as Decision["tier"],
    status: rec.status as Decision["status"],
    superseded_by: rec.superseded_by,
    author: rec.author ?? "claude",
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    problem: rec.problem,
    resolution: rec.resolution,
  };
}

// supersede / propose / linkRelatedTo / linkDependsOn / ratify / getWithRefs
// are intentionally omitted from this initial cut and will be ported in
// follow-up tasks (Task 9). Tests that exercise them remain skipped or
// pinned to the old DecisionService until the port lands.
```

(The `supersede`, `propose`, `getWithRefs`, etc. methods will be ported in Task 9; this task ships the core CRUD + search path.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/service-sidecar.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/service.ts tests/decisions/service-sidecar.test.ts
git commit -m "feat(decisions): rewire DecisionService onto sidecar repositories"
```

---

## Task 8: Refactor `DecisionSearch` (`why_was_this_built`) to use links repo

**Files:**
- Modify: `src/decisions/search.ts` (whole file)
- Test: `tests/decisions/search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/search.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionSearch } from "../../src/decisions/search.js";

describe("DecisionSearch.findGoverning", () => {
  let root: string;
  let db: Database.Database;
  let decisions: DecisionsRepository;
  let links: DecisionLinksRepository;
  let search: DecisionSearch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    decisions = new DecisionsRepository(db);
    links = new DecisionLinksRepository(db);
    search = new DecisionSearch(decisions, links);
    const now = "2026-05-14T10:00:00Z";
    decisions.insert({
      id: "d-fn", title: "Function rule", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "active", superseded_by: null, author: null,
      created_at: now, updated_at: now,
    });
    decisions.insert({
      id: "d-file", title: "File rule", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "active", superseded_by: null, author: null,
      created_at: now, updated_at: now,
    });
    decisions.insert({
      id: "d-dir", title: "Dir rule", description: null, rationale: null,
      problem: null, resolution: null, alternatives: null, tier: "personal",
      status: "active", superseded_by: null, author: null,
      created_at: now, updated_at: now,
    });
    links.add({ decision_id: "d-fn", target_kind: "qn", target_ref: "src/foo.ts::bar", relation: "GOVERNS", created_at: now });
    links.add({ decision_id: "d-file", target_kind: "path", target_ref: "src/foo.ts", relation: "GOVERNS", created_at: now });
    links.add({ decision_id: "d-dir", target_kind: "path", target_ref: "src", relation: "GOVERNS", created_at: now });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("returns the function-level rule when given the exact QN", () => {
    const hits = search.findGoverning("src/foo.ts::bar");
    expect(hits.map((d) => d.id)).toEqual(["d-fn"]);
  });

  it("falls back to the file rule when the QN has no direct match", () => {
    const hits = search.findGoverning("src/foo.ts::missing");
    expect(hits.map((d) => d.id)).toEqual(["d-file"]);
  });

  it("walks up directories when no file rule exists", () => {
    const hits = search.findGoverning("src/baz.ts");
    expect(hits.map((d) => d.id)).toEqual(["d-dir"]);
  });

  it("returns empty when nothing governs", () => {
    expect(search.findGoverning("unrelated/path.ts")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/search.test.ts`
Expected: FAIL — class signature mismatch.

- [ ] **Step 3: Implement**

Replace `src/decisions/search.ts`:

```typescript
import { dirname } from "node:path";
import type { Decision } from "./types.js";
import { DecisionsRepository, DecisionRecord } from "./repository.js";
import { DecisionLinksRepository } from "./links-repository.js";

export class DecisionSearch {
  constructor(
    private decisions: DecisionsRepository,
    private links: DecisionLinksRepository,
  ) {}

  /** Return all decisions whose GOVERNS link matches `target` or any of its
   *  ancestor paths. Walks up '/' separators in `target` until a hit lands. */
  findGoverning(target: string): Decision[] {
    // 1. Exact match as qn.
    let hits = this.links.findByTarget("qn", target, "GOVERNS");

    // 2. Exact match as path.
    if (hits.length === 0) hits = this.links.findByTarget("path", target, "GOVERNS");

    // 3. Strip the trailing "::member" if present and try the file portion.
    if (hits.length === 0 && target.includes("::")) {
      const file = target.slice(0, target.indexOf("::"));
      hits = this.links.findByTarget("path", file, "GOVERNS");
    }

    // 4. Walk up directories.
    if (hits.length === 0) {
      let dir = dirname(stripQnMember(target));
      while (dir && dir !== "." && dir !== "/") {
        const dirHits = this.links.findByTarget("path", dir, "GOVERNS");
        if (dirHits.length > 0) { hits = dirHits; break; }
        const next = dirname(dir);
        if (next === dir) break;
        dir = next;
      }
    }

    if (hits.length === 0) return [];
    return hits
      .map((h) => this.decisions.get(h.decision_id))
      .filter((r): r is DecisionRecord => r !== null)
      .map(toDecision);
  }
}

function stripQnMember(target: string): string {
  const i = target.indexOf("::");
  return i === -1 ? target : target.slice(0, i);
}

function toDecision(rec: DecisionRecord): Decision {
  return {
    id: rec.id,
    title: rec.title,
    description: rec.description ?? "",
    rationale: rec.rationale ?? "",
    alternatives: rec.alternatives ? JSON.parse(rec.alternatives) : [],
    tier: rec.tier as Decision["tier"],
    status: rec.status as Decision["status"],
    superseded_by: rec.superseded_by,
    author: rec.author ?? "claude",
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    problem: rec.problem,
    resolution: rec.resolution,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/search.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/search.ts tests/decisions/search.test.ts
git commit -m "feat(decisions): DecisionSearch resolves governance via links repo"
```

---

## Task 9: Port `supersede`, `propose`, and PR helpers onto sidecar repos

**Files:**
- Modify: `src/decisions/service.ts:end` (extend the class)
- Test: `tests/decisions/service-supersede.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/service-supersede.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { DecisionService } from "../../src/decisions/service.js";

describe("DecisionService.supersede / propose", () => {
  let root: string;
  let db: Database.Database;
  let svc: DecisionService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cortex-test-"));
    db = openDecisionsDb(join(root, "decisions.db"));
    svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    });
  });
  afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

  it("supersede creates a new decision, marks old superseded, links SUPERSEDES", () => {
    const original = svc.create({ title: "v1", description: "x", rationale: "y" });
    const replacement = svc.supersede({
      old_decision_id: original.id,
      title: "v2",
      description: "better",
      rationale: "improved",
      alternatives: [],
      resolution: "use v2",
    });
    expect(svc.get(original.id)?.status).toBe("superseded");
    expect(svc.get(original.id)?.superseded_by).toBe(replacement.id);
    const links = new DecisionLinksRepository(db).findByDecision(replacement.id);
    expect(links.find((l) => l.relation === "SUPERSEDES")?.target_ref).toBe(original.id);
  });

  it("propose creates a decision with status='proposed'", () => {
    const d = svc.propose({
      title: "draft", description: "x", rationale: "y", resolution: "z",
    });
    expect(svc.get(d.id)?.status).toBe("proposed");
  });

  it("propose with pr_number adds a PR_INTRODUCES_DECISION link", () => {
    const d = svc.propose({
      title: "draft", description: "x", rationale: "y", resolution: "z",
      pr_number: 42,
    });
    const links = new DecisionLinksRepository(db).findByDecision(d.id);
    expect(links.find((l) => l.relation === "PR_INTRODUCES_DECISION")?.target_ref).toBe("42");
    expect(links.find((l) => l.relation === "PR_INTRODUCES_DECISION")?.target_kind).toBe("pr");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/service-supersede.test.ts`
Expected: FAIL — `svc.supersede` / `svc.propose` not implemented.

- [ ] **Step 3: Implement**

Add the following methods inside `DecisionService` in `src/decisions/service.ts`:

```typescript
supersede(input: SupersedeDecisionInput): Decision {
  const replacement = this.create({
    title: input.title,
    description: input.description,
    rationale: input.rationale,
    alternatives: input.alternatives,
    governs: input.governs,
    references: input.references,
    author: input.author,
    problem: input.problem,
    resolution: input.resolution,
  });
  this.update(input.old_decision_id, {
    status: "superseded",
    superseded_by: replacement.id,
    author: input.author,
  });
  this.links.add({
    decision_id: replacement.id,
    target_kind: "decision",
    target_ref: input.old_decision_id,
    relation: "SUPERSEDES",
    created_at: new Date().toISOString(),
  });
  this.emit({
    id: newUlid(),
    kind: "decision.superseded",
    actor: input.author ?? "claude",
    created_at: Date.now(),
    project_id: this.projectId,
    payload: { old_id: input.old_decision_id, new_id: replacement.id, reason: input.reason ?? "" },
  });
  return replacement;
}

propose(input: ProposeDecisionInput): Decision {
  const now = new Date().toISOString();
  const id = randomUUID();
  const rec: DecisionRecord = {
    id,
    title: input.title,
    description: input.description ?? input.resolution ?? null,
    rationale: input.rationale,
    problem: input.problem ?? null,
    resolution: input.resolution ?? null,
    alternatives: input.alternatives ? JSON.stringify(input.alternatives) : null,
    tier: "personal",
    status: "proposed",
    superseded_by: null,
    author: input.author ?? "claude",
    created_at: now,
    updated_at: now,
  };
  this.decisions.insert(rec);
  for (const target of input.governs ?? []) this.linkGoverns(id, target);
  for (const ref of input.references ?? []) this.linkReference(id, ref);
  if (input.pr_number != null) {
    this.links.add({
      decision_id: id,
      target_kind: "pr",
      target_ref: String(input.pr_number),
      relation: "PR_INTRODUCES_DECISION",
      created_at: now,
    });
  }
  this.emit({
    id: newUlid(),
    kind: "decision.proposed",
    actor: rec.author ?? "claude",
    project_id: this.projectId,
    created_at: Date.now(),
    payload: { decision_id: id, title: input.title, pr_number: input.pr_number ?? null },
  });
  return toDecision(rec);
}

linkRelatedTo(fromId: string, toId: string): void {
  this.links.add({
    decision_id: fromId, target_kind: "decision", target_ref: toId,
    relation: "DECISION_RELATED_TO", created_at: new Date().toISOString(),
  });
}

linkDependsOn(fromId: string, toId: string): void {
  this.links.add({
    decision_id: fromId, target_kind: "decision", target_ref: toId,
    relation: "DECISION_DEPENDS_ON", created_at: new Date().toISOString(),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/decisions/service-supersede.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/decisions/service.ts tests/decisions/service-supersede.test.ts
git commit -m "feat(decisions): port supersede + propose to sidecar service"
```

---

## Task 10: MCP server wiring + cache-survival regression test

**Files:**
- Modify: `src/mcp-server/server.ts` — open `decisions.db` at startup, run migration
- Modify: `src/mcp-server/tools/decision-tools.ts` — inject repositories
- Modify: `src/mcp-server/tools/code-tools.ts:81-114` — call migration before the cache check
- Test: `tests/decisions/cache-survival.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/decisions/cache-survival.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { DecisionsRepository } from "../../src/decisions/repository.js";
import { DecisionService } from "../../src/decisions/service.js";
import { DecisionLinksRepository } from "../../src/decisions/links-repository.js";
import { resolveDecisionsDbPath } from "../../src/db/resolve-path.js";

describe("decisions survive index_repository cache import", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "cortex-cache-survival-"));
    execSync("git init", { cwd: repoDir });
    writeFileSync(join(repoDir, "hello.ts"), 'export const hello = "world";\n');
    execSync("git add -A && git -c user.email=t@t -c user.name=t commit -m 'init'", { cwd: repoDir });
  });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  it("a decision created before index_repository survives a subsequent cache import", () => {
    // 1. Create a decision against the repo via the sidecar DB.
    const decPath = resolveDecisionsDbPath(repoDir);
    const db = openDecisionsDb(decPath);
    const svc = new DecisionService({
      decisions: new DecisionsRepository(db),
      links: new DecisionLinksRepository(db),
    });
    const d = svc.create({ title: "Use vitest", description: "x", rationale: "y" });
    db.close();

    // 2. Simulate the cache-import codepath that previously destroyed decisions:
    //    overwrite <repo>/.cortex/graph.db. The decisions.db is a separate file
    //    and must NOT be touched.
    const cortexDir = join(repoDir, ".cortex");
    writeFileSync(join(cortexDir, "graph.db"), Buffer.from([0x00, 0x01, 0x02]));

    // 3. Re-open decisions.db and confirm the decision is still there.
    const db2 = openDecisionsDb(decPath);
    try {
      const got = new DecisionsRepository(db2).get(d.id);
      expect(got?.title).toBe("Use vitest");
    } finally {
      db2.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/decisions/cache-survival.test.ts`
Expected: PASS (the sidecar already isolates the file). If FAIL, the path
resolution is wrong — investigate before proceeding.

This test pins down the invariant: **decisions.db lives outside the graph DB
file blast radius.**

- [ ] **Step 3: Wire migration into the MCP server entry points**

In `src/mcp-server/server.ts`, where the GraphStore is opened at startup,
also open `decisions.db` and run migration:

```typescript
import { resolveDecisionsDbPath } from "../db/resolve-path.js";
import { openDecisionsDb } from "../decisions/db.js";
import { migrateDecisionsFromGraphDb } from "../decisions/migration.js";
// ...inside the server-construction code, after dbPath is computed:
const decisionsDbPath = resolveDecisionsDbPath(repoPath);
const decisionsDb = openDecisionsDb(decisionsDbPath);
migrateDecisionsFromGraphDb(decisionsDb, dbPath);
// ...pass decisionsDb into the decision-tool registration.
```

In `src/mcp-server/tools/code-tools.ts`, at the very top of the
`index_repository` handler (before computing the cache key), run migration
defensively so a fresh server that starts on a repo with old-style decisions
still preserves them:

```typescript
const decisionsDbPath = resolveDecisionsDbPath(repoPath);
const decDb = openDecisionsDb(decisionsDbPath);
try {
  migrateDecisionsFromGraphDb(decDb, dbPath);
} finally {
  decDb.close();
}
```

In `src/mcp-server/tools/decision-tools.ts`, replace the GraphStore injection
with the two repositories (constructed from the long-lived `decisionsDb`
opened in the server).

- [ ] **Step 4: Run test suite end-to-end**

Run: `npm test`
Expected: all decision tests pass; pre-existing tests still green or pinned
to the legacy code path until Task 11 retires them.

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server/server.ts src/mcp-server/tools/decision-tools.ts \
        src/mcp-server/tools/code-tools.ts tests/decisions/cache-survival.test.ts
git commit -m "feat(decisions): wire sidecar through MCP server + cache-survival test"
```

---

## Task 11: Remove decision_fts and decision-aware logic from `GraphStore`

**Files:**
- Modify: `src/graph/store.ts:55-100` (drop decision FTS schema + sync methods)
- Modify: `src/graph/store.ts:280-320` (drop `indexDecisionContent`, `updateDecisionContent`, `removeDecisionContent`, decision FTS search)
- Test: `tests/graph/store.test.ts` (existing tests for decision logic must be removed or moved to decision tests; if they still exist on the legacy path, gate them off)

- [ ] **Step 1: Identify the lines to remove**

Run: `grep -n "decisions_fts\|indexDecisionContent\|updateDecisionContent\|removeDecisionContent\|searchDecisionContent" src/graph/store.ts`
Read the surrounding context and note every `db.exec(...decisions_fts...)`,
every method that mutates `decisions_fts`, and every test that exercises them.

- [ ] **Step 2: Delete decision-FTS schema setup in `GraphStore` initialization**

Locate the schema-creation block that currently runs `CREATE VIRTUAL TABLE
decisions_fts ...`. Delete the `decisions_fts` CREATE statement and the
migration block that drops/recreates it (around `src/graph/store.ts:58-90`).
New graph DBs no longer carry the table. Existing DBs that already have the
table are unaffected — we just stop writing to it.

- [ ] **Step 3: Delete `indexDecisionContent`, `updateDecisionContent`, `removeDecisionContent`, and the decision-FTS search method**

In `src/graph/store.ts`, remove the four methods and any private helpers that
exist solely to serve them. Update the `GraphStore` class type / interface
declarations to drop these from the public surface.

- [ ] **Step 4: Update tests**

In `tests/graph/store.test.ts`, delete the decision-FTS test cases (they're
now covered by `tests/decisions/repository.test.ts` and friends). If any
tests indirectly call the removed methods, replace them with sidecar-based
equivalents.

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/graph/store.ts tests/graph/store.test.ts
git commit -m "refactor(graph): drop decisions_fts and decision-aware methods (moved to sidecar)"
```

---

## Task 12: Update CLAUDE.md and architecture docs

**Files:**
- Modify: `CLAUDE.md` (add the sidecar-DB note)
- Modify: `docs/architecture/graph-ui.md` if it references decisions
- Create: `docs/architecture/decisions-storage.md` (short one-pager)

- [ ] **Step 1: Add a "Decision storage" section to CLAUDE.md**

After the existing "Decision Awareness" section, add:

```markdown
## Decision storage

Decisions live in `.cortex/decisions.db`, a sibling of the graph DB
(`.cortex/graph.db`). The graph DB is a fully replaceable derived artifact
— `index_repository` cache imports and full reindexes copy or recreate it
freely. The decisions DB is durable: it survives every indexing operation.

Decision links to code use **string qualified-names or file paths**, not
graph node IDs. The DecisionSearch helper walks up the qn/path hierarchy
when no direct link matches.

If you find yourself working in `src/decisions/`, the schema and repositories
live in `src/decisions/db.ts`, `src/decisions/repository.ts`, and
`src/decisions/links-repository.ts`. Migration of legacy graph-DB decisions
is in `src/decisions/migration.ts` and runs idempotently at server startup
and at the top of `index_repository`.
```

- [ ] **Step 2: Create `docs/architecture/decisions-storage.md`**

Write a short one-pager covering: why the sidecar, schema, migration
semantics, how `why_was_this_built` resolves targets. ~150 lines max.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/architecture/decisions-storage.md
git commit -m "docs(decisions): document sidecar DB architecture"
```

---

## Self-Review

- **Spec coverage**: every spec item in the goal/architecture has a task — schema (Task 2), repositories (3, 4, 5), migration (6), service refactor (7, 9), search refactor (8), MCP wiring (10), legacy cleanup (11), docs (12). The cache-survival regression test (Task 10) directly pins Gap 10.
- **Placeholder scan**: every code block contains complete code. No "TBD", "TODO", "implement later", "add error handling" placeholders. Test code is concrete.
- **Type consistency**: `TargetKind`, `Relation`, `DecisionRecord`, `DecisionLink`, `DecisionServiceDeps` are defined once and used identically across all tasks. `classifyTarget()` is the single inferrer used by `create`, `propose`, `linkGoverns`, `linkReference`.
- **Known omissions** (called out, not gaps):
  - `getWithRefs` (rich navigation across PR-decision graph) is not ported in this plan — current uses are limited to the MCP `get_decision` tool which can rebuild the refs via the links repo. A follow-up task can port it if user-visible.
  - Some PR-related decision-side events are emitted by `src/prs/service.ts`; that file isn't touched here, the inputs only flow inward via `propose({ pr_number })`. If a PR tool emits `PR_*_DECISION` edges directly into the graph store today, that flow needs its own follow-up.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-decisions-sidecar-db.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

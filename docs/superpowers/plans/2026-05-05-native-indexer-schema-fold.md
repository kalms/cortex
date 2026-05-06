# Native Indexer Schema Fold — Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold `cbm_nodes` / `cbm_edges` into Cortex's `nodes` / `edges` (with `kind` as the discriminator) and rename the indexer's bookkeeping tables `cbm_*` → `ctx_*`. After this lands, a single `SELECT … FROM nodes` returns code entities, decisions, PRs, and TODOs as one graph.

**Architecture:** Cortex's TS-side adds new columns to `nodes`/`edges`, runs a one-shot transactional migration that copies `cbm_nodes` → `nodes` (with `LOWER(label)` → `kind`, `'ctx-' || id` ID format) and `cbm_edges` → `edges`, drops the old tables, and renames the surviving bookkeeping tables. The indexer's C-side is updated in lockstep to write `nodes`/`edges` directly with the new column names. Cortex owns the `nodes`/`edges` schema; the indexer owns `ctx_projects` / `ctx_file_hashes` / `ctx_project_summaries` / `ctx_nodes_fts`.

**Tech Stack:** TypeScript (Node 20+), better-sqlite3, vitest, MCP SDK. C (CBM indexer in `internal/cbm/`). SQLite WAL mode, FTS5.

**Spec:** [docs/superpowers/specs/2026-05-04-native-indexer-schema-fold-design.md](../specs/2026-05-04-native-indexer-schema-fold-design.md)

---

## Branch

Continues on `feature/db/native-indexer-schema-fold` (branched from `main` after Phase 3b merged). Each task ends in a commit. After all tasks, tag `phase-4-schema-fold`.

## Current state at branch start

| Surface | State |
|---|---|
| `cortex.db` | One file at `<install>/.cortex/graph.db`. Contains: `nodes`, `edges`, `edge_annotations`, `decisions_fts`, `cbm_projects`, `cbm_file_hashes`, `cbm_nodes`, `cbm_edges`, `cbm_project_summaries`, `cbm_nodes_fts`. |
| `bin/cortex-indexer` | Writes `cbm_*`-prefixed tables; honors `CORTEX_DB` env var. Built from `internal/cbm/` via `npm install`. |
| `src/graph/store.ts` | `getAllNodesUnified(cbmProject?)` queries `cbm_nodes` for code rows, `nodes` for Cortex rows, merges. CBM_LABEL_MAP collapses `function`/`method`/`class`/etc. to `function`/`component`/`path`. |
| `src/graph/code-queries.ts` | `searchGraph` / `tracePath` / `getGraphSchema` query `cbm_nodes` / `cbm_edges`. `listProjects` / `indexStatus` query `cbm_projects`. |
| `src/index.ts` | Resolves `cbmProject` via `SELECT name FROM cbm_projects WHERE root_path = ?`. |
| `src/mcp-server/tools/code-tools.ts` | Inline SQL: `FROM cbm_nodes` (for `search_code` enrichment); `FROM cbm_projects` (for `get_code_snippet`). Tool contract has `label` parameter on `search_graph`. |
| Test count | 49 test files, 361 passed / 1 skipped on `main`. Contract suite green. |
| C-side | 111 references to `cbm_<table>` across `internal/cbm/src/store/store.c` (92), `internal/cbm/src/mcp/mcp.c` (6), `internal/cbm/src/pipeline/pipeline.c` (5), `internal/cbm/src/pipeline/pipeline_incremental.c` (5), `internal/cbm/src/graph_buffer/graph_buffer.c` (3). |

---

## Task 4.1 — Add code-entity columns and indexes to `schema.ts`

**Files:**
- Modify: `src/graph/schema.ts`

**Goal:** Fresh DBs created via `new GraphStore(path)` get `nodes.start_line`, `nodes.end_line`, `nodes.project`, `edges.project` columns and the new indexes. Existing DBs are unchanged here (Task 4.2's migration handles `ALTER`).

- [ ] **Step 1: Read the current schema**

```bash
cat src/graph/schema.ts
```

Expected: 48 lines defining `CREATE_TABLES`, `CREATE_INDEXES`, `CREATE_FTS`. `nodes` has `id, kind, name, qualified_name, file_path, data, tier, created_at, updated_at`. `edges` has `id, source_id, target_id, relation, data, created_at`.

- [ ] **Step 2: Update `CREATE_TABLES` to add the new columns**

Replace the `nodes` and `edges` `CREATE TABLE` blocks in `src/graph/schema.ts`:

```typescript
export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  qualified_name TEXT,
  file_path   TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  tier        TEXT NOT NULL DEFAULT 'personal',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  start_line  INTEGER,
  end_line    INTEGER,
  project     TEXT
);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  project     TEXT
);

CREATE TABLE IF NOT EXISTS edge_annotations (
  id          TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  edge_id     TEXT NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL
);
`;
```

- [ ] **Step 3: Leave `CREATE_INDEXES` UNCHANGED in this task**

The three new compound indexes referencing the `project` column (`idx_nodes_kind_project`, `idx_nodes_kind_file`, `idx_edges_project_relation`) are **deferred to Task 4.2**. Adding them to `CREATE_INDEXES` here would error on legacy DBs that don't yet have the `project` column — `CREATE INDEX IF NOT EXISTS` validates column references regardless of the `IF NOT EXISTS` clause. Task 4.2's `migrateSchemaFold()` will:

1. ALTER TABLE to add the new columns onto legacy DBs
2. Create the three new compound indexes (which now reference existing columns)
3. Append those three index definitions to `CREATE_INDEXES` in `schema.ts` so fresh DBs get them too on next open

Leave `CREATE_INDEXES` exactly as it is in this task. Only `CREATE_TABLES` changes.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0, no output.

- [ ] **Step 5: Run the full test suite**

Run: `npm test 2>&1 | tail -5`
Expected: 49 test files green, 361 passed / 1 skipped. The new columns are nullable and unused so far; existing tests are unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/graph/schema.ts
git commit -m "$(cat <<'EOF'
feat(schema): add code-entity columns and indexes to nodes/edges

Adds three nullable columns to nodes (start_line, end_line, project)
and one to edges (project), plus two compound indexes
(idx_nodes_kind_project, idx_nodes_kind_file, idx_edges_project_relation)
needed by the upcoming schema fold.

Fresh DBs get the right shape from CREATE TABLE IF NOT EXISTS.
Existing DBs are unchanged at this commit — Task 4.2's migration
runner handles the ALTER on legacy tables.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4.2 — TS migration runner: cbm_* → nodes/edges + ctx_* renames

**Files:**
- Modify: `src/graph/store.ts`
- Modify: `src/graph/schema.ts` (add the three deferred compound indexes to `CREATE_INDEXES`)
- Create: `tests/graph/schema-fold-migration.test.ts`

**Goal:** When `GraphStore` opens a DB that has `cbm_nodes` (a v0.3-Phase-3b shape), run a one-shot transactional migration: ALTER nodes/edges, copy `cbm_nodes` → `nodes`, copy `cbm_edges` → `edges`, drop old data tables, rename bookkeeping tables, rebuild FTS. Idempotent (probe-based). Also adds the three compound indexes (`idx_nodes_kind_project`, `idx_nodes_kind_file`, `idx_edges_project_relation`) deferred from Task 4.1 — to `CREATE_INDEXES` in `schema.ts`. Reorders `migrate()` so the migration runs before `CREATE_INDEXES`, so fresh-and-legacy DBs both arrive at the same final shape.

**Migrate() order:** the plan in Step 4 below changes `GraphStore.migrate()` from `[CREATE_TABLES, CREATE_INDEXES, migrateFts, CREATE_FTS]` to `[CREATE_TABLES, migrateSchemaFold, CREATE_INDEXES, migrateFts, CREATE_FTS]`. The migration runs **before** index creation so legacy DBs ALTER their columns into existence before any index references them. Fresh DBs see migrateSchemaFold's probe return early (no cbm_nodes), then CREATE_INDEXES creates all indexes against columns that already exist via CREATE_TABLES.

**Note:** This task lands the migration code but the contract test suite **fails at the end of this commit** because the migration runs but `code-queries.ts` (Task 4.3) still queries `cbm_nodes`. That's intentional — Task 4.3 closes the gap.

### Step 1: Write a failing test for the migration

- [ ] **Step 1: Create the test file**

Create `tests/graph/schema-fold-migration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { GraphStore } from "../../src/graph/store.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_SRC = join(REPO_ROOT, "tests", "fixtures", "sample-project");
const BINARY = join(REPO_ROOT, "bin", "cortex-indexer");

describe("schema fold migration: cbm_* → nodes/edges + ctx_*", () => {
  let workDir: string;
  let cortexDbPath: string;

  beforeAll(() => {
    if (!existsSync(BINARY)) {
      throw new Error("bin/cortex-indexer not found — run npm install first");
    }
    workDir = mkdtempSync(join(tmpdir(), "cortex-schema-fold-"));
    const fixture = join(workDir, "sample-project");
    cpSync(FIXTURE_SRC, fixture, { recursive: true });

    cortexDbPath = resolve(join(workDir, "cortex.db"));

    // Run the indexer to populate cbm_* tables (the pre-Phase-4 shape).
    execFileSync(BINARY, ["cli", "index_repository", JSON.stringify({ repo_path: fixture })], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      env: { ...process.env, CORTEX_DB: cortexDbPath },
    });
  }, 60_000);

  afterAll(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("opening GraphStore on a cbm_* populated DB runs the migration", () => {
    // Pre-state: cbm_nodes and cbm_edges exist with rows.
    const pre = new Database(cortexDbPath, { readonly: true });
    const cbmNodeCount = (pre.prepare("SELECT COUNT(*) AS c FROM cbm_nodes").get() as { c: number }).c;
    const cbmEdgeCount = (pre.prepare("SELECT COUNT(*) AS c FROM cbm_edges").get() as { c: number }).c;
    pre.close();
    expect(cbmNodeCount).toBeGreaterThan(0);
    expect(cbmEdgeCount).toBeGreaterThan(0);

    // Trigger migration by opening GraphStore.
    const store = new GraphStore(cortexDbPath);

    // Post-state: cbm_nodes / cbm_edges are gone; data lives in nodes / edges.
    const tables = store.listTables();
    expect(tables).not.toContain("cbm_nodes");
    expect(tables).not.toContain("cbm_edges");

    // Bookkeeping tables renamed.
    expect(tables).toContain("ctx_projects");
    expect(tables).toContain("ctx_file_hashes");
    expect(tables).toContain("ctx_project_summaries");
    expect(tables).not.toContain("cbm_projects");
    expect(tables).not.toContain("cbm_file_hashes");
    expect(tables).not.toContain("cbm_project_summaries");

    // Migrated rows have ctx- prefix and live in nodes/edges.
    const migratedNodes = store
      .queryRaw<{ c: number }>("SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%'")[0].c;
    const migratedEdges = store
      .queryRaw<{ c: number }>("SELECT COUNT(*) AS c FROM edges WHERE id LIKE 'ctx-e%'")[0].c;

    expect(migratedNodes).toBe(cbmNodeCount);
    expect(migratedEdges).toBe(cbmEdgeCount);

    // Migrated nodes have lowercase kinds (no uppercase Class/Function/etc.).
    const kinds = store.queryRaw<{ kind: string }>(
      "SELECT DISTINCT kind FROM nodes WHERE id LIKE 'ctx-%'"
    );
    for (const row of kinds) {
      expect(row.kind).toBe(row.kind.toLowerCase());
    }

    // Code rows have non-null project.
    const nullProjectCount = store.queryRaw<{ c: number }>(
      "SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%' AND project IS NULL"
    )[0].c;
    expect(nullProjectCount).toBe(0);

    store.close();
  });

  it("opening GraphStore again is a no-op (idempotent)", () => {
    // Already migrated above. Open again; should not throw or change row counts.
    const store1 = new GraphStore(cortexDbPath);
    const before = store1.queryRaw<{ c: number }>(
      "SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%'"
    )[0].c;
    store1.close();

    const store2 = new GraphStore(cortexDbPath);
    const after = store2.queryRaw<{ c: number }>(
      "SELECT COUNT(*) AS c FROM nodes WHERE id LIKE 'ctx-%'"
    )[0].c;
    store2.close();

    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: Run the new test — verify it fails**

Run: `npm test -- tests/graph/schema-fold-migration.test.ts 2>&1 | tail -25`
Expected: FAIL. The migration method doesn't exist yet, so `cbm_nodes` is still present after `new GraphStore(cortexDbPath)`. Assertions like `expect(tables).not.toContain("cbm_nodes")` fail.

### Step 2: Implement `migrateSchemaFold()` in `store.ts`

- [ ] **Step 3: Read current `migrate()` method**

Run: `sed -n '40,100p' src/graph/store.ts`
Expected: shows the constructor, `migrate()`, and the existing `migrateFts()` helper.

- [ ] **Step 4: Add the deferred indexes to `CREATE_INDEXES` in `schema.ts`**

In `src/graph/schema.ts`, add three lines to `CREATE_INDEXES`:

```typescript
export const CREATE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_tier ON nodes(tier);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_relation ON edges(relation);
CREATE INDEX IF NOT EXISTS idx_nodes_kind_project ON nodes(kind, project);
CREATE INDEX IF NOT EXISTS idx_nodes_kind_file ON nodes(kind, file_path);
CREATE INDEX IF NOT EXISTS idx_edges_project_relation ON edges(project, relation);
`;
```

These now reference the `project` column added in Task 4.1's `CREATE_TABLES` (fresh DBs) and added in this task's `migrateSchemaFold()` via ALTER (legacy DBs). The index creation runs after `migrateSchemaFold()` per the new `migrate()` order (next step), so columns are guaranteed to exist on both paths.

- [ ] **Step 5: Rewire `migrate()` order in `store.ts`**

In `src/graph/store.ts`, modify the `migrate()` method to call `migrateSchemaFold()` **before** `CREATE_INDEXES`. The migrate method becomes:

```typescript
private migrate(): void {
  this.db.exec(CREATE_TABLES);
  this.migrateSchemaFold();
  this.db.exec(CREATE_INDEXES);
  this.migrateFts();
  this.db.exec(CREATE_FTS);
}
```

The order matters: `migrateSchemaFold()` ALTERs the `project` column onto legacy DBs **before** `CREATE_INDEXES` tries to create indexes that reference that column. Fresh DBs see the migration probe return early (no `cbm_nodes`), then `CREATE_INDEXES` creates all indexes against columns that already exist from `CREATE_TABLES`.

Add the new `migrateSchemaFold` method directly after `migrateFts` (around line 99, before `listTables`):

```typescript
/**
 * Phase 4 schema fold: cbm_nodes/cbm_edges → nodes/edges with kind discriminator.
 *
 * Idempotent: probes for `cbm_nodes` table; returns early if migration is done.
 * Runs the full data-copy + table-drop + bookkeeping-rename + FTS-rebuild
 * sequence in a single transaction with FK enforcement off, so cascade-deletes
 * during the cross-table copy don't fire.
 */
private migrateSchemaFold(): void {
  const cbmNodesExists = this.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cbm_nodes'")
    .get() as { name?: string } | undefined;
  if (!cbmNodesExists?.name) return; // already migrated, or fresh DB

  // FK off for the duration: we DROP cbm_nodes after copying, and we don't want
  // ON DELETE CASCADE to wipe cbm_edges before we've copied them.
  this.db.pragma("foreign_keys = OFF");

  try {
    const tx = this.db.transaction(() => {
      // 1. ALTER nodes/edges to add new columns if they don't exist yet.
      // SQLite ALTER TABLE ADD COLUMN doesn't support IF NOT EXISTS — must probe.
      const nodeCols = (this.db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>)
        .map((r) => r.name);
      if (!nodeCols.includes("start_line")) this.db.exec("ALTER TABLE nodes ADD COLUMN start_line INTEGER");
      if (!nodeCols.includes("end_line"))   this.db.exec("ALTER TABLE nodes ADD COLUMN end_line INTEGER");
      if (!nodeCols.includes("project"))    this.db.exec("ALTER TABLE nodes ADD COLUMN project TEXT");

      const edgeCols = (this.db.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string }>)
        .map((r) => r.name);
      if (!edgeCols.includes("project")) this.db.exec("ALTER TABLE edges ADD COLUMN project TEXT");

      // Indexes (CREATE INDEX IF NOT EXISTS already handles idempotency)
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_kind_project ON nodes(kind, project);
        CREATE INDEX IF NOT EXISTS idx_nodes_kind_file ON nodes(kind, file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_project_relation ON edges(project, relation);
      `);

      // 2. Copy cbm_edges → edges. Done before nodes (logical, not strictly
      // required since FK is off).
      this.db.exec(`
        INSERT INTO edges (id, source_id, target_id, relation, data, created_at, project)
        SELECT
          'ctx-e' || CAST(id AS TEXT),
          'ctx-' || CAST(source_id AS TEXT),
          'ctx-' || CAST(target_id AS TEXT),
          type,
          properties,
          (SELECT indexed_at FROM cbm_projects WHERE name = cbm_edges.project),
          project
        FROM cbm_edges
      `);

      // 3. Copy cbm_nodes → nodes.
      this.db.exec(`
        INSERT INTO nodes (
          id, kind, name, qualified_name, file_path, data, tier,
          created_at, updated_at, start_line, end_line, project
        )
        SELECT
          'ctx-' || CAST(id AS TEXT),
          LOWER(label),
          name, qualified_name, file_path,
          properties,
          'shared',
          (SELECT indexed_at FROM cbm_projects WHERE name = cbm_nodes.project),
          (SELECT indexed_at FROM cbm_projects WHERE name = cbm_nodes.project),
          start_line, end_line, project
        FROM cbm_nodes
      `);

      // 4. Drop old data tables.
      this.db.exec("DROP TABLE cbm_edges");
      this.db.exec("DROP TABLE cbm_nodes");

      // 5. Rename bookkeeping tables.
      this.db.exec("ALTER TABLE cbm_projects RENAME TO ctx_projects");
      this.db.exec("ALTER TABLE cbm_file_hashes RENAME TO ctx_file_hashes");
      this.db.exec("ALTER TABLE cbm_project_summaries RENAME TO ctx_project_summaries");

      // 6. FTS5 rebuild — virtual tables can't be ALTER RENAME'd.
      this.db.exec("DROP TABLE IF EXISTS cbm_nodes_fts");
      this.db.exec(`
        CREATE VIRTUAL TABLE ctx_nodes_fts USING fts5(
          name, qualified_name, kind, file_path,
          content='',
          tokenize='unicode61 remove_diacritics 2'
        )
      `);
      this.db.exec(`
        INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path)
        SELECT rowid, name, qualified_name, kind, file_path
        FROM nodes WHERE id LIKE 'ctx-%'
      `);
    });
    tx();
  } finally {
    this.db.pragma("foreign_keys = ON");
  }
}
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 7: Run the new migration test — verify it now passes**

Run: `npm test -- tests/graph/schema-fold-migration.test.ts 2>&1 | tail -15`
Expected: PASS. Both `it()` blocks pass.

- [ ] **Step 8: Run the full test suite**

Run: `npm test 2>&1 | tail -10`
Expected: schema-fold-migration test passes; **mcp-contract suite fails** (expected — code-queries.ts still queries `cbm_nodes` which the migration just dropped). Approximately 14-19 contract failures, plus the schema-fold-migration tests passing.

- [ ] **Step 9: Commit**

```bash
git add src/graph/store.ts src/graph/schema.ts tests/graph/schema-fold-migration.test.ts
git commit -m "$(cat <<'EOF'
feat(graph): add Phase 4 schema fold migration runner

GraphStore.migrateSchemaFold() probes for the legacy cbm_nodes table
and, if present, runs a one-shot atomic migration:

- ALTER TABLE nodes/edges to add code-entity columns (probe-based
  idempotency since SQLite ALTER doesn't support IF NOT EXISTS)
- INSERT INTO nodes/edges SELECT FROM cbm_nodes/cbm_edges with the
  documented column mapping (label → LOWER(kind), properties → data,
  type → relation, integer ids → 'ctx-<int>' / 'ctx-e<int>' text ids)
- DROP cbm_nodes, cbm_edges
- RENAME cbm_projects/cbm_file_hashes/cbm_project_summaries to ctx_*
- Drop cbm_nodes_fts, recreate as ctx_nodes_fts, repopulate

PRAGMA foreign_keys = OFF wraps the whole sequence so cascade-deletes
on cbm_nodes drop don't fire prematurely. Single transaction with
BEGIN IMMEDIATE for atomicity.

New tests/graph/schema-fold-migration.test.ts verifies post-migration
shape and idempotency.

Tests fail at this commit — code-queries.ts still queries cbm_nodes
(now dropped). Task 4.3 closes the gap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4.3 — TS query simplification

**Files:**
- Modify: `src/graph/store.ts` (drop CBM_LABEL_MAP; simplify `getAllNodesUnified`/`getAllEdgesUnified`)
- Modify: `src/graph/code-queries.ts` (rewrite SQL: cbm_nodes/cbm_edges → nodes/edges with kind/relation/data field names; cbm_projects → ctx_projects)
- Modify: `src/index.ts` (cbm_projects → ctx_projects)
- Modify: `src/mcp-server/tools/code-tools.ts` (inline SQL: cbm_nodes → nodes, cbm_projects → ctx_projects; LOWER() on label parameter; output field names)

**Goal:** Cortex's TS reads from `nodes`/`edges` directly with `WHERE project = ?` filtering and `kind`/`relation`/`data` field names. Contract suite passes again.

### Step 1: Update `store.ts`

- [ ] **Step 1: Read the current state**

Run: `grep -n "CBM_LABEL_MAP\|getAllNodesUnified\|getAllEdgesUnified" src/graph/store.ts`
Expected: lines around 334-394 cover the label map and unified getters.

- [ ] **Step 2: Delete `CBM_LABEL_MAP` and simplify `getAllNodesUnified`/`getAllEdgesUnified`**

In `src/graph/store.ts`, replace the section from `CBM_LABEL_MAP` through the end of `getAllEdgesUnified` (currently around lines 333-394) with:

```typescript
  /**
   * Return all nodes (decision/PR/TODO/code-entity), optionally filtered to a project.
   *
   * After Phase 4, code rows live in `nodes` directly with `kind` discriminator —
   * no CBM_LABEL_MAP collapse, no separate cbm_nodes table. Decision/PR/TODO rows
   * have project=NULL; code rows have project=<name>. Passing a project filter
   * drops decision rows; omitting it returns all rows.
   */
  getAllNodesUnified(project?: string | string[]): NodeRow[] {
    if (!project) return this.getAllNodes();

    if (Array.isArray(project)) {
      if (project.length === 0) return this.getAllNodes();
      const placeholders = project.map(() => "?").join(", ");
      return this.db
        .prepare(`SELECT * FROM nodes WHERE project IN (${placeholders}) OR project IS NULL`)
        .all(...project) as NodeRow[];
    }

    return this.db
      .prepare("SELECT * FROM nodes WHERE project = ? OR project IS NULL")
      .all(project) as NodeRow[];
  }

  /**
   * Return all edges (governance + code-graph), optionally filtered to a project.
   *
   * After Phase 4, code edges live in `edges` directly with project denormalized.
   * Governance edges (GOVERNS, SUPERSEDES, ...) have project=NULL — they're
   * cross-cutting. Passing a project filter returns code-edges for that project
   * plus all governance edges; omitting it returns everything.
   */
  getAllEdgesUnified(project?: string | string[]): EdgeRow[] {
    if (!project) return this.getAllEdges();

    if (Array.isArray(project)) {
      if (project.length === 0) return this.getAllEdges();
      const placeholders = project.map(() => "?").join(", ");
      return this.db
        .prepare(`SELECT * FROM edges WHERE project IN (${placeholders}) OR project IS NULL`)
        .all(...project) as EdgeRow[];
    }

    return this.db
      .prepare("SELECT * FROM edges WHERE project = ? OR project IS NULL")
      .all(project) as EdgeRow[];
  }
}
```

The trailing `}` closes the `GraphStore` class.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: errors in callers (`index.ts`, `code-queries.ts`, `code-tools.ts`) referencing the old field names — these get fixed in subsequent steps.

### Step 2: Rewrite `code-queries.ts`

- [ ] **Step 4: Read current state**

Run: `cat src/graph/code-queries.ts`
Expected: 5 exported functions querying `cbm_nodes`/`cbm_edges`/`cbm_projects` with `label`/`type`/`properties` columns, returning rows with shape `CbmNode { id, project, label, name, qualified_name, file_path, start_line, end_line, properties }`.

- [ ] **Step 5: Rewrite the file**

Replace the contents of `src/graph/code-queries.ts` with:

```typescript
import { GraphStore } from "./store.js";

/**
 * After Phase 4, code-entity rows live in `nodes` with `kind` as discriminator.
 * The TS-side type used by code-tools.ts and tests keeps the field name `kind`
 * (matching the storage column), `relation` for edges, `data` for the JSON blob.
 *
 * Type name `CbmNode` is preserved through Phase 4 for diff continuity; Phase 8
 * cleanup renames to `IndexerNode`.
 */
export interface CbmNode {
  id: string;
  project: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  data: string;
}

export interface CbmEdge {
  id: string;
  project: string;
  source_id: string;
  target_id: string;
  relation: string;
  data: string;
}

export interface CbmProject {
  name: string;
  indexed_at: string;
  root_path: string;
}

const CODE_KIND_FILTER = "kind NOT IN ('decision', 'pr', 'todo')";

export function searchGraph(
  store: GraphStore,
  project: string,
  params: { name_pattern?: string; label?: string; qn_pattern?: string }
): CbmNode[] {
  const conditions: string[] = ["project = ?", CODE_KIND_FILTER];
  const values: unknown[] = [project];

  if (params.name_pattern) {
    conditions.push("name LIKE ?");
    values.push(`%${params.name_pattern}%`);
  }
  if (params.label) {
    // The tool's input parameter is named `label` for backwards compatibility,
    // but the storage column is `kind`. Lowercase the value to match the
    // post-Phase-4 lowercase-kind convention.
    conditions.push("kind = ?");
    values.push(params.label.toLowerCase());
  }
  if (params.qn_pattern) {
    conditions.push("qualified_name LIKE ?");
    values.push(params.qn_pattern);
  }

  return store.queryRaw<CbmNode>(
    `SELECT * FROM nodes WHERE ${conditions.join(" AND ")} LIMIT 100`,
    values
  );
}

export function getGraphSchema(
  store: GraphStore,
  project: string
): { labels: Array<{ name: string; count: number }>; edgeTypes: Array<{ name: string; count: number }> } {
  const labels = store.queryRaw<{ name: string; count: number }>(
    `SELECT kind AS name, COUNT(*) AS count FROM nodes
     WHERE project = ? AND ${CODE_KIND_FILTER}
     GROUP BY kind ORDER BY name`,
    [project]
  );

  const edgeTypes = store.queryRaw<{ name: string; count: number }>(
    "SELECT relation AS name, COUNT(*) AS count FROM edges WHERE project = ? GROUP BY relation ORDER BY name",
    [project]
  );

  return { labels, edgeTypes };
}

export function tracePath(
  store: GraphStore,
  project: string,
  params: { function_name: string; mode: string; max_depth?: number }
): Array<{ node: CbmNode; depth: number }> {
  const startNodes = store.queryRaw<CbmNode>(
    `SELECT * FROM nodes WHERE project = ? AND name = ? AND ${CODE_KIND_FILTER} LIMIT 1`,
    [project, params.function_name]
  );
  if (startNodes.length === 0) return [];

  const startId = startNodes[0].id;
  const direction = params.mode === "callers" ? "inbound" : "outbound";
  const maxDepth = params.max_depth ?? 3;

  const recursive =
    direction === "outbound"
      ? "SELECT e.target_id, t.depth + 1 FROM edges e JOIN trace t ON e.source_id = t.node_id"
      : "SELECT e.source_id, t.depth + 1 FROM edges e JOIN trace t ON e.target_id = t.node_id";

  const sql = `WITH RECURSIVE trace(node_id, depth) AS (
    SELECT ?, 0
    UNION ALL
    ${recursive}
    WHERE e.project = ? AND e.relation IN ('CALLS', 'IMPORTS') AND t.depth < ?
  )
  SELECT n.*, MIN(t.depth) AS depth FROM nodes n
  JOIN trace t ON n.id = t.node_id
  WHERE n.id != ? AND n.project = ? AND ${CODE_KIND_FILTER}
  GROUP BY n.id
  ORDER BY depth, n.name`;

  const rows = store.queryRaw<CbmNode & { depth: number }>(sql, [
    startId, project, maxDepth, startId, project,
  ]);
  return rows.map(({ depth, ...node }) => ({ node, depth: depth as number }));
}

export function listProjects(store: GraphStore): CbmProject[] {
  return store.queryRaw<CbmProject>("SELECT * FROM ctx_projects");
}

export function indexStatus(store: GraphStore, rootPath: string): CbmProject | null {
  const results = store.queryRaw<CbmProject>(
    "SELECT * FROM ctx_projects WHERE root_path = ?",
    [rootPath]
  );
  return results[0] ?? null;
}
```

### Step 3: Update `index.ts`

- [ ] **Step 6: Update startup query**

In `src/index.ts`, find the line querying `cbm_projects`:

```typescript
"SELECT name FROM cbm_projects WHERE root_path = ? LIMIT 1",
```

Replace with:

```typescript
"SELECT name FROM ctx_projects WHERE root_path = ? LIMIT 1",
```

Also update the catch error message from "no such table: cbm_projects" expectations to "no such table" (still matches via the regex since the regex is case-insensitive and just looks for "no such table"). The regex on line 42 already catches both names — verify no change needed:

Run: `grep -n "no such table\|cbm_projects\|ctx_projects" src/index.ts`
Expected: `cbm_projects` reference is gone, replaced with `ctx_projects`. The `no such table` regex on the catch block still matches (it's name-agnostic).

### Step 4: Update `code-tools.ts`

- [ ] **Step 7: Update inline SQL**

In `src/mcp-server/tools/code-tools.ts`, find the two inline SQL queries that reference `cbm_nodes` and `cbm_projects`:

The query inside `get_code_snippet` (around line 152):
```typescript
"SELECT root_path FROM cbm_projects WHERE name = ?",
```
Replace with:
```typescript
"SELECT root_path FROM ctx_projects WHERE name = ?",
```

The query inside `search_code` enrichment (around lines 279-282):
```typescript
`SELECT * FROM cbm_nodes
 WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
 ORDER BY (end_line - start_line) ASC LIMIT 1`,
```
Replace with:
```typescript
`SELECT * FROM nodes
 WHERE project = ? AND file_path = ? AND start_line <= ? AND end_line >= ?
   AND kind NOT IN ('decision', 'pr', 'todo')
 ORDER BY (end_line - start_line) ASC LIMIT 1`,
```

Also the line that formats the enriched output (around line 285) reads `enclosing[0].label` — change to `enclosing[0].kind`:
```typescript
return `${line}  // in ${enclosing[0].kind} ${denormalize(enclosing[0].qualified_name, enclosing[0].file_path)}`;
```

The same formatNodes helper at line 52-56 reads `n.label` — change to `n.kind`:
```typescript
function formatNodes(nodes: CbmNode[]): string {
  if (nodes.length === 0) return "";
  return nodes
    .map((n) => `${n.kind} ${denormalize(n.qualified_name, n.file_path)} (${n.file_path}:${n.start_line}-${n.end_line})`)
    .join("\n");
}
```

The `trace_path` formatter (around line 122) also reads `r.node.label` — change to `r.node.kind`:
```typescript
const lines = results.map((r) =>
  `[d=${r.depth}] ${r.node.kind} ${denormalize(r.node.qualified_name, r.node.file_path)} (${r.node.file_path}:${r.node.start_line}-${r.node.end_line})`
);
```

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: exit 0, no errors.

- [ ] **Step 9: Verify nothing else references old SQL/columns**

Run: `grep -rn "cbm_nodes\|cbm_edges\|cbm_projects\|cbm_file_hashes\|cbm_project_summaries\|cbm_nodes_fts" src/ 2>&1 | grep -v "cbm-discovery"`
Expected: no matches (excluding `cbm-discovery.ts` which is preserved for Phase 5 and references the *external* legacy DB).

Run: `grep -rn "\.label\b" src/graph/ src/mcp-server/tools/code-tools.ts 2>&1`
Expected: no matches reading `.label` from a CbmNode (we've renamed to `.kind`).

### Step 5: Run the full test suite

- [ ] **Step 10: Run all tests**

Run: `npm test 2>&1 | tail -10`
Expected: 49 test files green. The migration runs against the indexer-populated DB, then queries hit the migrated nodes/edges. Contract suite passes again. Total: ~363 passed / 1 skipped (counts +schema-fold-migration tests).

If any contract test fails:
- Read the assertion. If it's about a test that asserts uppercase label values like `"Function"` or `"Class"` — those are caught by Task 4.5 (test updates). Skip ahead to Task 4.5 if needed; otherwise leave them as known failures and continue.

### Step 6: Commit

- [ ] **Step 11: Commit**

```bash
git add src/graph/store.ts src/graph/code-queries.ts src/index.ts src/mcp-server/tools/code-tools.ts
git commit -m "$(cat <<'EOF'
refactor(graph): TS query layer reads nodes/edges directly post-fold

After Phase 4 migration drops cbm_nodes/cbm_edges, the TS query layer
queries the unified nodes/edges tables directly:

- store.ts: CBM_LABEL_MAP deleted (kinds are granular now, not collapsed
  to function/component/path); getAllNodesUnified/getAllEdgesUnified
  simplify to a single SELECT with optional project filter (string or
  string[] for multi-project queries)
- code-queries.ts: every FROM cbm_nodes/cbm_edges → FROM nodes/edges
  with WHERE project = ? AND kind NOT IN ('decision','pr','todo') for
  code-entity queries; column refs label/type/properties → kind/relation/data
- code-tools.ts: inline SQL updated; output formatters read .kind
  instead of .label
- index.ts: cbm_projects → ctx_projects

Tool input parameter `label` on search_graph stays for contract continuity;
internally lowercased to match the new kind column convention.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4.4 — Indexer C-side rewrite

**Files:**
- Modify: `internal/cbm/src/store/store.c` (~92 references)
- Modify: `internal/cbm/src/pipeline/pipeline.c` (5 references)
- Modify: `internal/cbm/src/pipeline/pipeline_incremental.c` (5 references)
- Modify: `internal/cbm/src/mcp/mcp.c` (6 references)
- Modify: `internal/cbm/src/graph_buffer/graph_buffer.c` (3 references)

**Goal:** The indexer writes directly to `nodes`/`edges` (Cortex's tables) with `'ctx-<int>'` IDs and the new column names. Bookkeeping tables get the `ctx_` prefix in DDL. After this lands, fresh DBs never see `cbm_*` tables.

**Approach:** Mechanical search-and-replace pass with a few in-process counter additions for chained ID generation.

### Step 1: Add ID counters and helper to `store.c`

- [ ] **Step 1: Read store.c structure**

Run: `grep -n "typedef struct cbm_store\|cbm_store_t {" internal/cbm/src/store/store.h internal/cbm/src/store/store.c | head -10`
Expected: shows the struct definition for `cbm_store_t` in `store.h` or `store.c`.

- [ ] **Step 2: Add counter fields to the struct**

Open `internal/cbm/src/store/store.h` (or wherever `cbm_store_t` is defined). Find the struct definition. Add two `int64_t` counter fields:

```c
typedef struct cbm_store {
    sqlite3 *db;
    /* ... existing fields ... */
    int64_t next_node_id;  /* in-process counter for ctx-<int> node ids; seeded on open */
    int64_t next_edge_id;  /* in-process counter for ctx-e<int> edge ids; seeded on open */
} cbm_store_t;
```

Run: `grep -n "next_node_id\|next_edge_id" internal/cbm/src/store/store.h internal/cbm/src/store/store.c`
Expected: counters declared in store.h.

- [ ] **Step 3: Seed counters on store open**

In `internal/cbm/src/store/store.c`, find the `cbm_store_open` function (or wherever the store is initialized after `sqlite3_open`). Add this after `init_schema`:

```c
/* Seed ID counters from existing rows. Single-writer indexer makes this safe;
 * the counter is the source of truth for the lifetime of the store handle. */
static void seed_id_counters(cbm_store_t *s) {
    sqlite3_stmt *stmt = NULL;
    s->next_node_id = 1;
    s->next_edge_id = 1;

    /* Nodes use 'ctx-<int>' (4-char prefix); SUBSTR position 5 starts at the int. */
    if (sqlite3_prepare_v2(s->db,
            "SELECT IFNULL(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) + 1 "
            "FROM nodes WHERE id LIKE 'ctx-%'",
            -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            s->next_node_id = sqlite3_column_int64(stmt, 0);
        }
        sqlite3_finalize(stmt);
    }

    /* Edges use 'ctx-e<int>' (5-char prefix); SUBSTR position 6 starts at the int. */
    if (sqlite3_prepare_v2(s->db,
            "SELECT IFNULL(MAX(CAST(SUBSTR(id, 6) AS INTEGER)), 0) + 1 "
            "FROM edges WHERE id LIKE 'ctx-e%'",
            -1, &stmt, NULL) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW) {
            s->next_edge_id = sqlite3_column_int64(stmt, 0);
        }
        sqlite3_finalize(stmt);
    }
}
```

And call `seed_id_counters(s)` at the end of `cbm_store_open` (after `init_schema`).

### Step 2: Update `init_schema` DDL in `store.c`

- [ ] **Step 4: Read current init_schema**

Run: `sed -n '210,290p' internal/cbm/src/store/store.c`
Expected: shows `cbm_projects`, `cbm_file_hashes`, `cbm_nodes`, `cbm_edges`, `cbm_project_summaries` `CREATE TABLE` blocks plus the `cbm_nodes_fts` virtual table.

- [ ] **Step 5: Rewrite init_schema DDL**

Replace the full `init_schema` body in `internal/cbm/src/store/store.c` with the post-Phase-4 shape: drop the `cbm_nodes` and `cbm_edges` blocks (Cortex creates those), rename the others to `ctx_*`, update FK references:

```c
static int init_schema(cbm_store_t *s) {
    const char *ddl = "CREATE TABLE IF NOT EXISTS ctx_projects ("
                      "  name TEXT PRIMARY KEY,"
                      "  indexed_at TEXT NOT NULL,"
                      "  root_path TEXT NOT NULL"
                      ");"
                      "CREATE TABLE IF NOT EXISTS ctx_file_hashes ("
                      "  project TEXT NOT NULL REFERENCES ctx_projects(name) ON DELETE CASCADE,"
                      "  rel_path TEXT NOT NULL,"
                      "  sha256 TEXT NOT NULL,"
                      "  mtime_ns INTEGER NOT NULL DEFAULT 0,"
                      "  size INTEGER NOT NULL DEFAULT 0,"
                      "  PRIMARY KEY (project, rel_path)"
                      ");"
                      "CREATE TABLE IF NOT EXISTS ctx_project_summaries ("
                      "  project TEXT PRIMARY KEY,"
                      "  summary TEXT NOT NULL,"
                      "  source_hash TEXT NOT NULL,"
                      "  created_at TEXT NOT NULL,"
                      "  updated_at TEXT NOT NULL"
                      ");";

    int rc = exec_sql(s, ddl);
    if (rc != CBM_STORE_OK) {
        return rc;
    }

    /* FTS5 contentless virtual table for BM25 full-text search.
     * Now stores `kind` (was `label` pre-Phase-4) since the schema fold
     * unified column naming with Cortex's nodes table. */
    {
        char *fts_err = NULL;
        int fts_rc = sqlite3_exec(s->db,
                                  "CREATE VIRTUAL TABLE IF NOT EXISTS ctx_nodes_fts USING fts5("
                                  "  name, qualified_name, kind, file_path,"
                                  "  content='',"
                                  "  tokenize='unicode61 remove_diacritics 2'"
                                  ");",
                                  NULL, NULL, &fts_err);
        if (fts_rc != SQLITE_OK && fts_err) {
            sqlite3_free(fts_err);
        }
    }
    return CBM_STORE_OK;
}
```

- [ ] **Step 6: Update create_user_indexes**

The function `create_user_indexes` currently creates indexes on `cbm_nodes`/`cbm_edges`. Cortex now owns those indexes (added in Task 4.1). Drop those CREATE INDEX statements; keep only indexes on tables the indexer still owns (none currently — all the indexer's own indexes are tied to the data tables Cortex now owns). The function body becomes a no-op or can be deleted entirely.

Run: `grep -n "create_user_indexes\b" internal/cbm/src/store/store.c | head`
Expected: shows the function definition + caller. Either delete the function and its callsite, or leave the function body as `return CBM_STORE_OK;`.

Replace `create_user_indexes` with:
```c
static int create_user_indexes(cbm_store_t *s) {
    /* Phase 4: nodes/edges are owned by Cortex; the relevant indexes
     * (idx_nodes_*, idx_edges_*) are created by Cortex's GraphStore.migrate(),
     * not the indexer. This function is preserved as a no-op for callers. */
    (void)s;
    return CBM_STORE_OK;
}
```

### Step 3: Replace INSERT INTO cbm_nodes / cbm_edges in store.c

- [ ] **Step 7: Find all INSERT statements**

Run: `grep -n "INSERT INTO cbm_nodes\|INSERT INTO cbm_edges" internal/cbm/src/store/store.c`
Expected: ~3-5 INSERT sites (the main node insert in store_create_node, edge insert in store_create_edge, and any specialized variants).

- [ ] **Step 8: Locate the main node INSERT and update it**

Find the function that inserts into `cbm_nodes` (likely `cbm_store_create_node` or similar around line 958). It currently has a UPSERT pattern via `ON CONFLICT(project, qualified_name) DO UPDATE SET ...` because `cbm_nodes` had a `UNIQUE(project, qualified_name)` constraint.

**Cortex's `nodes` table has no such UNIQUE constraint.** Two paths to choose from:

- **Path A — drop UPSERT**: rely on the indexer's upstream dedup (CBM's existing `delete_project` before `index_repository` in the full-index path; file-hash-based skip in the incremental path) to prevent duplicates. The `id` column has counter-driven uniqueness.
- **Path B — add a partial UNIQUE index** in Task 4.1's schema:
  ```sql
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_nodes_project_qn ON nodes(project, qualified_name)
    WHERE project IS NOT NULL AND qualified_name IS NOT NULL;
  ```
  Decision/PR/TODO rows have `project IS NULL` so they're unaffected. Then the UPSERT clause works as before.

**Use Path A.** The UPSERT was a defensive measure — CBM's indexer already prevents the duplicate scenario upstream. Adding a partial UNIQUE index would also work but introduces schema constraints that other consumers (frame extraction, viewer) might not anticipate. Keep the schema additive.

Replace the INSERT with:

```c
sqlite3_prepare_v2(s->db,
    "INSERT INTO nodes (id, kind, name, qualified_name, file_path, "
    "start_line, end_line, data, project, tier, created_at, updated_at) "
    "VALUES (?1, LOWER(?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'shared', "
    "strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    -1, &stmt, NULL);

/* Build the ctx-<int> id from the in-process counter */
char id_buf[32];
snprintf(id_buf, sizeof(id_buf), "ctx-%lld", (long long)s->next_node_id++);
sqlite3_bind_text(stmt, 1, id_buf, -1, SQLITE_TRANSIENT);
sqlite3_bind_text(stmt, 2, n->label, -1, SQLITE_STATIC);  /* LOWER() applied in SQL */
sqlite3_bind_text(stmt, 3, n->name, -1, SQLITE_STATIC);
sqlite3_bind_text(stmt, 4, n->qualified_name, -1, SQLITE_STATIC);
sqlite3_bind_text(stmt, 5, n->file_path, -1, SQLITE_STATIC);
sqlite3_bind_int(stmt, 6, n->start_line);
sqlite3_bind_int(stmt, 7, n->end_line);
sqlite3_bind_text(stmt, 8, n->properties_json, -1, SQLITE_STATIC);
sqlite3_bind_text(stmt, 9, n->project, -1, SQLITE_STATIC);
```

The exact code shape depends on the existing function's structure — adapt to fit. Key changes:
- Table name `cbm_nodes` → `nodes`
- Column name `label` → `kind` (with `LOWER()` applied in SQL)
- Column name `properties` → `data`
- Add columns `id`, `tier`, `created_at`, `updated_at`
- Drop the ON CONFLICT clause (Path A above)
- Build `id` from `s->next_node_id++`

- [ ] **Step 9: Locate the rowid retrieval after INSERT**

After the INSERT, the existing C code typically does `int64_t rowid = sqlite3_last_insert_rowid(s->db);` to get the auto-generated integer id. Post-Phase-4, the id we need for chaining is the integer counter we just used (`s->next_node_id - 1`). Replace any place that reads `sqlite3_last_insert_rowid` for a node-INSERT context with the counter value:

```c
/* Pre-Phase-4: int64_t rowid = sqlite3_last_insert_rowid(s->db); */
int64_t cbm_id = s->next_node_id - 1;  /* the counter we just consumed */
```

For FTS5 linkage, use `sqlite3_last_insert_rowid()` as the FTS rowid (FTS rows are linked to nodes' SQLite-internal rowid, not the parsed integer suffix). See the FTS update section below.

- [ ] **Step 10: Update edge INSERT similarly**

Find the edge insert (e.g., `cbm_store_create_edge` around line 1280):

```c
sqlite3_prepare_v2(s->db,
    "INSERT INTO cbm_edges (project, source_id, target_id, type, properties) "
    "VALUES (?1, ?2, ?3, ?4, ?5)"
    "ON CONFLICT(source_id, target_id, type) DO UPDATE SET "
    "  properties = json_patch(properties, ?5)"
    , -1, &stmt, NULL);
sqlite3_bind_text(stmt, 1, e->project, ...);
sqlite3_bind_int64(stmt, 2, e->source_id);
sqlite3_bind_int64(stmt, 3, e->target_id);
sqlite3_bind_text(stmt, 4, e->type, ...);
/* ... */
```

Replace with (Path A: drop UPSERT, rely on counter-driven id uniqueness + upstream dedup):

```c
sqlite3_prepare_v2(s->db,
    "INSERT INTO edges (id, source_id, target_id, relation, data, project, created_at) "
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
    -1, &stmt, NULL);

char edge_id[32];
snprintf(edge_id, sizeof(edge_id), "ctx-e%lld", (long long)s->next_edge_id++);
char src_id[32], tgt_id[32];
snprintf(src_id, sizeof(src_id), "ctx-%lld", (long long)e->source_id);
snprintf(tgt_id, sizeof(tgt_id), "ctx-%lld", (long long)e->target_id);
sqlite3_bind_text(stmt, 1, edge_id, -1, SQLITE_TRANSIENT);
sqlite3_bind_text(stmt, 2, src_id, -1, SQLITE_TRANSIENT);
sqlite3_bind_text(stmt, 3, tgt_id, -1, SQLITE_TRANSIENT);
sqlite3_bind_text(stmt, 4, e->type, -1, SQLITE_STATIC);
sqlite3_bind_text(stmt, 5, e->properties_json, -1, SQLITE_STATIC);
sqlite3_bind_text(stmt, 6, e->project, -1, SQLITE_STATIC);
```

The edge's `source_id`/`target_id` in the C struct (`e->source_id` etc.) are still int64 — the indexer's in-memory representation tracks integer IDs. The `'ctx-<int>'` text id is constructed at INSERT time. Reads (e.g., `cbm_store_get_edge`) need to parse `'ctx-<int>'` back to int — see the next step.

### Step 4: Update SELECT statements in store.c

- [ ] **Step 11: Find all SELECT references**

Run: `grep -n "FROM cbm_nodes\|FROM cbm_edges\|FROM cbm_projects\|cbm_file_hashes\|cbm_project_summaries" internal/cbm/src/store/store.c`
Expected: many references. Most read columns by name.

- [ ] **Step 12: Apply mechanical rewrites**

Use sed or manual edits to apply these consistent renames in `store.c`:

| Old SQL fragment | New SQL fragment |
|---|---|
| `FROM cbm_nodes` | `FROM nodes` (add `WHERE … kind NOT IN ('decision','pr','todo')` if a generic SELECT — but most CBM SELECTs already filter `WHERE project = ?` which excludes decisions since their project is NULL) |
| `FROM cbm_edges` | `FROM edges` (similarly; `WHERE project = ?` already filters out governance edges) |
| `FROM cbm_projects` | `FROM ctx_projects` |
| `FROM cbm_file_hashes` | `FROM ctx_file_hashes` |
| `FROM cbm_project_summaries` | `FROM ctx_project_summaries` |
| `cbm_nodes_fts` | `ctx_nodes_fts` |
| Column reference: `label` (in SELECT/WHERE) | `kind` |
| Column reference: `type` (where it means edge type) | `relation` |
| Column reference: `properties` | `data` |
| `JOIN cbm_nodes` | `JOIN nodes` |
| `JOIN cbm_edges` | `JOIN edges` |

After the SELECT, code that reads `id` as int64 needs to parse `'ctx-<int>'` back to int. In places where the indexer holds `int64_t` IDs internally and now reads from `nodes.id` (which is `'ctx-<int>'`), add a parser:

```c
/* Parse 'ctx-<int>' → int64. Returns 0 on parse failure. */
static int64_t parse_ctx_id(const char *id_str) {
    if (id_str == NULL) return 0;
    /* Skip 'ctx-' or 'ctx-e' prefix. */
    const char *p = id_str + 4; /* "ctx-" */
    if (*p == 'e') p++;          /* "ctx-e" */
    return strtoll(p, NULL, 10);
}
```

Add this static helper near the top of `store.c` (or in `store.h` if needed by other files). Replace `n->id = sqlite3_column_int64(stmt, …)` with `n->id = parse_ctx_id((const char *)sqlite3_column_text(stmt, …))` at every node/edge read site.

- [ ] **Step 13: Update FTS write linkage**

Find every `INSERT INTO cbm_nodes_fts` (or equivalent FTS update). Replace with `INSERT INTO ctx_nodes_fts` and ensure the column list reads `(rowid, name, qualified_name, kind, file_path)` (was `label`, now `kind`). The rowid bound is `sqlite3_last_insert_rowid()` after the node INSERT — this is SQLite's internal rowid for the `nodes` row, NOT the parsed integer from `'ctx-<int>'`.

Run: `grep -n "cbm_nodes_fts" internal/cbm/src/store/store.c`
Expected: 0 matches after the rename.

### Step 5: Update pipeline.c, pipeline_incremental.c, mcp.c, graph_buffer.c

- [ ] **Step 14: Apply same renames mechanically across the four files**

Run these to find every reference:
```bash
grep -n "cbm_nodes\|cbm_edges\|cbm_projects\|cbm_file_hashes\|cbm_project_summaries\|cbm_nodes_fts" \
  internal/cbm/src/pipeline/pipeline.c \
  internal/cbm/src/pipeline/pipeline_incremental.c \
  internal/cbm/src/mcp/mcp.c \
  internal/cbm/src/graph_buffer/graph_buffer.c
```

Apply the same SQL fragment rewrites as in Step 12. Particularly:
- `pipeline.c` line ~652: `INSERT INTO cbm_nodes_fts(cbm_nodes_fts) VALUES('delete-all');` → `INSERT INTO ctx_nodes_fts(ctx_nodes_fts) VALUES('delete-all');`
- `pipeline.c` line ~654: `INSERT INTO cbm_nodes_fts(rowid, name, qualified_name, label, file_path) ...` → `INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) ...`
- Same renames in `pipeline_incremental.c`
- `mcp.c` and `graph_buffer.c`: rename table names; columns label→kind, type→relation, properties→data where present

- [ ] **Step 15: Verify no cbm_<table> references remain in C source**

Run:
```bash
grep -rn "cbm_nodes\|cbm_edges\|cbm_projects\|cbm_file_hashes\|cbm_project_summaries\|cbm_nodes_fts" \
  internal/cbm/src/ 2>/dev/null
```

Expected: 0 matches. (The `internal/cbm/tests/` corpus is out of scope — those tests are deferred.)

### Step 6: Rebuild and verify

- [ ] **Step 16: Rebuild the indexer**

Run: `bash scripts/build-indexer.sh 2>&1 | tail -10`
Expected: build succeeds. `bin/cortex-indexer` updated. If C compile errors, read the message — likely a typo or a missed cbm_/label/type/properties reference.

- [ ] **Step 17: Smoke-test the indexer end-to-end**

```bash
rm -rf /tmp/cortex-phase4-smoke
mkdir -p /tmp/cortex-phase4-smoke
cp -r tests/fixtures/sample-project /tmp/cortex-phase4-smoke/
DB=/tmp/cortex-phase4-smoke/cortex.db
CORTEX_DB=$DB bin/cortex-indexer cli index_repository "{\"repo_path\":\"/tmp/cortex-phase4-smoke/sample-project\"}" | head -3
sqlite3 $DB "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
sqlite3 $DB "SELECT COUNT(*) FROM nodes WHERE id LIKE 'ctx-%'"
sqlite3 $DB "SELECT COUNT(*) FROM edges WHERE id LIKE 'ctx-e%'"
sqlite3 $DB "SELECT DISTINCT kind FROM nodes WHERE id LIKE 'ctx-%' ORDER BY kind LIMIT 20"
```

Expected:
- Tables include `nodes`, `edges`, `ctx_projects`, `ctx_file_hashes`, `ctx_project_summaries`, `ctx_nodes_fts`. NO `cbm_nodes`, `cbm_edges`, `cbm_projects`, etc.
- Node count > 0, edge count > 0.
- Distinct kinds are lowercase: `class`, `function`, `method`, `module`, etc.

- [ ] **Step 18: Run the full test suite**

Run: `npm test 2>&1 | tail -10`
Expected: 49 test files green. The schema-fold-migration test still passes (probe finds no cbm_nodes on freshly-indexed DBs, returns early — which is the desired post-Phase-4 behavior). The contract suite passes because the indexer now writes `nodes`/`edges` directly.

Some assertions in `tests/mcp-contract/code-tools.test.ts` may still fail because they check for uppercase labels (`"Function"`, `"Class"`). Task 4.5 fixes those. If you see only those failures, continue; otherwise debug.

- [ ] **Step 19: Commit**

```bash
git add internal/cbm/src/
git commit -m "$(cat <<'EOF'
feat(indexer): C-side schema fold — write nodes/edges directly

The indexer now writes to Cortex's nodes/edges tables instead of its
own cbm_nodes/cbm_edges. Bookkeeping tables renamed cbm_* → ctx_*.

Changes by file (all in internal/cbm/src/):
- store/store.c (~92 references): init_schema drops cbm_nodes/cbm_edges
  CREATE TABLE blocks (Cortex owns those); renames remaining tables;
  INSERT statements rewritten to target nodes/edges with new column
  names (label → kind via LOWER(), properties → data, type → relation)
  and 'ctx-<int>' / 'ctx-e<int>' text IDs from in-process counters
  (next_node_id, next_edge_id) seeded on store-open from MAX(id).
- pipeline/pipeline.c, pipeline/pipeline_incremental.c (10 refs):
  FTS table renamed cbm_nodes_fts → ctx_nodes_fts; column label → kind
  in FTS triggers and direct inserts.
- mcp/mcp.c (6 refs): same rename pass.
- graph_buffer/graph_buffer.c (3 refs): same.

A parse_ctx_id() helper extracts the integer from 'ctx-<int>' /
'ctx-e<int>' for in-memory edge FK chaining.

CBM's own C test suite (internal/cbm/tests/) still references cbm_*
tables and is now broken — out of scope for Phase 4; tracked for a
follow-up. Cortex's npm test is the merge gate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4.5 — Test updates: assertions on `kind` and `'ctx-'` IDs

**Files:**
- Modify: `tests/graph/code-queries.test.ts`
- Modify: `tests/mcp-contract/code-tools.test.ts`

**Goal:** Update test assertions that read `node.label` (now `node.kind`) or expect uppercase label strings (now lowercase). Verify all tests pass.

- [ ] **Step 1: Read code-queries.test.ts**

Run: `cat tests/graph/code-queries.test.ts`
Expected: shows the 6 `it()` blocks. The test asserts on `results[0].name` (string field, unchanged). The `getAllNodesUnified` test checks `n.id.startsWith("cbm-")` — needs updating to `"ctx-"`.

- [ ] **Step 2: Update the ID prefix assertion**

In `tests/graph/code-queries.test.ts`, find the `getAllNodesUnified` test and update:

```typescript
it("getAllNodesUnified returns merged Cortex + indexer rows", () => {
  const all = store.getAllNodesUnified(project);
  const hasIndexerRows = all.some((n) => n.id.startsWith("ctx-"));
  expect(hasIndexerRows).toBe(true);
});
```

- [ ] **Step 3: Run the code-queries test**

Run: `npm test -- tests/graph/code-queries.test.ts 2>&1 | tail -10`
Expected: 6 tests pass.

- [ ] **Step 4: Read code-tools.test.ts**

Run: `grep -n "label\|Function\|Class\|Method" tests/mcp-contract/code-tools.test.ts | head -20`
Expected: shows assertions like `{ label: "Class" }` (parameter input to `search_graph`) and `expect(...).toMatch(/Function: \d+/)` (output assertion on `get_graph_schema`).

- [ ] **Step 5: Update label parameter values**

In `tests/mcp-contract/code-tools.test.ts`:

The `search_graph` test that passes `label: "Class"`:
```typescript
it("happy: label filter", async () => {
  const res = await callTool(h, "search_graph", { label: "Class" });
  expect(res.content[0].text).toContain("Router");
});
```

The implementation in `code-queries.ts` (Task 4.3) lowercases the input via `params.label.toLowerCase()`. So this test passes as-is — the label value `"Class"` will match nodes where `kind = 'class'`. No change needed.

The `get_graph_schema` test that asserts uppercase output:
```typescript
it("happy: returns labels and counts", async () => {
  const res = await callTool(h, "get_graph_schema", {});
  expect(res.content[0].text).toMatch(/Function: \d+/);
  expect(res.content[0].text).toContain("Edge types:");
});
```

Update to lowercase to match the new `kind` values:
```typescript
it("happy: returns labels and counts", async () => {
  const res = await callTool(h, "get_graph_schema", {});
  expect(res.content[0].text).toMatch(/function: \d+/);
  expect(res.content[0].text).toContain("Edge types:");
});
```

The `trace_path` and `search_graph` tests check for substrings like `"Router"` (a node name) and `"handleRequest"` (a function name) — these are unchanged.

The `formatNodes` output now reads `${n.kind}` instead of `${n.label}`. The format example used to look like `Function src/server.ts::handleRequest (...)`; now it's `function src/server.ts::handleRequest (...)`. If any test asserts on the leading capitalized kind, update those too.

Run: `grep -nE "(Function |Class |Method |Module )" tests/mcp-contract/` to find any remaining uppercase assertions.

- [ ] **Step 6: Run the contract suite**

Run: `npm test -- tests/mcp-contract/ 2>&1 | tail -10`
Expected: all contract tests pass (68 / 1 skipped).

- [ ] **Step 7: Run the full test suite**

Run: `npm test 2>&1 | tail -10`
Expected: 50 test files (added schema-fold-migration), all green. ~363 passed / 1 skipped.

- [ ] **Step 8: Commit**

```bash
git add tests/graph/code-queries.test.ts tests/mcp-contract/code-tools.test.ts
git commit -m "$(cat <<'EOF'
test(graph,mcp-contract): adjust assertions for ctx- IDs and lowercase kinds

After Phase 4, code-entity rows in nodes have:
- IDs prefixed 'ctx-' instead of 'cbm-'
- kinds in lowercase ('function', 'class', ...) instead of uppercase

Tests updated:
- code-queries.test.ts: getAllNodesUnified assertion checks 'ctx-' prefix
- code-tools.test.ts: get_graph_schema regex matches /function: \\d+/

The label filter test (search_graph with label: 'Class') passes as-is
since the search_graph implementation lowercases the input internally
to maintain tool-contract continuity.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4.6 — Verify and tag

**Goal:** Final consistency checks; tag the phase.

- [ ] **Step 1: Verify TS source has no stale cbm_ references (excluding cbm-discovery)**

Run:
```bash
grep -rn "cbm_nodes\|cbm_edges\|cbm_projects\|cbm_file_hashes\|cbm_project_summaries\|cbm_nodes_fts" \
  src/ tests/ 2>&1 | grep -v "cbm-discovery"
```
Expected: 0 matches. (`cbm-discovery.ts` is preserved for Phase 5 v0.2 migration shim — it queries the *external* legacy `~/.cache/codebase-memory-mcp/<project>.db` file, not cortex.db.)

- [ ] **Step 2: Verify C-side has no stale references**

Run:
```bash
grep -rn "cbm_nodes\|cbm_edges\|cbm_projects\|cbm_file_hashes\|cbm_project_summaries\|cbm_nodes_fts" \
  internal/cbm/src/ 2>&1
```
Expected: 0 matches. (`internal/cbm/tests/` is the C test corpus, deferred.)

- [ ] **Step 3: Verify tests pass on a clean checkout flow**

```bash
rm -f .cortex/graph.db .cortex/graph.db-wal .cortex/graph.db-shm
npm test 2>&1 | tail -5
```
Expected: 50 test files / 363 passed / 1 skipped / 0 failed.

- [ ] **Step 4: Self-review the diff against main**

```bash
git diff main..HEAD --stat | tail -25
```
Look for surprises: stray edits, unintended `internal/cbm/vendored/` changes, new files outside the planned surface.

- [ ] **Step 5: Tag the phase**

```bash
git tag -a phase-4-schema-fold -m "$(cat <<'EOF'
Phase 4: Schema fold — code entities live in nodes/edges with kind discriminator.

State at this tag:
- cbm_nodes / cbm_edges no longer exist; data folded into nodes / edges
- Bookkeeping tables renamed cbm_* → ctx_* (projects, file_hashes,
  project_summaries, nodes_fts)
- Indexer writes 'ctx-<int>' text IDs; LOWER(label) → kind; properties
  → data; type → relation
- Migration probe-and-fold runs on every GraphStore open; idempotent
- Cortex tests: ~363 passed / 1 skipped (50 test files)

What's working end-to-end:
- 'npm install' builds bin/cortex-indexer (Phase 1+2)
- Indexer writes Cortex's nodes/edges directly via CORTEX_DB
- Cortex queries the unified graph (decisions + code) from one table
- One-shot migration upgrades v0.3-Phase-3b DBs to the new shape

Out of scope (handled by later phases):
- Phase 5: v0.2 cross-file migration (~/.cache/codebase-memory-mcp/<project>.db)
- Phase 6: Strip CBM's MCP shell + bridge query_graph/get_architecture/ingest_traces
- Phase 7: Repo-root cortex.db + per-machine cache
- Phase 8: Final cleanup (rename CbmNode/CbmEdge/CbmProject TS symbols,
  delete cbm-discovery.ts after Phase 5 needs go away)

CBM's own C test suite (internal/cbm/tests/) is currently broken —
references cbm_* tables. Tracked separately; not on Cortex's npm test
critical path.
EOF
)"

git tag -l 'phase-*'
```
Expected: lists `phase-1-subtree-merged`, `phase-2-build-pipeline`, `phase-3a-storage-retarget`, `phase-3b-ts-side`, `phase-4-schema-fold`.

---

## Self-review checklist

- [ ] G1 (code entities live in `nodes` distinguished by `kind`) — done in Task 4.4 (indexer writes `nodes` directly with `LOWER(label)` → `kind`).
- [ ] G2 (no `cbm_nodes` / `cbm_edges` after migration) — done in Task 4.2 (migration drops both); verified in Task 4.6 Step 2.
- [ ] G3 (existing test suites pass) — done in Task 4.5; verified in Task 4.6 Step 3.
- [ ] G4 (indexer writes `nodes` / `edges` directly) — done in Task 4.4; verified in Task 4.6 Step 2.
- [ ] G5 (migration is idempotent + atomic) — done in Task 4.2 (probe-based; transaction with FK off); verified by the second `it()` block in `schema-fold-migration.test.ts`.
- [ ] G6 (`cbm_*` → `ctx_*` rename consistent) — done across tasks 4.2 (TS), 4.3 (TS), 4.4 (C-side); verified in Task 4.6 Steps 1-2.

## Out of scope (deferred)

- **Phase 5: v0.2 migration shim.** `cbm-discovery.ts` preserved here for that. Phase 4 only handles `cbm_*` → `nodes`/`edges` *within* a single cortex.db file.
- **Viewer styling for granular kinds.** Existing viewer probably colors `function`/`component`/`path`. After Phase 4, kinds are granular (`class`, `method`, `interface`, ...) — defaults will render. Phase 8 or a parallel viewer task adds explicit styles.
- **CBM's C test suite.** ~2740 tests in `internal/cbm/tests/` reference the old schema. Out of scope; deferred to a separate task. Cortex's `npm test` is the merge gate.
- **Type renames.** `CbmNode` / `CbmEdge` / `CbmProject` interfaces in TS keep their names through Phase 4. Phase 8 cleanup renames.
- **Storage location move.** `cortex.db` stays at `<install>/.cortex/graph.db`. Phase 7 moves to `<repo>/.cortex/db`.

## Risks (carried from spec)

| Risk | Where addressed |
|---|---|
| Migration data loss | Task 4.2 wraps in transaction with rollback; idempotent probe; row-count check could be added if needed (currently not in plan — failure rolls back the transaction so DB is unchanged). |
| ID collisions | `ctx-` prefix can't collide with ULIDs (Crockford base32 charset) — safe by construction. |
| FK cascade during migration | Task 4.2 uses `PRAGMA foreign_keys = OFF` for the full migration. |
| FTS5 rebuild cost | Task 4.2 rebuilds inside the same transaction; ~10k node repos sub-second; documented. |
| Mid-migration crash | `BEGIN IMMEDIATE` transaction; SQLite atomicity guarantees consistent state on crash. |
| Concurrent writers | Migration runs in `GraphStore` constructor, before any indexer subprocess invocation. Documented in spec §2.6.1. |
| Indexer writes a non-existent column | Cortex's `migrate()` runs before any indexer call; new columns exist before writes. |
| CBM\_LABEL\_MAP removal breaks viewer | Viewer adaptation out of scope; default colors render for granular kinds. |

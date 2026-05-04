# Cortex v0.3 — Native Indexer Schema Fold (Phase 4)

**Date:** 2026-05-04
**Status:** Design — pending implementation plan
**Branch:** `feature/db/native-indexer-schema-fold`
**Track:** v0.3 Track 1 (CBM absorption — see [2026-05-03-native-indexer-cbm-absorption-design.md](2026-05-03-native-indexer-cbm-absorption-design.md))

---

## 0. Purpose

Phase 3a/3b unified the *file* boundary: the indexer's `cbm_*`-prefixed tables now live in `cortex.db` next to Cortex's own `nodes`/`edges`. Phase 4 unifies the *schema* boundary: `cbm_nodes` and `cbm_edges` fold into the existing `nodes` / `edges` tables, with `kind` as the discriminator. After Phase 4 lands, a single `SELECT … FROM nodes` returns code entities, decisions, PRs, and TODOs as one graph — the unified-schema goal G2 from the parent spec is fully met.

Bookkeeping tables that the indexer owns (`cbm_projects`, `cbm_file_hashes`, `cbm_project_summaries`, `cbm_nodes_fts`) stay as separate tables but are renamed `cbm_*` → `ctx_*` to mark them as Cortex-native.

---

## 1. Goals

| # | Goal | Measure |
|---|---|---|
| G1 | Code entities live in `nodes` table alongside decisions/PRs/TODOs, distinguished by `kind` | `SELECT DISTINCT kind FROM nodes` returns `function`, `class`, `method`, `decision`, `pr`, ... |
| G2 | `cbm_nodes` / `cbm_edges` tables no longer exist after migration | `SELECT name FROM sqlite_master WHERE name IN ('cbm_nodes','cbm_edges')` returns 0 rows |
| G3 | Existing test suites pass: 49 test files, mcp-contract green, integration test (`code-queries.test.ts`) green | `npm test` exit 0; 0 failures |
| G4 | Indexer C-side writes directly to `nodes` / `edges` with the new column names — no `cbm_nodes` / `cbm_edges` references in `internal/cbm/src/` | `grep -r "cbm_nodes\|cbm_edges" internal/cbm/src/` returns 0 matches in non-vendored code |
| G5 | Schema migration is idempotent and atomic on existing v0.3-Phase-3b databases | Running migration twice on a populated db produces same row counts; mid-migration crash leaves DB recoverable |
| G6 | All bookkeeping tables renamed `cbm_*` → `ctx_*` consistently (TS-side query strings, C-side DDL, FTS5 triggers) | `grep -ri "cbm_projects\|cbm_file_hashes\|cbm_project_summaries\|cbm_nodes_fts" src/ tests/ internal/cbm/src/` returns 0 matches |

---

## 2. Architecture

### 2.1 Schema delta

**`nodes` (additive — existing decision/PR/TODO rows preserved):**

```sql
ALTER TABLE nodes ADD COLUMN start_line INTEGER;
ALTER TABLE nodes ADD COLUMN end_line   INTEGER;
ALTER TABLE nodes ADD COLUMN project    TEXT;

CREATE INDEX IF NOT EXISTS idx_nodes_kind_project ON nodes(kind, project);
CREATE INDEX IF NOT EXISTS idx_nodes_kind_file    ON nodes(kind, file_path);
```

The three new columns are nullable: decision/PR/TODO rows leave them NULL, code rows always populate them.

**`edges` (additive):**

```sql
ALTER TABLE edges ADD COLUMN project TEXT;

CREATE INDEX IF NOT EXISTS idx_edges_project_relation ON edges(project, relation);
```

Governance edges (`GOVERNS`, `SUPERSEDES`, `RELATED_TO`, `DEPENDS_ON`, `INTRODUCED_IN`, `IMPLEMENTED_BY`) leave `project = NULL`. Code-graph edges (`CALLS`, `IMPORTS`, `DEFINES`, `DEFINES_METHOD`, `HANDLES`, `IMPLEMENTS`, `OVERRIDE`, `USAGE`, `FILE_CHANGES_WITH`, `CONTAINS_FILE`, `CONTAINS_FOLDER`, `CONTAINS_PACKAGE`) populate it.

### 2.2 ID format

CBM uses `INTEGER PRIMARY KEY AUTOINCREMENT`. Cortex's `nodes.id` is `TEXT`. The fold maps integer ids to a `'ctx-<int>'` text format:

| Old | New |
|---|---|
| `cbm_nodes.id = 42` | `nodes.id = 'ctx-42'` |
| `cbm_edges.id = 7`  | `edges.id  = 'ctx-e7'` |

The `ctx-` and `ctx-e` prefixes give a visual provenance signal in dumps (e.g., distinguishes indexer-generated rows from Cortex's ULID-based decision rows). This is the existing pattern used in `getAllNodesUnified` post-3b, just rebranded `cbm-` → `ctx-`.

The indexer's C-side keeps an in-process integer counter (seeded on store-open via `SELECT IFNULL(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) FROM nodes WHERE id LIKE 'ctx-%'`) for chained inserts (insert node, get integer counter, use it as edge FK). Single-writer indexer makes this concurrency-safe.

Per the parent spec ([§2.4](2026-05-03-native-indexer-cbm-absorption-design.md)), node IDs are not stable identity — joins to user state use `qualified_name` as the soft FK. So id format is internal and can be regenerated on cache import.

### 2.3 `kind` vocabulary

Migration: `LOWER(cbm_nodes.label)` → `nodes.kind`. Preserves CBM's full label granularity (~20 distinct values: `function`, `class`, `method`, `interface`, `enum`, `struct`, `trait`, `type`, `variable`, `constant`, `field`, `property`, `constructor`, `file`, `folder`, `package`, `module`, `namespace`, `route`, `symbol`, `project`, ...) alongside Cortex's existing kinds (`decision`, `pr`, `todo`).

The viewer's existing CBM_LABEL_MAP collapse (`function`/`component`/`path`) is **dropped** — kind becomes the most-granular signal. Viewer-side coloring can collapse for rendering as needed.

`kind = 'project'` (CBM's project-root node) coexists with the `ctx_projects` metadata table — different concerns. The node represents the project root in the graph; `ctx_projects` is bookkeeping metadata.

### 2.4 Column mapping

| `cbm_nodes` column | `nodes` column | Transformation |
|---|---|---|
| `id` | `id` | `'ctx-' \|\| CAST(id AS TEXT)` |
| `project` | `project` | preserved |
| `label` | `kind` | `LOWER(label)` |
| `name` | `name` | preserved |
| `qualified_name` | `qualified_name` | preserved |
| `file_path` | `file_path` | preserved |
| `start_line` | `start_line` | preserved |
| `end_line` | `end_line` | preserved |
| `properties` | `data` | preserved (JSON pass-through) |
| — | `tier` | constant `'shared'` |
| — | `created_at` | `cbm_projects.indexed_at` lookup |
| — | `updated_at` | `cbm_projects.indexed_at` lookup |

| `cbm_edges` column | `edges` column | Transformation |
|---|---|---|
| `id` | `id` | `'ctx-e' \|\| CAST(id AS TEXT)` |
| `project` | `project` | preserved |
| `source_id` | `source_id` | `'ctx-' \|\| CAST(source_id AS TEXT)` |
| `target_id` | `target_id` | `'ctx-' \|\| CAST(target_id AS TEXT)` |
| `type` | `relation` | preserved |
| `properties` | `data` | preserved |
| — | `created_at` | `datetime('now')` |

### 2.5 Bookkeeping table renames

| Before | After | Owner |
|---|---|---|
| `cbm_projects` | `ctx_projects` | Indexer writes; Cortex reads |
| `cbm_file_hashes` | `ctx_file_hashes` | Indexer-internal |
| `cbm_project_summaries` | `ctx_project_summaries` | Indexer-internal |
| `cbm_nodes_fts` | `ctx_nodes_fts` | Indexer write triggers; Cortex reads |

All four are renamed via `ALTER TABLE … RENAME TO`, except `cbm_nodes_fts` (FTS5 virtual tables don't support `ALTER RENAME` directly — must drop, recreate with the new name, and repopulate from `nodes`).

### 2.6 Migration mechanism

Cortex's `GraphStore.migrate()` runs on every store open. A new migration step `migrateSchemaFold()`:

1. Probe: does `cbm_nodes` table exist? If not, migration is already done — return.
2. `PRAGMA foreign_keys = OFF` (avoid cascade-deletes during the cross-table copy).
3. Begin transaction (`BEGIN IMMEDIATE`).
4. Add new columns to `nodes` and `edges` if they don't already exist, by inspecting `PRAGMA table_info(nodes)` / `PRAGMA table_info(edges)` and emitting `ALTER TABLE … ADD COLUMN` only for missing columns. SQLite's `ALTER TABLE ADD COLUMN` doesn't support `IF NOT EXISTS`, so the existence check is mandatory for idempotency.
5. Run the `INSERT … SELECT` migration: edges first, then nodes (FK direction; with FK off, order is cosmetic but matches the data flow).
6. Drop `cbm_edges`, then `cbm_nodes`.
7. `ALTER TABLE cbm_projects RENAME TO ctx_projects`, same for `cbm_file_hashes` and `cbm_project_summaries`.
8. Drop `cbm_nodes_fts` (FTS5 virtual table — can't `RENAME`), recreate as `ctx_nodes_fts`, repopulate via `INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) SELECT rowid, name, qualified_name, kind, file_path FROM nodes WHERE id LIKE 'ctx-%'`.
9. Commit; `PRAGMA foreign_keys = ON`.

If any step fails, the transaction rolls back and FK enforcement is restored.

The indexer's C-side is updated in lockstep (same branch) so post-migration writes target `nodes`/`edges` directly. There's no halfway state where the indexer writes to the now-dropped `cbm_nodes`.

**On a fresh DB** (no `cbm_*` tables to migrate): step 1's probe returns false, migration is a no-op. Cortex's `migrate()` runs `CREATE TABLE IF NOT EXISTS nodes`, `CREATE INDEX IF NOT EXISTS idx_nodes_*`, etc., so the post-Phase-4 schema is applied directly without legacy data.

### 2.6.1 Schema ownership division

Phase 4 settles which side of the boundary creates which tables on a fresh DB:

| Table | Created by | Notes |
|---|---|---|
| `nodes` / `edges` / `edge_annotations` | Cortex TS (`CREATE_TABLES` in `schema.ts`) | Owned exclusively by Cortex. Indexer never `CREATE TABLE`s these. |
| `decisions_fts` | Cortex TS | Existing. |
| `ctx_projects` / `ctx_file_hashes` / `ctx_project_summaries` / `ctx_nodes_fts` | Indexer C-side (`init_schema` in `store.c`) | Owned exclusively by indexer. Cortex queries them as a read-only consumer. |

The indexer's `init_schema` is purged of any `CREATE TABLE … cbm_nodes` / `cbm_edges` (now `nodes` / `edges`) — Cortex always migrates first (its `GraphStore` constructor runs in startup before any indexer subprocess invocation). When the indexer subprocess opens the same SQLite file, it sees Cortex's tables already present.

### 2.7 TS-side surfaces

| File | Change |
|---|---|
| `src/graph/schema.ts` | Add new columns + indexes to `CREATE_TABLES`/`CREATE_INDEXES` |
| `src/graph/store.ts` | Delete `CBM_LABEL_MAP`. `getAllNodesUnified()`/`getAllEdgesUnified()` simplify to `SELECT * FROM nodes`/`edges` (optionally filter `WHERE project = ?` and/or `WHERE kind NOT IN ('decision','pr','todo')`). New private migration method `migrateSchemaFold()` invoked from `migrate()`. |
| `src/graph/code-queries.ts` | All `FROM cbm_nodes` → `FROM nodes WHERE project = ? AND kind NOT IN ('decision','pr','todo')`; `FROM cbm_edges` → `FROM edges WHERE project = ?` (governance edges have `project = NULL` so they're excluded by this filter). Type interface `CbmNode` keeps its name through Phase 4 (Phase 8 renames). The field `label` does become `kind` since the row shape changes. |
| `src/index.ts` | `cbm_projects` → `ctx_projects` in the startup query. |
| `src/mcp-server/tools/code-tools.ts` | Same `cbm_nodes` → `nodes` rewrite for the inline `search_code` enrichment query; `cbm_projects` → `ctx_projects` for the `get_code_snippet` lookup. Output formatting uses the new `kind` field. |
| `tests/graph/code-queries.test.ts` | Assertions adjust: `node.kind` instead of `node.label`; ID prefix `'ctx-'`. |
| `tests/mcp-contract/code-tools.test.ts` | Same: ID prefix update, `kind` field in formatted output. |

### 2.8 C-side surfaces (`internal/cbm/src/`)

| File | Change |
|---|---|
| `store/store.c` `init_schema()` | Drop `cbm_nodes` / `cbm_edges` `CREATE TABLE` blocks (Cortex now owns those). Keep / rename `ctx_projects`, `ctx_file_hashes`, `ctx_project_summaries`, `ctx_nodes_fts` blocks. |
| `store/store.c` insert helpers | All `INSERT INTO cbm_nodes (...)` → `INSERT INTO nodes (id, kind, name, qualified_name, file_path, start_line, end_line, data, project, tier, created_at, updated_at) VALUES ('ctx-' \|\| ?, LOWER(?), ?, ?, ?, ?, ?, ?, ?, 'shared', ?, ?)`. Counter chained via in-process `next_node_id` int. |
| `store/store.c` edge inserts | `INSERT INTO cbm_edges` → `INSERT INTO edges (id, source_id, target_id, relation, data, project, created_at) VALUES ('ctx-e' \|\| ?, 'ctx-' \|\| ?, 'ctx-' \|\| ?, ?, ?, ?, ?)`. |
| `pipeline/pipeline.c`, `pipeline/pipeline_incremental.c` | All `cbm_nodes_fts` references → `ctx_nodes_fts`. Any `SELECT … FROM cbm_nodes` → `SELECT … FROM nodes WHERE project = ?` (project filter already present in CBM's CTEs; no logical change beyond the table name). |
| `cypher/`, `traces/`, `discover/` | Same `cbm_nodes`/`cbm_edges` → `nodes`/`edges`; `cbm_projects` → `ctx_projects`. Any column-name references (`label` → `kind`, `type` → `relation`, `properties` → `data`) update. |
| Tests in `internal/cbm/tests/` | CBM's own C tests (2740 of them) are out of scope — they don't run on Cortex's `npm test` and the C-side schema change will break them. Updating CBM's tests is a separate concern (it's our fork; we maintain). For Phase 4 we accept CBM's internal tests broken at this commit and pick them up in a follow-up. Cortex's `npm test` is the merge gate. |

The `kind` column constraint: CBM's existing INSERT statements bind `label` from a string variable; the `LOWER()` is applied inside the INSERT statement so existing C string handling doesn't change. Same for `relation` (formerly `type`).

---

## 3. Implementation order

One branch (`feature/db/native-indexer-schema-fold`), ordered atomic commits. **Tests pass at the tag** (`phase-4-schema-fold`); intermediate commits may have failing tests with explicit "fixed in next task" notes (precedent: Plan 3b had several such states).

The TS-side and C-side schema changes are tightly coupled — splitting them across multiple commits creates intermediate states where tests fail. The plan accepts that and documents it.

**Task 4.1** — Schema delta in `schema.ts`
- Add `start_line`, `end_line`, `project` to `CREATE_TABLES` for `nodes`. Add `project` for `edges`. Add new indexes to `CREATE_INDEXES`.
- Fresh DBs get the right shape from `migrate()` running `CREATE TABLE IF NOT EXISTS …`. Existing DBs unchanged (the new columns aren't added — that's task 4.2's job).
- **Tests:** pass. No behavioral change for existing DBs; fresh DBs get extra unused columns.

**Task 4.2** — TS migration runner
- New `GraphStore.migrateSchemaFold()` method written and wired into `migrate()`.
- Detect-and-migrate pattern per §2.6: probe `cbm_nodes`; if present, run the full migration in a transaction (PRAGMA FK off, ALTER if needed, INSERT…SELECT, DROP, RENAME, FTS rebuild, commit, FK on).
- New `tests/graph/schema-fold-migration.test.ts`: build a fixture cortex.db with `cbm_*` populated by directly invoking the indexer (the v0.3-Phase-3b-shape), then `new GraphStore(path)`, verify post-state has `nodes` rows with `'ctx-'` prefix and no `cbm_*` data tables.
- **Tests:** the new migration test passes. The mcp-contract suite **fails** at this commit, because globalSetup runs the indexer (still writes `cbm_*`), the harness opens GraphStore (migrate() now folds `cbm_*` → nodes), but `code-queries.ts` still queries `cbm_nodes` (now dropped). Task 4.3 closes the gap.

**Task 4.3** — TS query simplification
- `store.ts`: delete `CBM_LABEL_MAP`. Rewrite `getAllNodesUnified`/`getAllEdgesUnified` to query `nodes`/`edges` directly with `WHERE project = ?`.
- `code-queries.ts`: every `FROM cbm_nodes` → `FROM nodes WHERE project = ? AND kind NOT IN ('decision','pr','todo')`. Every `FROM cbm_edges` → `FROM edges WHERE project = ?`. Field references update: `label` → `kind`, `type` → `relation`, `properties` → `data`.
- `code-tools.ts` inline SQL: `cbm_nodes` → `nodes`; `cbm_projects` → `ctx_projects`.
- `index.ts`: `cbm_projects` → `ctx_projects`.
- **Tests:** the contract suite passes again. Indexer still writes `cbm_*` but migration in 4.2 normalizes; queries hit the migrated `nodes`/`edges` correctly.

**Task 4.4** — Indexer C-side rewrite
- `internal/cbm/src/store/store.c` `init_schema`:
  - Drop `cbm_nodes`, `cbm_edges` `CREATE TABLE` blocks (Cortex owns those tables; indexer assumes their existence).
  - Rename `cbm_projects` → `ctx_projects`, `cbm_file_hashes` → `ctx_file_hashes`, `cbm_project_summaries` → `ctx_project_summaries`, `cbm_nodes_fts` → `ctx_nodes_fts` in DDL.
- `store.c` insert helpers:
  - Add in-process `next_node_id`, `next_edge_id` integer counters seeded on store-open via `SELECT IFNULL(MAX(CAST(SUBSTR(id, 5) AS INTEGER)), 0) FROM nodes WHERE id LIKE 'ctx-%'` (and similar for edges).
  - Every `INSERT INTO cbm_nodes (...)` → `INSERT INTO nodes (id, kind, name, qualified_name, file_path, start_line, end_line, data, project, tier, created_at, updated_at)` with `id = 'ctx-' || next_node_id++`, `kind = LOWER(<label-string>)`, `tier = 'shared'`, `created_at = updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.
  - Every `INSERT INTO cbm_edges` → `INSERT INTO edges` with `id = 'ctx-e' || next_edge_id++`, `source_id = 'ctx-' || <int>`, `target_id = 'ctx-' || <int>`, `relation = <type-string>`, `data = <properties-json>`, `created_at = strftime(...)`.
  - FTS linkage: indexer now uses `nodes.rowid` (SQLite-internal autorowid) as the FTS rowid, not the parsed `<int>` from `'ctx-<int>'`. Use `sqlite3_last_insert_rowid()` after each node INSERT.
- `pipeline/pipeline.c` + `pipeline/pipeline_incremental.c`:
  - All `cbm_nodes_fts` → `ctx_nodes_fts`, column `label` → `kind`.
  - All `SELECT … FROM cbm_nodes` → `SELECT … FROM nodes WHERE project = ?`.
  - Same for `cbm_edges` → `edges`.
- `cypher/`, `traces/`, `discover/`: same table+column rename pass.
- `npm install` rebuilds `bin/cortex-indexer`.
- **Tests:** pass. Indexer now writes `nodes`/`edges` directly; migration is permanent no-op because `cbm_nodes` never gets created on fresh DBs.

**Task 4.5** — Test updates
- `tests/graph/code-queries.test.ts`: assertions check `node.kind` instead of `node.label`; ID prefix matches `/^ctx-/`.
- `tests/mcp-contract/code-tools.test.ts`: same updates where output formatting is asserted (currently uses `label` in the formatted line).
- `tests/graph/schema-fold-migration.test.ts`: already added in 4.2; verify it still passes.
- `npm test`: 49 files green.

**Task 4.6** — Verify + tag
- `grep -r "cbm_nodes\|cbm_edges" src/ tests/ internal/cbm/src/`: 0 matches (excluding `internal/cbm/tests/` which is the C-side test corpus, deferred).
- `grep -r "cbm_projects\|cbm_file_hashes\|cbm_project_summaries\|cbm_nodes_fts" src/ tests/ internal/cbm/src/`: 0 matches.
- `cbm-discovery.ts` (preserved for Phase 5 v0.2 migration shim) intentionally retains its legacy `cbm_*` references against the *external* `~/.cache/codebase-memory-mcp/<project>.db` file — that's Phase 5's territory.
- `git tag -a phase-4-schema-fold`.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| **Migration data loss.** The migration drops `cbm_nodes`/`cbm_edges` after copying. If the copy is lossy, data is gone. | Transaction wraps the whole migration; rollback on any error. Add a row-count assertion: `pre.nodes = post.nodes WHERE id LIKE 'ctx-%'` and same for edges. |
| **ID collisions with existing `nodes` rows.** Cortex's existing decisions/PRs/TODOs use ULIDs (e.g. `01HXY…`). The `'ctx-'` prefix can't collide with ULIDs (different prefix charset). Verify before INSERT. | ULIDs use Crockford base32; `ctx-` is impossible as a ULID prefix. Safe by construction. |
| **CBM's C tests break post-Phase-4.** CBM's 2740-test suite tests against `cbm_*` table names and `label`/`type`/`properties` column names. After 4.4 they fail. | CBM tests are out of scope for Phase 4 (don't run in `npm test`). Update them in a follow-up task; track explicitly. |
| **FTS5 rebuild on a populated DB.** `cbm_nodes_fts` → `ctx_nodes_fts` requires drop + recreate + repopulate. On a large indexed repo this may be slow (re-tokenization). | Repopulation runs in the same transaction as the rest. ~10k-node repo measures sub-second; worst-case (~1M nodes) is ~30s. Acceptable for one-time migration. |
| **Foreign key cascade during migration.** `cbm_edges` has `FK source_id REFERENCES cbm_nodes(id) ON DELETE CASCADE`. When we DROP `cbm_nodes`, edges cascade-delete *before* we've copied them. | Order matters: copy edges → copy nodes → drop edges → drop nodes. Or disable FK during migration: `PRAGMA foreign_keys = OFF; … ; PRAGMA foreign_keys = ON;`. Use the PRAGMA approach for clarity. |
| **Concurrent open of cortex.db during migration.** If Cortex's TS and the indexer both try to open the DB during the migration window, behavior is undefined. | The migration is a one-shot run on first GraphStore open after upgrade. The indexer is spawned by Cortex, so it can't run in parallel with GraphStore's startup. Document the expectation. |
| **Mid-migration crash.** Process killed during migration leaves the DB in a half-migrated state. | Single transaction with `BEGIN IMMEDIATE` ensures atomicity. SQLite either commits everything or rolls back. WAL replay on next open resumes the consistent state. |
| **Indexer writes a non-existent column.** Mismatch between what indexer C-side INSERTs and what `nodes` actually has would crash on every index call. | Schema migration runs *before* the indexer is invoked (GraphStore.migrate() in `index.ts` startup, before any subprocess call). The new columns exist before indexer writes. |
| **CBM\_LABEL\_MAP removal breaks the viewer.** Existing viewer styles likely target `function`/`component`/`path`. After Phase 4, kinds are granular (`class`, `method`, `interface`, ...). | Viewer updates are out of scope for Phase 4 — the viewer still renders, just with default styling for unknown kinds. Phase 8 cleanup or a parallel viewer-styling task adapts. Document the regression. |

---

## 5. Out of scope

- **Phase 5 (v0.2 migration shim).** Reading from old `~/.cache/codebase-memory-mcp/<project>.db` files. Phase 4's migration only handles the `cbm_*` → `nodes`/`edges` fold *within* a single cortex.db file. Cross-file v0.2 → v0.3 migration is Phase 5.
- **Viewer styling adaptation.** Granular kinds (class/method/interface/etc.) likely render with default colors after Phase 4. Phase 8 or a parallel viewer task adds explicit styles.
- **CBM's C test suite updates.** ~2740 tests in `internal/cbm/tests/` need rewrites for the new schema. Out of scope here; tracked separately.
- **Type renames.** `CbmNode` / `CbmEdge` / `CbmProject` interfaces in TS keep their names through Phase 4 (the field `label` does become `kind`). Full symbol rename is Phase 8.
- **Storage location move (Phase 7).** `cortex.db` stays at `<install>/.cortex/graph.db`. Repo-root location is Phase 7.

---

## 6. Open questions

1. **Edge `created_at` for migrated rows.** `cbm_edges` doesn't track creation time; we set `datetime('now')` at migration. Is that OK, or do we want to fall back to `cbm_projects.indexed_at` like for nodes? Lean: `datetime('now')` is fine — it's a one-time stamp at migration, not the original indexing time, and downstream code doesn't depend on it.

2. **Code-edge filter in `code-queries.ts`.** When listing "code edges" (e.g., `tracePath`), do we filter by `project = ?` (denormalized) or by `relation IN ('CALLS', 'IMPORTS', ...)`? Lean: filter by `project = ?` — symmetrical with how nodes are filtered, no need to enumerate the code-relation set.

3. **Should `getAllNodesUnified` keep the `cbmProject` parameter?** After the fold, all rows live in one table; the parameter only filters by `project`. Could rename to `getAllNodes(project?)` or keep for diff continuity. Lean: rename — Phase 4 simplifies the signature.

4. **What happens to the `data` JSON shape difference?** CBM's `properties` JSON might have different keys than Cortex's `data` (decision-shape vs code-shape). They share the `data` column but consumers know which keys to expect from the row's `kind`. No structural change needed.

---

## Appendix A — Decisions to capture

To create via `create_decision` after Phase 4 lands:

- **Fold `cbm_nodes` / `cbm_edges` into Cortex's `nodes` / `edges`.** Replaces "indexer keeps its own prefixed tables." Rationale: G2 from the parent spec — one query path for frame extraction, no kind-discriminator-by-table-name. Alternatives: keep prefixed tables with a UNION view (rejected — viewer/query layer becomes view-aware); separate cortex_code db file (rejected — defeats the whole storage retarget).
- **`'ctx-<int>'` ID format for indexer-written rows.** Rationale: visual provenance, minimal C-side change, matches existing 'cbm-' prefix discriminator pattern. Alternatives: ULIDs in C (rejected for now — adds C dependency for no behavioral win), plain numeric strings (rejected — loses provenance).
- **Preserve full CBM label granularity as `kind`.** Replaces Cortex's existing `function`/`component`/`path` collapse. Rationale: schema should be the most-granular signal; viewer can collapse for rendering. Alternatives: Spec's middle ground (function/class/method/file/symbol/module — partial loss); existing collapse (rejected — discards information).
- **Bookkeeping tables renamed `cbm_*` → `ctx_*`.** Rationale: tables are first-class Cortex schema now, not subordinated under "CBM"; `ctx_` prefix marks Cortex ownership and parallels existing naming.

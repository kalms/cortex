# Native Indexer Storage Retarget (C-side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the absorbed indexer (`internal/cbm/`) capable of writing into a single shared SQLite file (specified via `CORTEX_DB` env var) instead of per-project files under `~/.cache/codebase-memory-mcp/`. Within that shared file, all CBM tables get a `cbm_` prefix to avoid collisions with Cortex's existing `nodes`/`edges` schema.

**Architecture:** A small foundation helper (`cbm_resolve_db_path`) reads the `CORTEX_DB` env var and falls back to the existing per-project resolution when unset. The helper is called from two places: the pipeline (write path) and `resolve_store` (read path). All SQL inside CBM that references tables `projects` / `nodes` / `edges` / `nodes_fts` (plus their indexes) gets renamed to the `cbm_*` prefix in a single mechanical refactor.

**Tech Stack:** C (CBM core), tree-sitter, sqlite3, CBM's existing `TEST()` macro framework. No TS changes in this plan — that's Plan 3b.

---

## Spec reference

`docs/superpowers/specs/2026-05-03-native-indexer-cbm-absorption-design.md` §3 Step 3 ("Indexer storage retarget"). This plan covers the C-side half. Plan 3b (separate file, written after this lands) covers the TS-side ATTACH removal + CORTEX_DB plumbing from Cortex's process to the indexer subprocess.

## Why split into 3a (this plan) and 3b

Spec §3 Step 3's validation criterion is end-to-end ("Cortex's TS query layer points at the same file and `tests/mcp-contract/` passes"). Implementing that as one plan would entangle 4 weeks of C surgery with TS changes across `store.ts`, `cbm-queries.ts`, `index.ts`, `cbm-discovery.ts` — and the TS side can't usefully validate until the C side is done. Split lets us:

- Verify the C-side independently against CBM's own test suite (2736 tests).
- After 3a lands, the indexer binary supports `CORTEX_DB` but Cortex still uses ATTACH (the old path keeps working). 3b then flips the TS side over.
- Keeps each PR/merge boundary digestible.

## File structure

**Files modified (this plan only):**

```
internal/cbm/
├── src/
│   ├── foundation/
│   │   ├── platform.h           ← new declaration: cbm_resolve_db_path
│   │   └── platform.c           ← new function body (~15 lines)
│   ├── store/
│   │   └── store.c              ← cbm_ prefix on CREATE TABLE / INDEX / VIRTUAL TABLE
│   ├── pipeline/
│   │   └── pipeline.c           ← else branch at line 620 calls helper
│   ├── mcp/
│   │   └── mcp.c                ← project_db_path() body uses helper; also update SQL refs
│   └── (many *.c files)         ← SQL string updates wherever nodes/edges/projects are referenced
└── tests/
    ├── test_platform.c          ← new file: tests for cbm_resolve_db_path
    └── (existing test files)    ← table-name updates only where they reference SQL directly
```

**Files NOT touched in this plan:**

- Any file under `src/` (Cortex TS) — that's Plan 3b.
- `internal/cbm/src/main.c` — the run_cli wrapper doesn't need changes.
- `internal/cbm/src/mcp/mcp.c`'s MCP server logic — only the SQL strings inside it.

## Branch

Continues on `feature/api/native-indexer`. Each task ends in a commit. After all tasks merge, we tag `phase-3a-storage-retarget`.

---

## Task 3a.1 — Foundation helper `cbm_resolve_db_path`

**Files:**
- Modify: `internal/cbm/src/foundation/platform.h`
- Modify: `internal/cbm/src/foundation/platform.c`
- Modify: `internal/cbm/tests/test_platform.c` (existing file — append 4 tests + update SUITE)

> **Heads-up:** `test_platform.c` already exists with 8 tests covering `cbm_now_ns`, `cbm_file_exists`, etc. Add new tests to it; don't create a new file. The platform suite is already wired into `test_main.c` (via `extern void suite_platform(void)` declaration), so no `test_main.c` changes are needed either.

- [ ] **Step 1: Read existing patterns**

```bash
sed -n '95,105p' internal/cbm/src/foundation/platform.h
sed -n '358,375p' internal/cbm/src/foundation/platform.c
head -15 internal/cbm/tests/test_platform.c
tail -15 internal/cbm/tests/test_platform.c
```

Note the docstring style of `cbm_resolve_cache_dir()` (the new helper follows the same shape — env var override + filesystem fallback). Note the existing `SUITE(platform) { ... }` block at the bottom of `test_platform.c` — the new tests are registered inside it.

- [ ] **Step 2: Append the failing tests to test_platform.c**

Find the line `SUITE(platform) {` in `internal/cbm/tests/test_platform.c`. Insert these 4 TEST() blocks immediately ABOVE that SUITE block (so the test functions are defined before SUITE references them):

```c
TEST(resolve_db_path_uses_cortex_db_env) {
    setenv("CORTEX_DB", "/tmp/cortex-test-resolve.db", 1);
    char buf[1024];
    const char *result = cbm_resolve_db_path("anyproject", buf, sizeof(buf));
    ASSERT_NOT_NULL(result);
    ASSERT_STR_EQ(result, "/tmp/cortex-test-resolve.db");
    unsetenv("CORTEX_DB");
    PASS();
}

TEST(resolve_db_path_falls_back_to_cache_dir_when_env_unset) {
    unsetenv("CORTEX_DB");
    char buf[1024];
    const char *result = cbm_resolve_db_path("myproj", buf, sizeof(buf));
    ASSERT_NOT_NULL(result);
    /* Should end in "/myproj.db" — exact prefix depends on platform's cache dir */
    size_t n = strlen(result);
    ASSERT_TRUE(n > strlen("/myproj.db"));
    ASSERT_STR_EQ(result + n - strlen("/myproj.db"), "/myproj.db");
    PASS();
}

TEST(resolve_db_path_handles_null_project_in_env_mode) {
    setenv("CORTEX_DB", "/tmp/cortex-test-null.db", 1);
    char buf[1024];
    const char *result = cbm_resolve_db_path(NULL, buf, sizeof(buf));
    /* When CORTEX_DB is set, project is not consulted — should return env value */
    ASSERT_NOT_NULL(result);
    ASSERT_STR_EQ(result, "/tmp/cortex-test-null.db");
    unsetenv("CORTEX_DB");
    PASS();
}

TEST(resolve_db_path_returns_null_with_null_project_and_no_env) {
    unsetenv("CORTEX_DB");
    char buf[1024];
    const char *result = cbm_resolve_db_path(NULL, buf, sizeof(buf));
    ASSERT_NULL(result);
    PASS();
}
```

If `<stdlib.h>` and `<string.h>` aren't already included, add them to the top of the file.

- [ ] **Step 3: Register the new tests in the SUITE block**

Inside `SUITE(platform) { ... }`, after the existing `RUN_TEST(...)` lines, add:

```c
    RUN_TEST(resolve_db_path_uses_cortex_db_env);
    RUN_TEST(resolve_db_path_falls_back_to_cache_dir_when_env_unset);
    RUN_TEST(resolve_db_path_handles_null_project_in_env_mode);
    RUN_TEST(resolve_db_path_returns_null_with_null_project_and_no_env);
```

- [ ] **Step 4: Run the test, verify it fails with "undefined reference to cbm_resolve_db_path"**

```bash
(cd internal/cbm && make -f Makefile.cbm test 2>&1 | tail -10)
```

Expected: link error or compile error mentioning `cbm_resolve_db_path`. Don't proceed until you see the failure — that confirms the test is reaching the helper.

- [ ] **Step 5: Add the declaration**

In `internal/cbm/src/foundation/platform.h`, find the `cbm_resolve_cache_dir` declaration (around line 101) and add directly below it:

```c
/* Resolve the SQLite database path to use for indexing.
 *
 * Priority:
 *   1. CORTEX_DB env var if set — used verbatim, ignores `project`.
 *   2. Per-project file at <cache_dir>/<project>.db (existing default).
 *
 * Writes the resolved path into `buf` (size `bufsz`) and returns it on success.
 * Returns NULL when CORTEX_DB is unset AND `project` is NULL — caller error.
 *
 * Used by the pipeline (write path) and resolve_store (read path) so both
 * honor the CORTEX_DB unification when set.
 */
const char *cbm_resolve_db_path(const char *project, char *buf, size_t bufsz);
```

- [ ] **Step 6: Add the implementation**

In `internal/cbm/src/foundation/platform.c`, find the end of `cbm_resolve_cache_dir` (around line 380) and add directly below:

```c
const char *cbm_resolve_db_path(const char *project, char *buf, size_t bufsz) {
    if (!buf || bufsz == 0) {
        return NULL;
    }
    char tmp[CBM_SZ_1K];
    cbm_safe_getenv("CORTEX_DB", tmp, sizeof(tmp), NULL);
    if (tmp[0]) {
        snprintf(buf, bufsz, "%s", tmp);
        return buf;
    }
    if (!project) {
        return NULL;
    }
    const char *cdir = cbm_resolve_cache_dir();
    if (!cdir) {
        cdir = cbm_tmpdir();
    }
    snprintf(buf, bufsz, "%s/%s.db", cdir, project);
    return buf;
}
```

Verify includes — if `CBM_SZ_1K` is not yet visible at this site, find where it's defined (likely `foundation/types.h` or `foundation/sizes.h`) and add the include.

- [ ] **Step 7: Run the test to verify it passes**

```bash
(cd internal/cbm && make -f Makefile.cbm test 2>&1 | grep -E "test_platform|FAIL|PASS|✓|✗" | head -20)
```

Expected: 4 test cases all pass. If the test_platform.c file isn't being picked up, revisit Step 3.

- [ ] **Step 8: Run CBM's full test suite (regression check)**

```bash
(cd internal/cbm && make -f Makefile.cbm test 2>&1 | tail -10)
```

Expected: pass count is 2736 + 4 = 2740 (or near — the SFC branch may have moved the baseline). No new failures.

- [ ] **Step 9: Commit**

```bash
git add internal/cbm/src/foundation/platform.h internal/cbm/src/foundation/platform.c internal/cbm/tests/test_platform.c
git commit -m "feat(foundation): add cbm_resolve_db_path with CORTEX_DB env var support

Helper resolves the SQLite db path from CORTEX_DB env (single shared file)
or falls back to <cache_dir>/<project>.db (existing per-project behavior).

This is the foundation hook that lets Cortex point CBM at a single shared
cortex.db. Pipeline + resolve_store consume it in subsequent commits.

Tests: 4 cases covering env-set, env-unset, null-project + env-set,
null-project + env-unset.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3a.2 — Apply `cbm_` prefix to CBM's CREATE statements

**Files:**
- Modify: `internal/cbm/src/store/store.c` (table names in CREATE TABLE / INDEX / VIRTUAL TABLE)

- [ ] **Step 1: Inventory the CREATE statements**

```bash
grep -nE "CREATE TABLE|CREATE INDEX|CREATE VIRTUAL TABLE" internal/cbm/src/store/store.c
```

Expected: 3 tables (`projects`, `nodes`, `edges`), 1 virtual table (`nodes_fts`), 7 indexes. All in `store.c`.

- [ ] **Step 2: Apply the prefix to CREATE TABLE statements**

In `internal/cbm/src/store/store.c`, edit each of the three `CREATE TABLE IF NOT EXISTS` statements (around lines 215, 228, 240):

- `CREATE TABLE IF NOT EXISTS projects (` → `CREATE TABLE IF NOT EXISTS cbm_projects (`
- `CREATE TABLE IF NOT EXISTS nodes (` → `CREATE TABLE IF NOT EXISTS cbm_nodes (`
- `CREATE TABLE IF NOT EXISTS edges (` → `CREATE TABLE IF NOT EXISTS cbm_edges (`

If these tables have foreign-key references to each other inline in the DDL (e.g. `REFERENCES nodes(id)`), update those references too — they need the prefix.

- [ ] **Step 3: Apply the prefix to CREATE VIRTUAL TABLE**

Around line 271:
- `CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(` → `CREATE VIRTUAL TABLE IF NOT EXISTS cbm_nodes_fts USING fts5(`

If FTS5 has a `content=nodes` option referring to the source table, update it to `content=cbm_nodes`.

- [ ] **Step 4: Apply the prefix to CREATE INDEX statements**

Around lines 286–292, each index references a table. Update both the index name and the table:

- `idx_nodes_label ON nodes(...)` → `idx_cbm_nodes_label ON cbm_nodes(...)`
- `idx_nodes_name ON nodes(...)` → `idx_cbm_nodes_name ON cbm_nodes(...)`
- `idx_nodes_file ON nodes(...)` → `idx_cbm_nodes_file ON cbm_nodes(...)`
- `idx_edges_source ON edges(...)` → `idx_cbm_edges_source ON cbm_edges(...)`
- `idx_edges_target ON edges(...)` → `idx_cbm_edges_target ON cbm_edges(...)`
- `idx_edges_type ON edges(...)` → `idx_cbm_edges_type ON cbm_edges(...)`
- `idx_edges_target_type ON edges(...)` → `idx_cbm_edges_target_type ON cbm_edges(...)`
- `idx_edges_source_type ON edges(...)` → `idx_cbm_edges_source_type ON cbm_edges(...)`

- [ ] **Step 5: Check for any FTS5 triggers**

```bash
grep -nE "CREATE TRIGGER|cbm_nodes|nodes_fts|fts.*after" internal/cbm/src/store/store.c | head -15
```

If FTS5 triggers exist (after-insert/update/delete on nodes), update both their names and the `nodes` references inside them.

- [ ] **Step 6: Build and observe failures**

```bash
(cd internal/cbm && make -f Makefile.cbm cbm 2>&1 | tail -10)
```

Expected: build succeeds (we only changed string literals; the C compiles cleanly). The runtime breakage is what comes next — every SQL query elsewhere in CBM still expects unprefixed table names. Task 3a.3 fixes that.

- [ ] **Step 7: Commit**

```bash
git add internal/cbm/src/store/store.c
git commit -m "refactor(store): prefix CBM tables/indexes/virtual tables with cbm_

CREATE TABLE / INDEX / VIRTUAL TABLE statements in store.c now produce
cbm_projects, cbm_nodes, cbm_edges, cbm_nodes_fts, idx_cbm_nodes_*,
idx_cbm_edges_*. Avoids collision with Cortex's existing nodes/edges
schema when both share a single SQLite file (Phase 3 storage unification).

Note: SQL queries elsewhere in CBM still reference the old names — fixed
in the next commit. Build still succeeds; runtime SQL fails until 3a.3
lands.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3a.3 — Apply `cbm_` prefix to all DML SQL strings

This is the bulk refactor. CBM has ~68 SQL strings referencing `nodes` / `edges` / `projects` / `nodes_fts`. They live in many files (`mcp.c`, `pipeline.c`, `pipeline_incremental.c`, `extract_*.c`, etc.).

Strategy: do it in 3 sub-steps grouped by file region. Each sub-step is one commit. Run CBM's test suite after each — failures tell us which strings we missed.

**Files (likely):**
- `internal/cbm/src/mcp/mcp.c`
- `internal/cbm/src/pipeline/pipeline.c`
- `internal/cbm/src/pipeline/pipeline_incremental.c`
- `internal/cbm/src/store/*.c` (DML — UPDATE/INSERT/DELETE statements)
- `internal/cbm/src/extract_*.c`
- `internal/cbm/src/cypher/*.c` (if it exposes the table names)
- `internal/cbm/src/semantic/*.c`

### Task 3a.3a — Prefix DML in store/ and pipeline/

- [ ] **Step 1: Inventory references in store/ and pipeline/**

```bash
grep -rnE "FROM (nodes|edges|projects|nodes_fts)\b|INTO (nodes|edges|projects|nodes_fts)\b|UPDATE (nodes|edges|projects)\b|DELETE FROM (nodes|edges|projects)\b|JOIN (nodes|edges|projects)\b" internal/cbm/src/store/ internal/cbm/src/pipeline/ 2>/dev/null
```

Note the count and list each file:line. Approximate count: ~25–35.

- [ ] **Step 2: Apply prefix using sed where unambiguous**

For mechanical refactors, sed is faster than Edit-tool surgery. WARNING: this is sed-on-source — back up first or use git as the safety net.

```bash
# Backup state via git (already committed as of 3a.2 — clean tree)
git status -sb | head -3

# Pattern 1: FROM <table>  →  FROM cbm_<table>
# Apply only to .c/.h files in store/ and pipeline/, only inside string literals (sed isn't context-aware,
# but in CBM these table names only appear inside SQL string literals — verify by inspection after).

for tbl in nodes edges projects nodes_fts; do
  for dir in internal/cbm/src/store internal/cbm/src/pipeline; do
    find "$dir" -type f \( -name "*.c" -o -name "*.h" \) -exec \
      sed -i '' -E "s/\b(FROM|INTO|UPDATE|JOIN) ${tbl}\b/\1 cbm_${tbl}/g" {} \;
    find "$dir" -type f \( -name "*.c" -o -name "*.h" \) -exec \
      sed -i '' -E "s/\bDELETE FROM ${tbl}\b/DELETE FROM cbm_${tbl}/g" {} \;
  done
done
```

(`sed -i ''` is the macOS form; on Linux use `sed -i`.)

- [ ] **Step 3: Inspect what changed**

```bash
git diff --stat internal/cbm/src/store/ internal/cbm/src/pipeline/
git diff internal/cbm/src/store/ internal/cbm/src/pipeline/ | head -80
```

Expected: each changed line is inside a string literal (look for surrounding `"` characters or `R"sql(` raw strings). If any change touched non-SQL code (e.g. a comment or function name), revert that file with `git checkout -- <path>` and apply Edit-tool changes manually.

- [ ] **Step 4: Catch the patterns sed missed**

The sed above doesn't catch:
- `nodes(...)` in CREATE INDEX context (handled in 3a.2 already — should be no-op here)
- Bare references like `WHERE nodes.id = ...` (column-qualified)
- References inside multi-line raw SQL strings spanning newlines

Run:
```bash
grep -rnE "(WHERE|AND|OR) (nodes|edges|projects)\.\w+|GROUP BY (nodes|edges|projects)\." internal/cbm/src/store/ internal/cbm/src/pipeline/
```

For each match, update the column qualifier (e.g. `WHERE nodes.id` → `WHERE cbm_nodes.id`).

- [ ] **Step 5: Build and run CBM tests**

```bash
(cd internal/cbm && make -f Makefile.cbm test 2>&1 | tail -20)
```

Expected: most tests fail because the rest of the codebase (Tasks 3a.3b/3a.3c targets) still references unprefixed names AND/OR the prefixed-and-unprefixed worlds collide (e.g. JOIN cbm_nodes across to nodes-without-prefix). That's expected at this intermediate state. **Don't try to fix all of it here — the failures are surfacing what 3a.3b and 3a.3c need to address.**

- [ ] **Step 6: Commit**

```bash
git add internal/cbm/src/store/ internal/cbm/src/pipeline/
git commit -m "refactor(store,pipeline): prefix DML SQL with cbm_ table names

Mechanical sed refactor: FROM/INTO/UPDATE/DELETE/JOIN <table> →
<keyword> cbm_<table> across store/ and pipeline/. Plus column-qualified
WHERE/GROUP BY references.

Tests fail at this intermediate state — extract_*.c and mcp.c still
reference unprefixed names. Fixed in subsequent commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3a.3b — Prefix DML in extract/ and semantic/

- [ ] **Step 1: Inventory and apply same sed pattern**

```bash
grep -rnE "FROM (nodes|edges|projects|nodes_fts)\b|INTO (nodes|edges|projects|nodes_fts)\b|UPDATE (nodes|edges|projects)\b|DELETE FROM (nodes|edges|projects)\b|JOIN (nodes|edges|projects)\b" internal/cbm/src/extract_*.c internal/cbm/src/semantic/ 2>/dev/null

for tbl in nodes edges projects nodes_fts; do
  for path in internal/cbm/src/extract_*.c internal/cbm/src/semantic; do
    find $path -type f \( -name "*.c" -o -name "*.h" \) 2>/dev/null -exec \
      sed -i '' -E "s/\b(FROM|INTO|UPDATE|JOIN) ${tbl}\b/\1 cbm_${tbl}/g" {} \;
    find $path -type f \( -name "*.c" -o -name "*.h" \) 2>/dev/null -exec \
      sed -i '' -E "s/\bDELETE FROM ${tbl}\b/DELETE FROM cbm_${tbl}/g" {} \;
  done
done
```

- [ ] **Step 2: Catch column-qualified misses**

```bash
grep -rnE "(WHERE|AND|OR|GROUP BY) (nodes|edges|projects)\.\w+" internal/cbm/src/extract_*.c internal/cbm/src/semantic/ 2>/dev/null
```

Update each manually with Edit tool (column-qualified references are too context-sensitive for safe sed).

- [ ] **Step 3: Verify diff is SQL-only**

```bash
git diff --stat
git diff | head -100
```

If any non-SQL line was touched, revert and re-apply manually.

- [ ] **Step 4: Build (don't run tests yet — mcp.c still broken)**

```bash
(cd internal/cbm && make -f Makefile.cbm cbm 2>&1 | tail -5)
```

Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add internal/cbm/src/extract_*.c internal/cbm/src/semantic/ 2>/dev/null
git commit -m "refactor(extract,semantic): prefix DML SQL with cbm_ table names

Extends 3a.3a's sed refactor to extract_*.c and semantic/. Tests still
fail at this intermediate state — mcp.c is the last remaining holdout.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3a.3c — Prefix DML in mcp/ (and any remaining stragglers)

- [ ] **Step 1: Inventory all remaining unprefixed references**

```bash
grep -rnE "FROM (nodes|edges|projects|nodes_fts)\b|INTO (nodes|edges|projects|nodes_fts)\b|UPDATE (nodes|edges|projects)\b|DELETE FROM (nodes|edges|projects)\b|JOIN (nodes|edges|projects)\b" internal/cbm/src/ 2>/dev/null | grep -v "cbm_"
```

Expected: matches in `mcp/mcp.c` and possibly stragglers in other files. Note all of them.

- [ ] **Step 2: Apply sed to remaining files**

```bash
for tbl in nodes edges projects nodes_fts; do
  for f in $(grep -rlE "(FROM|INTO|UPDATE|JOIN|DELETE FROM) ${tbl}\b" internal/cbm/src/ 2>/dev/null | grep -v "store\|pipeline\|extract\|semantic"); do
    sed -i '' -E "s/\b(FROM|INTO|UPDATE|JOIN) ${tbl}\b/\1 cbm_${tbl}/g" "$f"
    sed -i '' -E "s/\bDELETE FROM ${tbl}\b/DELETE FROM cbm_${tbl}/g" "$f"
  done
done
```

- [ ] **Step 3: Sweep for column-qualified, hand-fix**

```bash
grep -rnE "(WHERE|AND|OR|GROUP BY|ORDER BY) (nodes|edges|projects)\.\w+" internal/cbm/src/ 2>/dev/null | grep -v "cbm_"
```

For each match, update with Edit tool.

- [ ] **Step 4: Sweep for any remaining unprefixed table refs in SQL strings**

```bash
grep -rnE "\"[^\"]*\b(nodes|edges|projects|nodes_fts)\b[^\"]*\"" internal/cbm/src/ 2>/dev/null | grep -v "cbm_" | grep -vE "\"#.*nodes|\"#.*edges|//.*nodes|//.*edges"
```

This catches tables inside double-quoted strings that aren't preceded by `cbm_`. Some matches will be false positives (e.g. comments, error messages mentioning these names). Inspect each match; if it's an SQL string, prefix it. If it's a doc/error string and unrelated to schema, leave alone.

Hint patterns:
- `"SELECT * FROM nodes WHERE ..."` → must update
- `"failed to insert into nodes"` (error message) → can stay (cosmetic only) but updating to `cbm_nodes` is also fine for consistency
- `// comment about nodes` → leave alone

- [ ] **Step 5: Build CBM**

```bash
(cd internal/cbm && make -f Makefile.cbm cbm 2>&1 | tail -5)
```

Expected: clean build.

- [ ] **Step 6: Run CBM's full test suite**

```bash
(cd internal/cbm && make -f Makefile.cbm test 2>&1 | tail -15)
```

Expected: all 2740 tests pass (2736 from before + 4 from Task 3a.1). If any fail with messages mentioning `no such table: nodes` or `no such column: nodes.id`, you missed a SQL string — grep for the failing query in source and prefix it.

If tests fail for unrelated reasons (e.g. semantic test depends on absolute paths), surface in commit message but don't block.

- [ ] **Step 7: Commit**

```bash
git add internal/cbm/src/
git commit -m "refactor(mcp): prefix remaining DML SQL with cbm_ table names

Final pass — mcp.c plus stragglers in any other module. After this commit
CBM's test suite is fully green again at 2740 tests passing.

Net result of 3a.2 + 3a.3 (a/b/c): all CBM tables/indexes/virtual tables
are prefixed with cbm_, and all SQL queries reference them by their
prefixed names.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3a.4 — Route pipeline + resolve_store through `cbm_resolve_db_path`

**Files:**
- Modify: `internal/cbm/src/pipeline/pipeline.c` (lines around 620)
- Modify: `internal/cbm/src/mcp/mcp.c` (function `project_db_path` around line 681)

- [ ] **Step 1: Update pipeline.c's else branch**

In `internal/cbm/src/pipeline/pipeline.c` around line 615–626, replace:

```c
    if (p->db_path) {
        snprintf(db_path, sizeof(db_path), "%s", p->db_path);
    } else {
        const char *cdir = cbm_resolve_cache_dir();
        if (!cdir) {
            cdir = cbm_tmpdir();
        }
        snprintf(db_path, sizeof(db_path), "%s/%s.db", cdir, p->project_name);
    }
```

With:

```c
    if (p->db_path) {
        snprintf(db_path, sizeof(db_path), "%s", p->db_path);
    } else {
        cbm_resolve_db_path(p->project_name, db_path, sizeof(db_path));
    }
```

(The header `foundation/platform.h` is likely already included; if not, add it.)

If there's a similar pattern around line 171 in pipeline.c (the inventory in spec exploration showed `if (p->db_path) snprintf(path, 1024, "%s", p->db_path);`), update it the same way.

- [ ] **Step 2: Update pipeline_incremental.c if it has the same pattern**

```bash
grep -nE "cbm_resolve_cache_dir|p->db_path" internal/cbm/src/pipeline/pipeline_incremental.c
```

Apply the same substitution if the pattern exists there.

- [ ] **Step 3: Update mcp.c's project_db_path**

In `internal/cbm/src/mcp/mcp.c` around line 681, replace:

```c
static const char *project_db_path(const char *project, char *buf, size_t bufsz) {
    char dir[CBM_SZ_1K];
    cache_dir(dir, sizeof(dir));
    snprintf(buf, bufsz, "%s/%s.db", dir, project);
    return buf;
}
```

With:

```c
static const char *project_db_path(const char *project, char *buf, size_t bufsz) {
    return cbm_resolve_db_path(project, buf, bufsz);
}
```

The local `cache_dir` helper at line 671 may now have only one caller (line 788 / 880 — verify). If still used, leave it. If it becomes dead, leave it for Task 3a.5 cleanup.

- [ ] **Step 4: Build**

```bash
(cd internal/cbm && make -f Makefile.cbm cbm 2>&1 | tail -5)
```

Expected: clean build.

- [ ] **Step 5: Run CBM tests**

```bash
(cd internal/cbm && make -f Makefile.cbm test 2>&1 | tail -10)
```

Expected: still 2740 passing. CBM's existing tests don't set `CORTEX_DB`, so they exercise the fallback branch — same behavior as before.

- [ ] **Step 6: Manual end-to-end test of CORTEX_DB routing**

```bash
rm -f /tmp/cortex-test.db
CORTEX_DB=/tmp/cortex-test.db (cd internal/cbm && ./build/c/codebase-memory-mcp cli index_repository "{\"repo_path\":\"$(pwd)\"}") 2>&1 | tail -5
ls -lh /tmp/cortex-test.db
sqlite3 /tmp/cortex-test.db ".tables"
```

Expected: `/tmp/cortex-test.db` is created; tables listed include `cbm_projects`, `cbm_nodes`, `cbm_edges`, `cbm_nodes_fts*`. Nothing in `~/.cache/codebase-memory-mcp/` got created for this run.

```bash
sqlite3 /tmp/cortex-test.db "SELECT COUNT(*) FROM cbm_nodes; SELECT COUNT(*) FROM cbm_edges;"
```

Expected: nonzero counts.

- [ ] **Step 7: Commit**

```bash
git add internal/cbm/src/pipeline/ internal/cbm/src/mcp/mcp.c
git commit -m "feat(storage): route pipeline + resolve_store through cbm_resolve_db_path

Pipeline's default-db-path resolution and resolve_store's project_db_path
helper both consult cbm_resolve_db_path now. When CORTEX_DB is set, all
indexer ops write to that single shared file (with cbm_ table prefixes
preventing collision with Cortex's existing schema). When unset, behavior
is identical to before — per-project files under ~/.cache/codebase-memory-mcp/.

End-to-end test: CORTEX_DB=/tmp/test.db cli index_repository populates
cbm_projects/cbm_nodes/cbm_edges in the shared file; nothing under
~/.cache/codebase-memory-mcp/.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3a.5 — Cortex test harness sanity check

**Files:** none modified — verifying the C-side changes don't break Cortex's existing TS test suite.

After 3a.1–3a.4, the indexer binary now:
- Prefixes all its tables with `cbm_`.
- Honors `CORTEX_DB` env var when set.

Cortex's TS code currently uses ATTACH-based queries against the OLD per-project file at `~/.cache/codebase-memory-mcp/<project>.db`. That file's schema now has `cbm_` prefixes too (since the binary that wrote it is the new one). Existing Cortex queries that say `FROM cbm.nodes` (note the `cbm.` schema prefix from ATTACH, not the table prefix) will now fail to find the table — they need to say `FROM cbm.cbm_nodes`.

This is expected. Plan 3b fixes it. For now, we just verify what's currently broken vs. what continues to work.

- [ ] **Step 1: Run Cortex's test suite**

```bash
npm test 2>&1 | tail -15
```

Expected: some failures in mcp-contract tests that exercise the indexer. The failures should be SQL errors mentioning missing tables (e.g. `no such table: cbm.nodes`). That confirms the diagnosis. The non-CBM tests (decisions, PRs, viewer) should still pass.

If unit tests for `code-tools.ts` fail with errors NOT related to the table prefix (e.g. binary missing, env var issues), that's a real regression — surface it.

- [ ] **Step 2: Document the pass/fail breakdown**

In a comment-only commit (or in the next commit's message), record:
- `npm test` total: X passed / Y failed
- Failing test files: list
- Sample failure message confirming "no such table: cbm.nodes" or similar
- This is expected; Plan 3b fixes by updating cbm-queries.ts

No new commit if the only change is an observation. Phase 3a tag is set in Step 3.

- [ ] **Step 3: Tag the Phase 3a milestone**

```bash
git tag -a phase-3a-storage-retarget -m "Phase 3a: CBM C-side honors CORTEX_DB; tables prefixed cbm_*"
git tag -l 'phase-*'
```

---

## Self-review checklist (against spec §3 Step 3)

After completing all tasks, verify:

- [ ] **Spec §3 Step 3 paragraph 1** — `CORTEX_DB` env var implemented in CBM (Task 3a.1, 3a.4) ✓
- [ ] **Spec §3 Step 3 paragraph 2** — `cbm_` prefix applied to all CBM tables/indexes/queries (Tasks 3a.2, 3a.3) ✓
- [ ] **Spec §3 Step 3 paragraph 3** — "Cortex's TS read layer queries `cbm_nodes` / `cbm_edges`" — **deferred to Plan 3b** ✓ (called out explicitly)
- [ ] **Spec §3 Step 3 validation** — `bin/cortex-indexer cli index_repository --db-path ./test.db` populates `cbm_projects/cbm_nodes/cbm_edges` — verified manually in Task 3a.4 Step 6 ✓
- [ ] **Spec G2** (code entities live in cortex.db's `nodes`/`edges` alongside decisions) — **NOT yet achieved**. Phase 3 lands the structural prefix; Phase 4 folds `cbm_*` tables into Cortex's `nodes`/`edges`. Phase 3a + 3b is the prerequisite.
- [ ] **CBM's 2736-test baseline** — preserved, plus 4 new platform tests for `cbm_resolve_db_path`. Total: 2740.

## Out of scope (deferred)

- Any TS changes — Plan 3b
- Removing CBM's per-project file fallback — both modes coexist; deprecation later
- Schema fold (cbm_* → unified nodes/edges) — Plan for Phase 4
- v0.2 user data migration — Plan for Phase 5

## Risk: sed-driven refactor

Task 3a.3's bulk sed across many files is the riskiest task. Mitigations:
- Each sub-task (3a.3a/3a.3b/3a.3c) commits separately so a bad sed can be isolated and reverted.
- After each sed, a `git diff` inspection verifies all changes are inside SQL string literals.
- After the final sub-task, CBM's full test suite acts as a regression check (any missed reference produces a "no such table" SQLite error).
- The 2740-test bar is the green light; below that, something's wrong.

If the sed approach proves too fragile (e.g. matches inside comments or non-SQL strings causing false changes), fall back to `Edit` tool with surrounding-context strings, file by file. Slower but safer.

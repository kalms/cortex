# Incremental In-Place Persist + Post-Commit Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the incremental indexer persist its merged graph without unlinking the live `.cortex/db`, so an already-open handle (the MCP server's pooled connection) survives a refresh and sees it — then ship the deferred post-commit refresh hook.

**Architecture:** Replace `dump_and_persist`'s `unlink` + B-tree re-dump with: B-tree-dump to a temp sibling DB, backfill hashes + FTS on the temp, then page-copy the temp into the live inode via the existing tested `ctx_store_restore_from` (SQLite online backup), then `ctx_store_checkpoint`. With incremental now inode-safe, register a `PostToolUse` `git commit` hook that runs `cortex index` (auto-routes to incremental).

**Tech Stack:** C (indexer: `internal/indexer/`), the in-tree C test framework (`tests/test_framework.h`), bash hooks, SQLite (WAL + online backup API).

**Spec:** [docs/superpowers/specs/2026-06-07-incremental-in-place-persist-design.md](../specs/2026-06-07-incremental-in-place-persist-design.md)

---

## File Structure

- `internal/indexer/src/pipeline/pipeline_incremental.c` — rewrite the `static dump_and_persist` (currently lines 259-299) to the temp-dump + `restore_from` + checkpoint flow; add two retry constants to the file's top `enum`. No signature change; the single caller at line 430 is untouched.
- `internal/indexer/tests/test_incremental.c` — add one integration test (`incr_inplace_preserves_inode`) and register it in the `RUN_TEST` list.
- `hooks/post-commit-refresh.sh` — new hook script.
- `hooks/hooks.json` — add a sibling hook to the existing `PostToolUse → Bash` matcher.
- `CLAUDE.md`, `HANDOFF.md` — doc updates reflecting that auto-refresh is now also post-commit, not SessionStart-only.

---

## Task 1: Inode-preserving `dump_and_persist`

**Files:**
- Modify: `internal/indexer/src/pipeline/pipeline_incremental.c:14` (enum) and `:259-299` (`dump_and_persist`)
- Test: `internal/indexer/tests/test_incremental.c` (new `TEST` + `RUN_TEST` registration)

- [ ] **Step 1: Write the failing test**

Add this test in `internal/indexer/tests/test_incremental.c` immediately after `TEST(incr_modify_file) { … }` (after line 410). It captures the live DB inode and a reader handle opened *before* the refresh, runs an incremental index, and asserts the inode is unchanged and the pre-existing handle sees the new data.

```c
TEST(incr_inplace_preserves_inode) {
    /* The live DB exists from earlier tests (incr_full_index ran first). */
    struct stat st_before;
    ASSERT_EQ(stat(g_dbpath, &st_before), 0);
    ino_t ino_before = st_before.st_ino;
    ASSERT_GT((long)ino_before, 0);

    /* A handle opened BEFORE the refresh — simulates the MCP server's pooled
     * connection. It must stay valid and observe the refreshed graph. */
    ctx_store_t *pre = ctx_store_open_path(g_dbpath);
    ASSERT(pre != NULL);
    int count_pre = ctx_store_count_nodes(pre, g_project);
    ASSERT_GT(count_pre, 0);

    /* Mutate a source file and run an incremental index. */
    char path[512];
    snprintf(path, sizeof(path), "%s/fastapi/applications.py", g_repodir);
    FILE *f = fopen(path, "a");
    ASSERT(f != NULL);
    fprintf(f, "\n\ndef incr_inode_probe_fn(z: int) -> int:\n    return z * 2\n");
    fclose(f);

    char *resp = index_repo();
    ASSERT(resp != NULL);
    ASSERT(strstr(resp, "indexed") != NULL);
    free(resp);

    /* The live file must be the SAME inode — never unlinked+recreated. */
    struct stat st_after;
    ASSERT_EQ(stat(g_dbpath, &st_after), 0);
    ASSERT_EQ((long)st_after.st_ino, (long)ino_before);

    /* The handle opened before the refresh sees the new node on a fresh query. */
    int count_post = ctx_store_count_nodes(pre, g_project);
    ASSERT_GT(count_post, count_pre);
    ctx_store_close(pre);

    PASS();
}
```

Register it by adding this line to the `RUN_TEST` list, immediately after the `RUN_TEST(incr_modify_file);` entry:

```c
    RUN_TEST(incr_inplace_preserves_inode);
```

- [ ] **Step 2: Build the integration tests and run to verify it FAILS**

Run:
```bash
make -f internal/indexer/Makefile.indexer test-integration 2>&1 | tail -30
```
Expected: `incr_inplace_preserves_inode` FAILS on the inode assertion (`st_after.st_ino != ino_before`) because the current `dump_and_persist` calls `ctx_unlink(db_path)` and recreates the file with a new inode.

- [ ] **Step 3: Add the retry constants to the file enum**

In `internal/indexer/src/pipeline/pipeline_incremental.c`, extend the existing `enum` on line 14. Change:

```c
enum { INCR_RING_BUF = 4, INCR_RING_MASK = 3, INCR_TS_BUF = 24, INCR_WAL_BUF = 1040 };
```
to:
```c
enum { INCR_RING_BUF = 4, INCR_RING_MASK = 3, INCR_TS_BUF = 24, INCR_WAL_BUF = 1040,
       INCR_RESTORE_RETRIES = 5, INCR_RESTORE_BACKOFF_MS = 20 };
```

- [ ] **Step 4: Rewrite `dump_and_persist`**

Replace the entire `dump_and_persist` function (lines 259-299) with the version below. It dumps to `<db_path>.tmp`, backfills hashes + FTS on the temp, page-copies into the live inode (retrying on transient `SQLITE_BUSY` from a concurrent reader), checkpoints, and always cleans up the temp. On any failure the live DB is left untouched.

```c
/* Persist the merged graph WITHOUT unlinking the live DB.  Dump to a temp
 * sibling DB (B-tree writer — carries nodes + edges + vectors), backfill file
 * hashes + FTS on the temp, then page-copy the temp into the live inode via
 * ctx_store_restore_from (SQLite online backup).  Because the live file is never
 * unlinked, any handle already open on it (e.g. the MCP server's pooled
 * connection) stays valid and sees the refresh on its next read.  On any failure
 * the live DB is left untouched (old-but-consistent). */
static void dump_and_persist(ctx_gbuf_t *gbuf, const char *db_path, const char *project,
                             ctx_file_info_t *files, int file_count) {
    struct timespec t;
    ctx_clock_gettime(CLOCK_MONOTONIC, &t);

    char tmp[INCR_WAL_BUF];
    char tmp_wal[INCR_WAL_BUF];
    char tmp_shm[INCR_WAL_BUF];
    snprintf(tmp, sizeof(tmp), "%s.tmp", db_path);
    snprintf(tmp_wal, sizeof(tmp_wal), "%s-wal", tmp);
    snprintf(tmp_shm, sizeof(tmp_shm), "%s-shm", tmp);

    /* Clean any stale temp from a previous interrupted run (temp only — never
     * the live DB). */
    ctx_unlink(tmp);
    ctx_unlink(tmp_wal);
    ctx_unlink(tmp_shm);

    int dump_rc = ctx_gbuf_dump_to_sqlite(gbuf, tmp);
    ctx_log_info("incremental.dump", "rc", itoa_buf(dump_rc), "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t)));
    if (dump_rc != 0) {
        ctx_unlink(tmp);
        ctx_unlink(tmp_wal);
        ctx_unlink(tmp_shm);
        return; /* live DB untouched */
    }

    /* Backfill hashes + FTS on the TEMP db so the single page copy carries a
     * complete, ready database into the live inode. */
    ctx_store_t *tmp_store = ctx_store_open_path(tmp);
    if (tmp_store) {
        persist_hashes(tmp_store, project, files, file_count);

        /* FTS5 rebuild: the btree dump bypasses triggers, so rebuild nodes_fts
         * from the nodes table (mirrors the prior incremental dump path). */
        ctx_store_exec(tmp_store, "INSERT INTO ctx_nodes_fts(ctx_nodes_fts) VALUES('delete-all');");
        if (ctx_store_exec(tmp_store,
                           "INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) "
                           "SELECT CAST(SUBSTR(id, 5) AS INTEGER), ctx_camel_split(name), "
                           "qualified_name, kind, file_path "
                           "FROM nodes WHERE project IS NOT NULL;") != CTX_STORE_OK) {
            ctx_store_exec(tmp_store,
                           "INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) "
                           "SELECT CAST(SUBSTR(id, 5) AS INTEGER), name, qualified_name, kind, "
                           "file_path FROM nodes WHERE project IS NOT NULL;");
        }
    }

    /* Page-copy temp -> live, preserving the live inode + open handles.  Retry on
     * transient SQLITE_BUSY from a concurrent reader (e.g. the MCP server). */
    ctx_store_t *live = ctx_store_open_path(db_path);
    if (live && tmp_store) {
        int rc = CTX_STORE_ERR;
        for (int attempt = 0; attempt < INCR_RESTORE_RETRIES; attempt++) {
            rc = ctx_store_restore_from(live, tmp_store);
            if (rc == CTX_STORE_OK) {
                break;
            }
            ctx_usleep((unsigned)INCR_RESTORE_BACKOFF_MS * 1000U);
        }
        if (rc == CTX_STORE_OK) {
            ctx_store_checkpoint(live);
            ctx_log_info("incremental.persist", "path", "in_place", "elapsed_ms",
                         itoa_buf((int)elapsed_ms(t)));
        } else {
            ctx_log_error("incremental.persist", "phase", "restore_from");
        }
    }
    if (live) {
        ctx_store_close(live);
    }
    if (tmp_store) {
        ctx_store_close(tmp_store);
    }

    ctx_unlink(tmp);
    ctx_unlink(tmp_wal);
    ctx_unlink(tmp_shm);
}
```

Add the include for `ctx_usleep` if not already present — it lives in `foundation/compat.h`, which is already included via the header chain (`compat_fs.h` is included at line 25; `ctx_usleep` is in `compat.h`). If the build reports `ctx_usleep` undeclared, add `#include "foundation/compat.h"` to the include block (lines 22-26).

- [ ] **Step 5: Rebuild and run the test to verify it PASSES**

Run:
```bash
make -f internal/indexer/Makefile.indexer test-integration 2>&1 | tail -30
```
Expected: `incr_inplace_preserves_inode` PASSES, and all other `incr_*` tests still pass (especially `incr_modify_file`, `incr_add_file`, `incr_delete_file`, `incr_accuracy_vs_full`, `incr_db_deleted_recovery`).

- [ ] **Step 6: Run the full C test suite to confirm no regression**

Run:
```bash
make -f internal/indexer/Makefile.indexer test 2>&1 | tail -20
```
Expected: no NEW failures versus the pre-change baseline. (Per HANDOFF, ~191 pre-existing stale-fixture failures in the store/schema suites are known and unrelated; compare counts, do not require zero.)

- [ ] **Step 7: Commit**

```bash
git add internal/indexer/src/pipeline/pipeline_incremental.c internal/indexer/tests/test_incremental.c
git commit -m "feat(indexer): inode-preserving incremental persist (temp dump + restore_from)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Rebuild the shipped binary and verify the TS suite

**Files:** none (build + verify only)

- [ ] **Step 1: Rebuild the indexer binary**

Run:
```bash
CORTEX_FORCE_REBUILD=1 bash scripts/build-indexer.sh 2>&1 | tail -15
```
Expected: build succeeds and `bin/cortex-indexer` is updated (newer mtime).

- [ ] **Step 2: Confirm the binary is in place**

Run:
```bash
ls -la bin/cortex-indexer && bin/cortex-indexer --version 2>/dev/null || true
```
Expected: the binary exists and is freshly built.

- [ ] **Step 3: Run the full TS test suite**

Run:
```bash
npm test 2>&1 | tail -25
```
Expected: all TS tests green (the suite was 802/802 at last HANDOFF; no persistence change touches TS, so the count should hold).

- [ ] **Step 4: Verify in-place refresh end-to-end on this repo**

Run (capture the inode across an incremental index):
```bash
B=$(stat -f %i .cortex/db); ./bin/cortex index changes >/dev/null 2>&1; ./bin/cortex index >/dev/null 2>&1; A=$(stat -f %i .cortex/db); echo "inode before=$B after=$A"; ./bin/cortex freshness
```
Expected: `before` == `after` (same inode), and `cortex freshness` prints `fresh`.

- [ ] **Step 5: Commit (binary)**

```bash
git add bin/cortex-indexer
git commit -m "build(indexer): rebuild binary with in-place incremental persist

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Ship the post-commit incremental refresh hook (Task 10)

**Files:**
- Create: `hooks/post-commit-refresh.sh`
- Modify: `hooks/hooks.json`

- [ ] **Step 1: Write the hook script**

Create `hooks/post-commit-refresh.sh` with exactly:

```sh
#!/usr/bin/env bash
# PostToolUse hook (fires only on `git commit*` via the hooks.json `if`):
# refresh the index incrementally so the graph tracks the new HEAD. Safe to run
# mid-session now that incremental persist is inode-preserving (the live
# .cortex/db is never unlinked, so the MCP server's open handle survives).
# Best-effort and silent; gated by CORTEX_AUTO_REFRESH.
set -u
[ "${CORTEX_AUTO_REFRESH:-1}" = "0" ] && exit 0
CORTEX_BIN="${CLAUDE_PLUGIN_ROOT:-.}/bin/cortex"
[ -x "$CORTEX_BIN" ] || CORTEX_BIN="$(command -v cortex || echo ./bin/cortex)"
"$CORTEX_BIN" index >/dev/null 2>&1 || true
exit 0
```

- [ ] **Step 2: Make it executable**

Run:
```bash
chmod +x hooks/post-commit-refresh.sh
```

- [ ] **Step 3: Register the hook in `hooks/hooks.json`**

In `hooks/hooks.json`, the `PostToolUse → Bash` matcher's `hooks` array currently holds one object (`suggest-capture.sh`, `"if": "Bash(git commit*)"`). Add a SECOND object to that same array so it reads:

```json
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/suggest-capture.sh",
            "if": "Bash(git commit*)"
          },
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/post-commit-refresh.sh",
            "if": "Bash(git commit*)"
          }
        ]
      }
    ]
```

- [ ] **Step 4: Validate the JSON parses**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8')); console.log('hooks.json OK')"
```
Expected: `hooks.json OK`.

- [ ] **Step 5: Manually verify the refresh fires on commit**

Run (simulates what the hook does, since hook firing needs a live session):
```bash
echo "# probe" >> README.md && git add README.md && git commit -q -m "test: post-commit refresh probe"
B=$(stat -f %i .cortex/db); CLAUDE_PLUGIN_ROOT=. bash hooks/post-commit-refresh.sh; A=$(stat -f %i .cortex/db)
echo "inode before=$B after=$A"; ./bin/cortex freshness
git reset --soft HEAD~1 && git restore --staged README.md && git checkout README.md
```
Expected: the script exits 0, the inode is unchanged, `cortex freshness` reports `fresh`. (The final line reverts the probe commit + file edit.)

- [ ] **Step 6: Commit**

```bash
git add hooks/post-commit-refresh.sh hooks/hooks.json
git commit -m "feat(hook): post-commit incremental index refresh (PostToolUse)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Documentation + decision capture

**Files:**
- Modify: `CLAUDE.md` (freshness section), `HANDOFF.md`

- [ ] **Step 1: Update the CLAUDE.md freshness note**

In `CLAUDE.md`, the freshness section currently says auto-refresh "runs out-of-band at SessionStart." Update that sentence to note it now ALSO runs on `git commit` via a `PostToolUse` hook (still gated by `CORTEX_AUTO_REFRESH=0`), and that incremental indexing is now inode-preserving so mid-session refresh is safe. Keep it to 1-2 sentences in the existing paragraph — do not restructure the section.

- [ ] **Step 2: Update HANDOFF.md**

Replace the "▶ NEXT STEP — make incremental indexing in-place" section in `HANDOFF.md` with a short "✅ DONE" entry: incremental persist is now inode-preserving (A2: temp dump + `ctx_store_restore_from` + checkpoint), Task 10 post-commit refresh shipped, and Approach C (per-file delta) remains a documented future optimization (link the spec). State the verification: inode unchanged across incremental, `cortex freshness` = fresh, TS suite green.

- [ ] **Step 3: Capture the decision**

Run the decision capture against THIS repo (note the explicit `repo_path`):

```
search_decisions({ repo_path: "/Users/rka/Development/cortex", query: "incremental in-place persist inode restore_from" })
create_decision({
  repo_path: "/Users/rka/Development/cortex",
  title: "Incremental persist is inode-preserving via temp-dump + restore_from (A2)",
  description: "dump_and_persist no longer unlinks .cortex/db; it B-tree-dumps to a temp sibling then page-copies into the live inode via ctx_store_restore_from + checkpoint.",
  rationale: "Unlinking the live DB pinned the MCP server's pooled handle to a deleted inode (graph-db-stale-reads). Page-copy into the open file preserves the inode and makes the refresh visible, unblocking the post-commit refresh (Task 10).",
  alternatives: "A (row-by-row flush_to_store: no vector path + slower); B (temp + rename: new inode, server handle never updates); C (true per-file delta: optimization, deferred — own cycle).",
  governs: ["internal/indexer/src/pipeline/pipeline_incremental.c", "hooks/post-commit-refresh.sh"]
})
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md HANDOFF.md
git commit -m "docs: incremental in-place persist + post-commit refresh (shipped)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **`stat -f %i`** is the macOS (BSD) flag for inode number (the dev environment is darwin). On Linux use `stat -c %i`. Adjust the manual-verification commands in Tasks 2/3 if running on Linux.
- **Cross-process `SQLITE_BUSY`:** the in-process test cannot exercise a real concurrent reader holding a write-blocking lock; the retry loop in `dump_and_persist` is the mitigation, and the live MCP-server scenario is covered by the Task 2/3 manual steps. If the binary deadlocks or repeatedly logs `restore_from` failures under a running server, that is the signal to revisit (the spec names row-flush Approach A as the fallback persistence mechanism).
- **Gate 2 (QA before merge):** this branch is backend + hooks (no UI), so Gate 0 visual QA is skipped per the workflow rules; run the `qa` agent (or `npm test` + a clean incremental index + `cortex freshness`) before merging to `main` with `--no-ff`.
```

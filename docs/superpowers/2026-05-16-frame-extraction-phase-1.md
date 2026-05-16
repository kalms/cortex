# Frame Extraction — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Phase 1 index-stats survey from
[docs/specs/cortex-v0.3/frame-extraction.md](../specs/cortex-v0.3/frame-extraction.md):
a Node/TS script that clones a corpus of GitHub repos, runs
`cortex-indexer` over each, collects `(entity_count, edge_density,
directory_depth, language_mix)`, and produces calibration data for the
complexity-threshold and α/β/γ tuning that gates Phase 2.

**Architecture:** Two concerns:
1. **Indexer error envelope (Task 0).** The current `index_repository`
   MCP response returns `{project, status:"error"}` with no reason. The
   survey runner will fail-mysteriously on the first malformed repo
   without a fix. Add a `last_error_phase` field to the pipeline,
   surface it via a getter, validate `repo_path` exists up front, and
   include `error`/`error_phase` in the JSON envelope.
2. **Survey script (Tasks 1–9).** Pure TS under `scripts/frame-extraction/`,
   executed via `tsx`. Clones into `.tmp/frame-extraction/corpus/`
   (gitignored), shells out to `bin/cortex-indexer`, reads stats from
   the resulting `.cortex/graph.db` via the indexer's CLI tools
   (`get_architecture`, `query_graph`), augments with a filesystem walk
   for depth/extension data (catches auxiliary content not in the graph
   per open question §6 of the spec), and emits per-repo JSONL + a
   markdown report.

**Tech Stack:**
- C side: existing indexer build (`make -f Makefile.indexer indexer`),
  test framework in `internal/indexer/tests/test_framework.h`,
  yyjson for JSON construction.
- TS side: tsx, vitest, node built-ins only (`child_process`, `fs`,
  `path`). No new deps. Reuses `bin/cortex-indexer cli <tool>` as the
  graph data source.

---

## File Structure

**Task 0 (C, native indexer):**

- Modify: `internal/indexer/src/pipeline/pipeline.h` — add
  `ctx_pipeline_last_error_phase` getter declaration.
- Modify: `internal/indexer/src/pipeline/pipeline.c` — add
  `last_error_phase` field on `struct ctx_pipeline`, set it at each
  `pipeline.err` log site and at non-zero rc returns from
  `run_extraction_phase` / `run_post_extraction`, and free it on
  cleanup; implement the getter.
- Modify: `internal/indexer/src/handlers/handlers.c` lines 1499–1580
  (`handle_index_repository`) — validate `repo_path` is a readable
  directory before invoking the pipeline; on `rc != 0`, include
  `"error"` and `"error_phase"` fields in the JSON envelope.
- Modify: `internal/indexer/tests/test_pipeline.c` — add a test that
  `ctx_pipeline_last_error_phase` returns `"discover"` after running
  against `/tmp/nonexistent-cortex-survey`.
- Modify: `internal/indexer/tests/test_integration.c` (or add a small
  unit test in `test_pipeline.c` using `ctx_mcp_handle_tool`) — assert
  the error envelope contains `error_phase: "discover"` and a non-empty
  `error` string for a nonexistent path.
- Modify: `internal/indexer/Makefile.indexer` — only if a new test file
  was added; otherwise no change.

**Tasks 1–9 (TS, survey script):**

- Create: `scripts/frame-extraction/corpus.json` — starter corpus
  (8 repos spanning archetypes).
- Create: `scripts/frame-extraction/types.ts` — `RepoSpec`, `RepoStats`,
  `IndexerEnvelope`, `SurveyResult`.
- Create: `scripts/frame-extraction/clone.ts` — shallow git clone +
  cached re-use.
- Create: `scripts/frame-extraction/indexer.ts` — wrapper around
  `bin/cortex-indexer cli <tool>`; parses the MCP envelope into
  `{ok, data, error}`.
- Create: `scripts/frame-extraction/graph-stats.ts` — derive
  `entity_count`, `edge_count`, `edge_density`, top-level node-label
  counts from `get_architecture(aspects=["structure"])`.
- Create: `scripts/frame-extraction/fs-stats.ts` — walk the cloned
  repo, compute max + mean directory depth and an extension histogram
  (auxiliary content discoverable via filesystem only).
- Create: `scripts/frame-extraction/survey.ts` — orchestrator entry
  point. For each repo: clone → index → collect graph + fs stats →
  append to JSONL.
- Create: `scripts/frame-extraction/report.ts` — read the JSONL, emit
  a markdown report (distribution table + suggested complexity
  threshold).
- Create: `tests/frame-extraction/graph-stats.test.ts` — pure-fn tests
  on fixture envelopes.
- Create: `tests/frame-extraction/fs-stats.test.ts` — pure-fn tests on
  a fixture directory tree.
- Create: `tests/frame-extraction/report.test.ts` — pure-fn tests on
  fixture `SurveyResult` arrays.
- Create: `tests/frame-extraction/indexer.test.ts` — envelope parsing.
- Modify: `package.json` — add `"survey:phase1": "tsx scripts/frame-extraction/survey.ts"`
  and `"survey:report": "tsx scripts/frame-extraction/report.ts"`.
- Create (generated, committed): `docs/specs/cortex-v0.3/phase-1-results.md`
  — output of the report run.
- (`.tmp/frame-extraction/` is already gitignored — no change needed.)

---

## Task 0: Fix the indexer error envelope

The current envelope on failure is `{project, status:"error"}`. No
reason. Survey debugging is impossible. Fix before building the survey.

**Files:**
- Modify: `internal/indexer/src/pipeline/pipeline.h:50`
- Modify: `internal/indexer/src/pipeline/pipeline.c:98-111,809-893`
- Modify: `internal/indexer/src/handlers/handlers.c:1499-1580`
- Modify: `internal/indexer/tests/test_pipeline.c`

- [ ] **Step 1: Add a failing test for the pipeline getter**

Append to `internal/indexer/tests/test_pipeline.c` before the
`RUN_TEST` calls at the bottom (find the `pipeline_cancel_sets_flag`
block; add adjacent):

```c
TEST(pipeline_last_error_phase_discover) {
    /* On a nonexistent repo path, discovery fails and the pipeline
     * should report "discover" as the last failing phase. */
    ctx_pipeline_t *p = ctx_pipeline_new("/tmp/cortex-nonexistent-xyz",
                                         NULL, CTX_MODE_FULL);
    ASSERT_NOT_NULL(p);
    int rc = ctx_pipeline_run(p);
    ASSERT_NE(rc, 0);
    const char *phase = ctx_pipeline_last_error_phase(p);
    ASSERT_NOT_NULL(phase);
    ASSERT_STR_EQ(phase, "discover");
    ctx_pipeline_free(p);
    PASS();
}

TEST(pipeline_last_error_phase_null_on_success) {
    /* Success run leaves last_error_phase NULL. We can't run a full
     * indexing here without a fixture repo, so just verify that a
     * fresh pipeline reports NULL before run. */
    ctx_pipeline_t *p = ctx_pipeline_new("/tmp", NULL, CTX_MODE_FULL);
    ASSERT_NOT_NULL(p);
    ASSERT_NULL(ctx_pipeline_last_error_phase(p));
    ctx_pipeline_free(p);
    PASS();
}
```

Then register both in the `main()` `RUN_TEST` block adjacent to
`RUN_TEST(pipeline_cancel_sets_flag);`:

```c
RUN_TEST(pipeline_last_error_phase_discover);
RUN_TEST(pipeline_last_error_phase_null_on_success);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd internal/indexer && make -f Makefile.indexer test_pipeline && ./build/c/test_pipeline 2>&1 | tail -20
```

Expected: build error — `ctx_pipeline_last_error_phase` undeclared.

- [ ] **Step 3: Add the field + getter declaration**

In `internal/indexer/src/pipeline/pipeline.h`, add after the existing
`ctx_pipeline_get_mode` declaration around line 60:

```c
/* Returns the phase ("discover", "extraction", "post", "dump",
 * "cache_alloc") at which the last run failed, or NULL if no run
 * has been started or the last run succeeded. Borrowed pointer,
 * valid until ctx_pipeline_free or next ctx_pipeline_run. */
const char *ctx_pipeline_last_error_phase(const ctx_pipeline_t *p);
```

In `internal/indexer/src/pipeline/pipeline.c`, extend the struct at
line 98–111:

```c
struct ctx_pipeline {
    char *repo_path;
    char *db_path;
    char *project_name;
    ctx_index_mode_t mode;
    atomic_int cancelled;

    /* Indexing state (set during run) */
    ctx_gbuf_t *gbuf;
    ctx_registry_t *registry;

    /* User-defined extension overrides (loaded once per run) */
    ctx_userconfig_t *userconfig;

    /* Last failing phase from ctx_pipeline_run. NULL on success or
     * before first run. Owned by pipeline; freed on next run + on
     * pipeline_free. Set via set_error_phase() helper below. */
    char *last_error_phase;
};
```

- [ ] **Step 4: Set the phase at every failure site**

In `internal/indexer/src/pipeline/pipeline.c`, add a static helper
near the top of the file (after the `itoa_buf` helper around line 130):

```c
static void set_error_phase(ctx_pipeline_t *p, const char *phase) {
    if (!p) return;
    free(p->last_error_phase);
    p->last_error_phase = phase ? heap_strdup(phase) : NULL;
}
```

(If `heap_strdup` isn't in scope here, use `strdup` — check what the
rest of the file uses. Search for `heap_strdup` in this file; if it
isn't already used inside pipeline.c, fall back to `strdup`.)

In `ctx_pipeline_run` at line 809, clear the phase at the top:

```c
int ctx_pipeline_run(ctx_pipeline_t *p) {
    if (!p) {
        return CTX_NOT_FOUND;
    }
    set_error_phase(p, NULL);  /* reset before the run */

    CTX_PROF_START(t_pipeline_total);
    ...
```

At line 834-836 (discover failure):

```c
    int rc = ctx_discover(p->repo_path, &opts, &files, &file_count);
    if (rc != 0) {
        set_error_phase(p, "discover");
        ctx_log_error("pipeline.err", "phase", "discover", "rc", itoa_buf(rc));
    }
```

At line 537 (cache_alloc):

```c
        set_error_phase(p, "cache_alloc");
        ctx_log_error("pipeline.err", "phase", "cache_alloc");
```

At line 660 (dump):

```c
        set_error_phase(p, "dump");
        ctx_log_error("pipeline.err", "phase", "dump");
```

At line 867-870 (extraction phase) and 872-875 (post-extraction):

```c
    rc = run_extraction_phase(p, &ctx, files, file_count);
    if (rc != 0) {
        set_error_phase(p, "extraction");
        goto cleanup;
    }

    rc = run_post_extraction(p, &ctx, files, file_count);
    if (rc != 0) {
        set_error_phase(p, "post");
        goto cleanup;
    }
```

Implement the getter near the bottom of the file:

```c
const char *ctx_pipeline_last_error_phase(const ctx_pipeline_t *p) {
    return p ? p->last_error_phase : NULL;
}
```

Free it in `ctx_pipeline_free` (find the existing free path —
search `void ctx_pipeline_free` — and add):

```c
    free(p->last_error_phase);
    p->last_error_phase = NULL;
```

- [ ] **Step 5: Run the C tests to verify they pass**

```bash
cd internal/indexer && make -f Makefile.indexer test_pipeline && ./build/c/test_pipeline 2>&1 | grep -E "pipeline_last_error|FAIL|Pass"
```

Expected: both new tests pass.

- [ ] **Step 6: Add a failing test for the JSON envelope**

In `internal/indexer/tests/test_integration.c` (or a new section in
`test_pipeline.c` if `test_integration.c` already drags too many
fixtures), add:

```c
TEST(index_repository_error_envelope_has_phase) {
    /* When indexing fails, the JSON response must include error
     * and error_phase fields so callers can diagnose. */
    ctx_mcp_server_t *srv = ctx_mcp_server_new(NULL);
    ASSERT_NOT_NULL(srv);

    const char *args = "{\"repo_path\":\"/tmp/cortex-nonexistent-xyz\"}";
    char *resp = ctx_mcp_handle_tool(srv, "index_repository", args);
    ASSERT_NOT_NULL(resp);

    /* Response is the MCP envelope: {"content":[{"type":"text","text":"..."}], "isError":true}.
     * The inner text is JSON-encoded. Just substring-check; full parse
     * is overkill for this assertion. */
    ASSERT_TRUE(strstr(resp, "\"status\":\"error\"") != NULL);
    ASSERT_TRUE(strstr(resp, "\"error_phase\":\"discover\"") != NULL);
    ASSERT_TRUE(strstr(resp, "\"error\":") != NULL);
    /* Make sure there's a non-empty message */
    ASSERT_TRUE(strstr(resp, "\"error\":\"\"") == NULL);

    free(resp);
    ctx_mcp_server_free(srv);
    PASS();
}
```

Register it in `main()` alongside the other integration tests.

- [ ] **Step 7: Run the test to verify it fails**

```bash
cd internal/indexer && make -f Makefile.indexer test_integration && ./build/c/test_integration 2>&1 | tail -10
```

Expected: FAIL — envelope has no `error_phase` field yet.

- [ ] **Step 8: Wire phase + repo_path validation into the handler**

In `internal/indexer/src/handlers/handlers.c`, modify
`handle_index_repository` starting at line 1499:

```c
static char *handle_index_repository(ctx_mcp_server_t *srv, const char *args) {
    char *repo_path = ctx_mcp_get_string_arg(args, "repo_path");
    char *mode_str = ctx_mcp_get_string_arg(args, "mode");
    ctx_normalize_path_sep(repo_path);

    if (!repo_path) {
        free(mode_str);
        return ctx_mcp_text_result("repo_path is required", true);
    }

    /* Early validation: repo_path must exist and be a directory. */
    struct stat st;
    if (stat(repo_path, &st) != 0 || !S_ISDIR(st.st_mode)) {
        yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
        yyjson_mut_val *root = yyjson_mut_obj(doc);
        yyjson_mut_doc_set_root(doc, root);
        char *project_name = ctx_project_name_from_path(repo_path);
        yyjson_mut_obj_add_str(doc, root, "project",
                               project_name ? project_name : "(unknown)");
        yyjson_mut_obj_add_str(doc, root, "status", "error");
        yyjson_mut_obj_add_str(doc, root, "error_phase", "validate");
        char msg[CTX_SZ_4K];
        snprintf(msg, sizeof(msg),
                 "repo_path does not exist or is not a directory: %s",
                 repo_path);
        yyjson_mut_obj_add_str(doc, root, "error", msg);
        char *json = yyjson_mut_write(doc, 0, NULL);
        yyjson_mut_doc_free(doc);
        free(project_name);
        free(repo_path);
        free(mode_str);
        char *result = ctx_mcp_text_result(json, true);
        free(json);
        return result;
    }

    ctx_index_mode_t mode = CTX_MODE_FULL;
    /* ... existing mode-parsing block ... */
```

Then at the result-construction block around line 1549–1554, replace:

```c
    yyjson_mut_obj_add_str(doc, root, "project", project_name);
    yyjson_mut_obj_add_str(doc, root, "status", rc == 0 ? "indexed" : "error");

    if (rc == 0) {
        /* ... existing success block ... */
    } else {
        const char *phase = ctx_pipeline_last_error_phase(p);
        yyjson_mut_obj_add_str(doc, root, "error_phase",
                               phase ? phase : "unknown");
        char msg[CTX_SZ_512];
        snprintf(msg, sizeof(msg),
                 "indexing failed at phase '%s' (rc=%d). "
                 "Check stderr for pipeline.err logs.",
                 phase ? phase : "unknown", rc);
        yyjson_mut_obj_add_str(doc, root, "error", msg);
    }
```

⚠️ Note: at the point of the `else` block, `p` (the pipeline pointer)
has already been freed on line 1538 with `ctx_pipeline_free(p)`. The
phase must be captured **before** `ctx_pipeline_free` is called.
Insert above line 1538:

```c
    /* Capture failure phase before freeing the pipeline. Owned copy
     * because the getter returns a borrowed pointer. */
    char *captured_error_phase = NULL;
    if (rc != 0) {
        const char *phase = ctx_pipeline_last_error_phase(p);
        captured_error_phase = phase ? heap_strdup(phase) : NULL;
    }
    ctx_pipeline_free(p);
```

Then use `captured_error_phase` in the else block above and
`free(captured_error_phase)` after the JSON is built.

(Add `#include <sys/stat.h>` at the top of `handlers.c` if not already
present — grep the file first.)

- [ ] **Step 9: Run all indexer tests to verify they pass**

```bash
cd internal/indexer && make -f Makefile.indexer test_pipeline test_integration && \
  ./build/c/test_pipeline 2>&1 | tail -5 && \
  ./build/c/test_integration 2>&1 | tail -5
```

Expected: all tests pass, including the two new ones.

- [ ] **Step 10: Rebuild the bin and smoke-test from the project root**

```bash
CORTEX_FORCE_REBUILD=1 bash scripts/build-indexer.sh
bin/cortex-indexer cli index_repository '{"repo_path":"/tmp/nonexistent-cortex"}' 2>&1 | tail -3
```

Expected output (whitespace may vary):
```
{"content":[{"type":"text","text":"{\"project\":\"tmp-nonexistent-cortex\",\"status\":\"error\",\"error_phase\":\"validate\",\"error\":\"repo_path does not exist or is not a directory: /tmp/nonexistent-cortex\"}"}],"isError":true}
```

- [ ] **Step 11: Run the project test suite to confirm nothing else broke**

```bash
npm test 2>&1 | tail -15
```

Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add internal/indexer/src/pipeline/pipeline.h \
        internal/indexer/src/pipeline/pipeline.c \
        internal/indexer/src/handlers/handlers.c \
        internal/indexer/tests/test_pipeline.c \
        internal/indexer/tests/test_integration.c
git commit -m "$(cat <<'EOF'
feat(indexer): include error_phase + message in index_repository envelope

The MCP response for a failed index_repository call previously contained only
{project, status:"error"} — no reason. Add a last_error_phase field to the
pipeline, set at each pipeline.err log site, and surface it (plus a human
message) through the JSON envelope. Also early-validate that repo_path is
an existing directory and report "validate" phase + the offending path
when it isn't.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: Branch + corpus.json

**Files:**
- Create: `scripts/frame-extraction/corpus.json`

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b feature/frame-extraction/phase-1-stats-survey
```

- [ ] **Step 2: Write the starter corpus**

Create `scripts/frame-extraction/corpus.json`:

```json
{
  "$schema_version": 1,
  "comment": "Phase 1 calibration corpus. Mix of archetypes per docs/specs/cortex-v0.3/frame-extraction.md Verification §Phase 1. Indexer language support gates inclusion: TS/JS/Python/Go are first-class; Swift and others may be limited. Adjust before running.",
  "repos": [
    {
      "slug": "self/cortex",
      "git": null,
      "local_path": ".",
      "archetype": "ts-monorepo",
      "size_hint": "medium",
      "primary_language": "typescript"
    },
    {
      "slug": "vueuse/vueuse",
      "git": "https://github.com/vueuse/vueuse.git",
      "archetype": "vue-library",
      "size_hint": "medium",
      "primary_language": "typescript"
    },
    {
      "slug": "TanStack/table",
      "git": "https://github.com/TanStack/table.git",
      "archetype": "react-library",
      "size_hint": "medium",
      "primary_language": "typescript"
    },
    {
      "slug": "trpc/trpc",
      "git": "https://github.com/trpc/trpc.git",
      "archetype": "ts-monorepo",
      "size_hint": "medium",
      "primary_language": "typescript"
    },
    {
      "slug": "nuxt/ui",
      "git": "https://github.com/nuxt/ui.git",
      "archetype": "nuxt-app",
      "size_hint": "medium",
      "primary_language": "typescript"
    },
    {
      "slug": "spf13/cobra",
      "git": "https://github.com/spf13/cobra.git",
      "archetype": "go-cli",
      "size_hint": "small",
      "primary_language": "go"
    },
    {
      "slug": "pallets/click",
      "git": "https://github.com/pallets/click.git",
      "archetype": "python-library",
      "size_hint": "small",
      "primary_language": "python"
    },
    {
      "slug": "huggingface/peft",
      "git": "https://github.com/huggingface/peft.git",
      "archetype": "python-ml",
      "size_hint": "medium",
      "primary_language": "python"
    }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/frame-extraction/corpus.json
git commit -m "feat(frame-extraction): seed Phase 1 corpus with 8 cross-archetype repos"
```

---

## Task 2: Shared TS types

**Files:**
- Create: `scripts/frame-extraction/types.ts`

- [ ] **Step 1: Write the types module**

```ts
// scripts/frame-extraction/types.ts

export interface RepoSpec {
  slug: string;
  git: string | null;          // null = use local_path (no clone)
  local_path?: string;         // resolved relative to repo root
  archetype: string;
  size_hint: "small" | "medium" | "large";
  primary_language: string;
}

export interface CorpusFile {
  $schema_version: number;
  comment?: string;
  repos: RepoSpec[];
}

/** Successful or failed result of one MCP call. */
export type IndexerEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; status: string; error_phase: string; error: string; raw: string };

export interface NodeLabelCount {
  label: string;
  count: number;
}

export interface GraphStats {
  total_nodes: number;
  total_edges: number;
  edge_density: number;
  node_labels: NodeLabelCount[];
  /** Sum of function + class + method + interface + type — the entity_count
   *  used by frame-extraction.md §Verification "complexity score". */
  entity_count: number;
}

export interface FsStats {
  file_count: number;
  max_depth: number;
  mean_depth: number;
  /** Map from extension (with leading dot, lowercased) → count. */
  extension_histogram: Record<string, number>;
  /** Auxiliary-path hits per the path-pattern list from
   *  frame-extraction.md §Two content streams Group A. */
  auxiliary_directories: string[];
}

export type RepoStatus =
  | { ok: true; stats: GraphStats & FsStats }
  | { ok: false; phase: "clone" | "index" | "graph_stats" | "fs_stats"; message: string };

export interface SurveyResult {
  slug: string;
  archetype: string;
  size_hint: string;
  primary_language: string;
  commit_sha: string | null;
  result: RepoStatus;
  /** Wall-clock seconds for the (clone + index + stats) pipeline. */
  elapsed_seconds: number;
}
```

- [ ] **Step 2: Verify it type-checks**

```bash
npx tsc --noEmit --moduleResolution node --module esnext --target es2022 scripts/frame-extraction/types.ts
```

Expected: no output (clean compile).

- [ ] **Step 3: Commit**

```bash
git add scripts/frame-extraction/types.ts
git commit -m "feat(frame-extraction): define shared types for Phase 1 survey"
```

---

## Task 3: Indexer CLI wrapper + tests

**Files:**
- Create: `scripts/frame-extraction/indexer.ts`
- Create: `tests/frame-extraction/indexer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/indexer.test.ts
import { describe, it, expect } from "vitest";
import { parseEnvelope } from "../../scripts/frame-extraction/indexer.js";

describe("parseEnvelope", () => {
  it("returns ok=true with parsed payload on success", () => {
    const raw = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ project: "x", status: "indexed", nodes: 10 }) }],
    });
    const result = parseEnvelope<{ project: string; status: string; nodes: number }>(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.nodes).toBe(10);
      expect(result.data.status).toBe("indexed");
    }
  });

  it("returns ok=false with phase + message on error envelope", () => {
    const raw = JSON.stringify({
      content: [{
        type: "text",
        text: JSON.stringify({
          project: "p", status: "error",
          error_phase: "discover",
          error: "discovery failed (rc=-1)",
        }),
      }],
      isError: true,
    });
    const result = parseEnvelope(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_phase).toBe("discover");
      expect(result.error).toMatch(/discovery failed/);
    }
  });

  it("ok=false with phase=unknown on malformed envelope", () => {
    const result = parseEnvelope("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error_phase).toBe("envelope_parse");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/frame-extraction/indexer.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the wrapper**

```ts
// scripts/frame-extraction/indexer.ts
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IndexerEnvelope } from "./types.js";

const INDEXER_BIN = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..", "..", "bin", "cortex-indexer",
);

interface McpEnvelope {
  content?: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface InnerErrorPayload {
  status?: string;
  error_phase?: string;
  error?: string;
}

export function parseEnvelope<T>(raw: string): IndexerEnvelope<T> {
  let outer: McpEnvelope;
  try {
    outer = JSON.parse(raw);
  } catch {
    return { ok: false, status: "envelope_parse", error_phase: "envelope_parse", error: `outer JSON parse failed: ${raw.slice(0, 200)}`, raw };
  }
  const text = outer.content?.[0]?.text;
  if (typeof text !== "string") {
    return { ok: false, status: "envelope_parse", error_phase: "envelope_parse", error: "no content[0].text in envelope", raw };
  }
  let inner: unknown;
  try {
    inner = JSON.parse(text);
  } catch {
    return { ok: false, status: "envelope_parse", error_phase: "envelope_parse", error: `inner JSON parse failed: ${text.slice(0, 200)}`, raw };
  }
  if (outer.isError === true) {
    const e = inner as InnerErrorPayload;
    return {
      ok: false,
      status: e.status ?? "error",
      error_phase: e.error_phase ?? "unknown",
      error: e.error ?? text,
      raw,
    };
  }
  return { ok: true, data: inner as T };
}

/** Invoke `bin/cortex-indexer cli <tool> <json>` and parse the result. */
export function callIndexer<T>(tool: string, args: Record<string, unknown>): IndexerEnvelope<T> {
  const res = spawnSync(INDEXER_BIN, ["cli", tool, JSON.stringify(args)], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) {
    return { ok: false, status: "spawn_error", error_phase: "spawn", error: String(res.error), raw: "" };
  }
  // The indexer prints log lines to stderr and the JSON envelope to stdout.
  // The MCP envelope is the LAST non-empty line of stdout.
  const lines = (res.stdout ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] ?? "";
  return parseEnvelope<T>(last);
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run tests/frame-extraction/indexer.test.ts 2>&1 | tail -10
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/indexer.ts tests/frame-extraction/indexer.test.ts
git commit -m "feat(frame-extraction): add indexer CLI envelope wrapper"
```

---

## Task 4: Graph stats from `get_architecture`

**Files:**
- Create: `scripts/frame-extraction/graph-stats.ts`
- Create: `tests/frame-extraction/graph-stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/graph-stats.test.ts
import { describe, it, expect } from "vitest";
import { deriveGraphStats } from "../../scripts/frame-extraction/graph-stats.js";

describe("deriveGraphStats", () => {
  it("computes entity_count from function+class+method+interface+type", () => {
    const stats = deriveGraphStats({
      project: "p",
      total_nodes: 200,
      total_edges: 600,
      node_labels: [
        { label: "function", count: 100 },
        { label: "class", count: 20 },
        { label: "method", count: 10 },
        { label: "interface", count: 5 },
        { label: "type", count: 3 },
        { label: "file", count: 50 },
        { label: "folder", count: 12 },
      ],
    });
    expect(stats.entity_count).toBe(100 + 20 + 10 + 5 + 3);
    expect(stats.total_nodes).toBe(200);
    expect(stats.total_edges).toBe(600);
    expect(stats.edge_density).toBeCloseTo(600 / 200, 5);
  });

  it("edge_density is 0 when total_nodes is 0", () => {
    const stats = deriveGraphStats({
      project: "p", total_nodes: 0, total_edges: 0, node_labels: [],
    });
    expect(stats.edge_density).toBe(0);
    expect(stats.entity_count).toBe(0);
  });

  it("ignores labels not in the entity set", () => {
    const stats = deriveGraphStats({
      project: "p", total_nodes: 30, total_edges: 10,
      node_labels: [
        { label: "function", count: 5 },
        { label: "section", count: 1000 },
        { label: "channel", count: 7 },
      ],
    });
    expect(stats.entity_count).toBe(5);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/frame-extraction/graph-stats.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/frame-extraction/graph-stats.ts
import { callIndexer } from "./indexer.js";
import type { GraphStats, IndexerEnvelope, NodeLabelCount } from "./types.js";

interface ArchitectureResponse {
  project: string;
  total_nodes: number;
  total_edges: number;
  node_labels: NodeLabelCount[];
}

const ENTITY_LABELS = new Set([
  "function", "class", "method", "interface", "type",
]);

export function deriveGraphStats(resp: ArchitectureResponse): GraphStats {
  const entity_count = resp.node_labels
    .filter(l => ENTITY_LABELS.has(l.label))
    .reduce((sum, l) => sum + l.count, 0);
  const edge_density = resp.total_nodes > 0
    ? resp.total_edges / resp.total_nodes
    : 0;
  return {
    total_nodes: resp.total_nodes,
    total_edges: resp.total_edges,
    edge_density,
    node_labels: resp.node_labels,
    entity_count,
  };
}

export function fetchGraphStats(project: string): IndexerEnvelope<GraphStats> {
  const env = callIndexer<ArchitectureResponse>("get_architecture", {
    aspects: ["structure"],
    project,
  });
  if (!env.ok) return env;
  return { ok: true, data: deriveGraphStats(env.data) };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run tests/frame-extraction/graph-stats.test.ts 2>&1 | tail -10
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/graph-stats.ts tests/frame-extraction/graph-stats.test.ts
git commit -m "feat(frame-extraction): derive entity_count + edge_density from graph"
```

---

## Task 5: Filesystem stats (depth + extension histogram)

**Files:**
- Create: `scripts/frame-extraction/fs-stats.ts`
- Create: `tests/frame-extraction/fs-stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/fs-stats.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFsStats } from "../../scripts/frame-extraction/fs-stats.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-fs-stats-"));
  mkdirSync(join(root, "src", "auth"), { recursive: true });
  mkdirSync(join(root, "src", "billing", "internal"), { recursive: true });
  mkdirSync(join(root, "locales"), { recursive: true });
  mkdirSync(join(root, "__snapshots__"), { recursive: true });
  writeFileSync(join(root, "src", "index.ts"), "export {};\n");
  writeFileSync(join(root, "src", "auth", "auth.ts"), "export {};\n");
  writeFileSync(join(root, "src", "billing", "internal", "deep.ts"), "export {};\n");
  writeFileSync(join(root, "locales", "en.json"), "{}\n");
  writeFileSync(join(root, "locales", "de.json"), "{}\n");
  writeFileSync(join(root, "__snapshots__", "x.snap"), "");
  writeFileSync(join(root, "README.md"), "# x\n");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("collectFsStats", () => {
  it("counts files excluding .git and node_modules", () => {
    const stats = collectFsStats(root);
    // 4 .ts + 2 .json + 1 .md + 1 .snap = 8 (we don't filter .snap here)
    expect(stats.file_count).toBe(8);
  });

  it("computes depth as path segments under the repo root", () => {
    const stats = collectFsStats(root);
    // src/billing/internal/deep.ts → depth 4 segments → depth=3 (parents)
    expect(stats.max_depth).toBe(3);
    expect(stats.mean_depth).toBeGreaterThan(0);
    expect(stats.mean_depth).toBeLessThanOrEqual(stats.max_depth);
  });

  it("builds an extension histogram with leading dots and lowercased keys", () => {
    const stats = collectFsStats(root);
    expect(stats.extension_histogram[".ts"]).toBe(3);
    expect(stats.extension_histogram[".json"]).toBe(2);
    expect(stats.extension_histogram[".md"]).toBe(1);
  });

  it("flags auxiliary directories from the path-pattern list", () => {
    const stats = collectFsStats(root);
    expect(stats.auxiliary_directories.sort()).toEqual(["__snapshots__", "locales"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/frame-extraction/fs-stats.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/frame-extraction/fs-stats.ts
import { readdirSync, statSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import type { FsStats } from "./types.js";

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", ".tmp"]);

const AUXILIARY_PATH_PATTERNS = [
  "locales", "i18n", "__snapshots__", "fixtures",
  "assets", "static", "public", "vendor",
  "generated", "dist", "build",
];

export function collectFsStats(root: string): FsStats {
  const ext: Record<string, number> = {};
  let fileCount = 0;
  let totalDepth = 0;
  let maxDepth = 0;
  const aux = new Set<string>();

  function walk(dir: string, depthFromRoot: number) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && IGNORE_DIRS.has(entry.name)) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const rel = relative(root, full);
        const segments = rel === "" ? [] : rel.split(sep);
        if (segments.some(s => AUXILIARY_PATH_PATTERNS.includes(s))) {
          aux.add(segments[0]);
        }
        walk(full, depthFromRoot + 1);
      } else if (entry.isFile()) {
        fileCount += 1;
        totalDepth += depthFromRoot;
        if (depthFromRoot > maxDepth) maxDepth = depthFromRoot;
        const e = extname(entry.name).toLowerCase();
        if (e) ext[e] = (ext[e] ?? 0) + 1;
      }
    }
  }

  walk(root, 0);

  return {
    file_count: fileCount,
    max_depth: maxDepth,
    mean_depth: fileCount > 0 ? totalDepth / fileCount : 0,
    extension_histogram: ext,
    auxiliary_directories: [...aux].sort(),
  };
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run tests/frame-extraction/fs-stats.test.ts 2>&1 | tail -10
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/fs-stats.ts tests/frame-extraction/fs-stats.test.ts
git commit -m "feat(frame-extraction): walk repo for depth + extension histogram"
```

---

## Task 6: Clone wrapper

**Files:**
- Create: `scripts/frame-extraction/clone.ts`

(No pure-function logic to TDD here — it's all side-effecting shellouts.
We rely on the survey orchestrator's end-to-end run for verification.)

- [ ] **Step 1: Implement**

```ts
// scripts/frame-extraction/clone.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoSpec } from "./types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CORPUS_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "corpus");

export interface CloneResult {
  ok: boolean;
  path: string;
  commit_sha: string | null;
  error?: string;
}

/** Idempotent: if the repo is already cloned, fetch + reset to current HEAD
 *  of the remote default branch. Returns the absolute path + commit sha. */
export function ensureClone(repo: RepoSpec): CloneResult {
  if (repo.git === null) {
    const path = repo.local_path
      ? resolve(REPO_ROOT, repo.local_path)
      : REPO_ROOT;
    return { ok: true, path, commit_sha: gitHead(path) };
  }
  mkdirSync(CORPUS_DIR, { recursive: true });
  const dest = join(CORPUS_DIR, repo.slug.replace("/", "__"));
  if (!existsSync(dest)) {
    const res = spawnSync("git", ["clone", "--depth=1", repo.git, dest], {
      encoding: "utf-8",
    });
    if (res.status !== 0) {
      return { ok: false, path: dest, commit_sha: null, error: res.stderr };
    }
  } else {
    // Already cloned — leave as is for determinism within a run.
  }
  return { ok: true, path: dest, commit_sha: gitHead(dest) };
}

function gitHead(path: string): string | null {
  const res = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}
```

- [ ] **Step 2: Sanity-check it compiles**

```bash
npx tsc --noEmit --moduleResolution node --module esnext --target es2022 scripts/frame-extraction/clone.ts scripts/frame-extraction/types.ts
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add scripts/frame-extraction/clone.ts
git commit -m "feat(frame-extraction): shallow-clone corpus repos with caching"
```

---

## Task 7: Survey orchestrator

**Files:**
- Create: `scripts/frame-extraction/survey.ts`
- Modify: `package.json`

- [ ] **Step 1: Implement the orchestrator**

```ts
// scripts/frame-extraction/survey.ts
/**
 * Phase 1 calibration survey. Reads corpus.json, indexes each repo,
 * collects (entity_count, edge_density, directory_depth, language_mix),
 * and emits per-repo JSONL to .tmp/frame-extraction/results.jsonl.
 *
 * Usage:  tsx scripts/frame-extraction/survey.ts
 *   --corpus <path>   Override the default corpus.json path
 *   --only <slug>     Run only matching repos (substring match on slug)
 *   --skip-clone      Reuse existing checkouts but don't fetch new ones
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClone } from "./clone.js";
import { callIndexer } from "./indexer.js";
import { deriveGraphStats } from "./graph-stats.js";
import { collectFsStats } from "./fs-stats.js";
import type { CorpusFile, SurveyResult, RepoStatus, RepoSpec } from "./types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const OUTPUT_DIR = join(REPO_ROOT, ".tmp", "frame-extraction");
const OUTPUT_FILE = join(OUTPUT_DIR, "results.jsonl");

function parseArgs(argv: string[]) {
  const args: { corpus?: string; only?: string; skipClone?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--corpus") args.corpus = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--skip-clone") args.skipClone = true;
  }
  return args;
}

async function runRepo(repo: RepoSpec): Promise<SurveyResult> {
  const t0 = Date.now();
  const make = (result: RepoStatus, commit_sha: string | null = null): SurveyResult => ({
    slug: repo.slug,
    archetype: repo.archetype,
    size_hint: repo.size_hint,
    primary_language: repo.primary_language,
    commit_sha,
    result,
    elapsed_seconds: (Date.now() - t0) / 1000,
  });

  const clone = ensureClone(repo);
  if (!clone.ok) {
    return make({ ok: false, phase: "clone", message: clone.error ?? "unknown clone error" });
  }

  const idx = callIndexer<{ project: string; status: string; error?: string }>(
    "index_repository",
    { repo_path: clone.path },
  );
  if (!idx.ok) {
    return make({ ok: false, phase: "index", message: `${idx.error_phase}: ${idx.error}` }, clone.commit_sha);
  }
  const projectName = idx.data.project;

  const arch = callIndexer<{
    project: string;
    total_nodes: number;
    total_edges: number;
    node_labels: { label: string; count: number }[];
  }>("get_architecture", { aspects: ["structure"], project: projectName });
  if (!arch.ok) {
    return make({ ok: false, phase: "graph_stats", message: `${arch.error_phase}: ${arch.error}` }, clone.commit_sha);
  }

  let fs;
  try {
    fs = collectFsStats(clone.path);
  } catch (err) {
    return make({ ok: false, phase: "fs_stats", message: String(err) }, clone.commit_sha);
  }

  return make({ ok: true, stats: { ...deriveGraphStats(arch.data), ...fs } }, clone.commit_sha);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const corpusPath = args.corpus ?? join(REPO_ROOT, "scripts", "frame-extraction", "corpus.json");
  const corpus = JSON.parse(readFileSync(corpusPath, "utf-8")) as CorpusFile;

  mkdirSync(OUTPUT_DIR, { recursive: true });
  if (existsSync(OUTPUT_FILE)) unlinkSync(OUTPUT_FILE);

  const filtered = args.only
    ? corpus.repos.filter(r => r.slug.includes(args.only!))
    : corpus.repos;

  console.log(`[survey] ${filtered.length} repos to process. Output: ${OUTPUT_FILE}`);
  for (const repo of filtered) {
    console.log(`[survey] → ${repo.slug} (${repo.archetype})`);
    const result = await runRepo(repo);
    appendFileSync(OUTPUT_FILE, JSON.stringify(result) + "\n");
    if (!result.result.ok) {
      console.log(`[survey]   ✗ ${result.result.phase}: ${result.result.message.slice(0, 120)}`);
    } else {
      const s = result.result.stats;
      console.log(`[survey]   ✓ entities=${s.entity_count} edges=${s.total_edges} density=${s.edge_density.toFixed(3)} files=${s.file_count} max_depth=${s.max_depth}`);
    }
  }
  console.log(`[survey] done. Run \`tsx scripts/frame-extraction/report.ts\` to render the report.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Wire into `package.json` scripts**

Edit the `"scripts"` block of `package.json`, adding two entries after
`"test:watch"`:

```json
    "survey:phase1": "tsx scripts/frame-extraction/survey.ts",
    "survey:report": "tsx scripts/frame-extraction/report.ts"
```

- [ ] **Step 3: Sanity-check it compiles**

```bash
npx tsc --noEmit --moduleResolution node --module esnext --target es2022 scripts/frame-extraction/survey.ts
```

Expected: no output.

- [ ] **Step 4: Smoke-run against the local cortex repo only**

```bash
npm run survey:phase1 -- --only self/cortex
```

Expected: a single `[survey] ✓ entities=… edges=… …` line, and a
`.tmp/frame-extraction/results.jsonl` with one JSON line.

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/survey.ts package.json
git commit -m "feat(frame-extraction): survey orchestrator + npm scripts"
```

---

## Task 8: Markdown report

**Files:**
- Create: `scripts/frame-extraction/report.ts`
- Create: `tests/frame-extraction/report.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/frame-extraction/report.test.ts
import { describe, it, expect } from "vitest";
import { renderReport } from "../../scripts/frame-extraction/report.js";
import type { SurveyResult } from "../../scripts/frame-extraction/types.js";

const sample: SurveyResult[] = [
  {
    slug: "a/b", archetype: "ts-monorepo", size_hint: "medium",
    primary_language: "typescript", commit_sha: "abc123",
    result: {
      ok: true,
      stats: {
        total_nodes: 500, total_edges: 1500, edge_density: 3.0,
        node_labels: [{ label: "function", count: 200 }],
        entity_count: 200,
        file_count: 100, max_depth: 4, mean_depth: 2.1,
        extension_histogram: { ".ts": 90, ".md": 10 },
        auxiliary_directories: ["locales"],
      },
    },
    elapsed_seconds: 12.3,
  },
  {
    slug: "x/y", archetype: "python-cli", size_hint: "small",
    primary_language: "python", commit_sha: null,
    result: { ok: false, phase: "index", message: "discover: bad" },
    elapsed_seconds: 0.5,
  },
];

describe("renderReport", () => {
  it("includes a row per successful repo with entity_count + edge_density", () => {
    const md = renderReport(sample);
    expect(md).toMatch(/a\/b/);
    expect(md).toMatch(/200/);
    expect(md).toMatch(/3\.000/);
  });

  it("lists failed repos under a Failures heading", () => {
    const md = renderReport(sample);
    expect(md).toMatch(/## Failures/);
    expect(md).toMatch(/x\/y/);
    expect(md).toMatch(/index/);
  });

  it("suggests a threshold band based on the entity_count distribution", () => {
    const md = renderReport(sample);
    expect(md).toMatch(/Suggested threshold/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run tests/frame-extraction/report.test.ts 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// scripts/frame-extraction/report.ts
/**
 * Render docs/specs/cortex-v0.3/phase-1-results.md from the JSONL emitted
 * by survey.ts. Single entry point: tsx scripts/frame-extraction/report.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SurveyResult } from "./types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const INPUT_FILE = join(REPO_ROOT, ".tmp", "frame-extraction", "results.jsonl");
const OUTPUT_FILE = join(REPO_ROOT, "docs", "specs", "cortex-v0.3", "phase-1-results.md");

export function renderReport(results: SurveyResult[]): string {
  const ok = results.filter(r => r.result.ok);
  const failed = results.filter(r => !r.result.ok);

  const entityCounts = ok.map(r => (r.result.ok ? r.result.stats.entity_count : 0)).sort((a, b) => a - b);
  const densities = ok.map(r => (r.result.ok ? r.result.stats.edge_density : 0)).sort((a, b) => a - b);

  const lines: string[] = [];
  lines.push(`# Phase 1 — Index-Stats Survey Results`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Corpus size: ${results.length} (${ok.length} ok, ${failed.length} failed)`);
  lines.push("");
  lines.push(`## Per-repo stats`);
  lines.push("");
  lines.push(`| slug | archetype | lang | files | entities | edges | density | max_depth | mean_depth | aux_dirs | secs |`);
  lines.push(`|---|---|---|---:|---:|---:|---:|---:|---:|---|---:|`);
  for (const r of ok) {
    if (!r.result.ok) continue;
    const s = r.result.stats;
    lines.push(`| \`${r.slug}\` | ${r.archetype} | ${r.primary_language} | ${s.file_count} | ${s.entity_count} | ${s.total_edges} | ${s.edge_density.toFixed(3)} | ${s.max_depth} | ${s.mean_depth.toFixed(2)} | ${s.auxiliary_directories.join(", ") || "—"} | ${r.elapsed_seconds.toFixed(1)} |`);
  }
  lines.push("");

  if (failed.length > 0) {
    lines.push(`## Failures`);
    lines.push("");
    for (const r of failed) {
      if (r.result.ok) continue;
      lines.push(`- \`${r.slug}\` (${r.archetype}): **${r.result.phase}** — ${r.result.message}`);
    }
    lines.push("");
  }

  lines.push(`## Distribution`);
  lines.push("");
  lines.push(`### entity_count`);
  lines.push(`- min: ${entityCounts[0] ?? 0}`);
  lines.push(`- p25: ${percentile(entityCounts, 0.25)}`);
  lines.push(`- median: ${percentile(entityCounts, 0.5)}`);
  lines.push(`- p75: ${percentile(entityCounts, 0.75)}`);
  lines.push(`- max: ${entityCounts[entityCounts.length - 1] ?? 0}`);
  lines.push("");
  lines.push(`### edge_density`);
  lines.push(`- min: ${densities[0]?.toFixed(3) ?? "0.000"}`);
  lines.push(`- p25: ${percentile(densities, 0.25).toFixed(3)}`);
  lines.push(`- median: ${percentile(densities, 0.5).toFixed(3)}`);
  lines.push(`- p75: ${percentile(densities, 0.75).toFixed(3)}`);
  lines.push(`- max: ${densities[densities.length - 1]?.toFixed(3) ?? "0.000"}`);
  lines.push("");

  const suggestedEntity = percentile(entityCounts, 0.25);
  const suggestedDensity = percentile(densities, 0.25);
  lines.push(`## Suggested threshold`);
  lines.push("");
  lines.push(`Starter target from the spec: \`entity_count > 300 OR edge_density > 0.05\`. p25 of the surveyed corpus is **entity_count=${suggestedEntity}**, **edge_density=${suggestedDensity.toFixed(3)}** — repos below the p25 are the calibration floor for "low complexity" (step-3 ACDC refinement skips). Tune downstream by checking how Phase-2 outputs degrade as the threshold shifts.`);
  lines.push("");

  return lines.join("\n");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx];
}

function main() {
  const text = readFileSync(INPUT_FILE, "utf-8");
  const results: SurveyResult[] = text.split("\n").filter(Boolean).map(l => JSON.parse(l));
  const md = renderReport(results);
  writeFileSync(OUTPUT_FILE, md);
  console.log(`[report] wrote ${OUTPUT_FILE}`);
}

// Only run main when invoked directly, not when imported by tests.
const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("report.ts");
if (isDirect) main();
```

- [ ] **Step 4: Run to verify pass**

```bash
npx vitest run tests/frame-extraction/report.test.ts 2>&1 | tail -10
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/frame-extraction/report.ts tests/frame-extraction/report.test.ts
git commit -m "feat(frame-extraction): markdown report renderer"
```

---

## Task 9: Run the full survey + commit results

- [ ] **Step 1: Run the full Phase 1 survey**

```bash
npm run survey:phase1
```

Expected (per-repo, may take several minutes total): a line per repo with
`✓ entities=… edges=… density=…`. Failures are surfaced inline. Skipping
indexer-incompatible languages (Swift, etc.) is fine — leave a Failures
section in the report.

- [ ] **Step 2: Generate the markdown report**

```bash
npm run survey:report
cat docs/specs/cortex-v0.3/phase-1-results.md | head -40
```

Expected: a populated table with one row per successful repo + a
distribution block + a suggested-threshold paragraph.

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```bash
npm test 2>&1 | tail -15
```

Expected: all tests pass, including the 4 new test files under
`tests/frame-extraction/`.

- [ ] **Step 4: Capture a decision recording the calibrated threshold**

Use the `propose_decision` MCP tool with title
`"Phase 1 complexity threshold for frame extraction"`, the chosen
`entity_count` / `edge_density` cutoffs as the rationale, and
`scripts/frame-extraction/survey.ts` as the `governs` target.

- [ ] **Step 5: Commit the generated report**

```bash
git add docs/specs/cortex-v0.3/phase-1-results.md
git commit -m "docs(frame-extraction): Phase 1 corpus survey results"
```

- [ ] **Step 6: Open the merge PR**

```bash
git push -u origin feature/frame-extraction/phase-1-stats-survey
# Then open via gh:
gh pr create --title "feat(frame-extraction): Phase 1 index-stats survey" --body "$(cat <<'EOF'
## Summary
- Phase 1 calibration script for v0.3 frame extraction (per docs/specs/cortex-v0.3/frame-extraction.md §Verification).
- Indexer envelope now surfaces error + error_phase on failure (precursor — fixes a silent-failure mode the survey relied on).
- Generated corpus results in docs/specs/cortex-v0.3/phase-1-results.md.

## Test plan
- [ ] `npm test` — all unit tests pass, including new tests under tests/frame-extraction/.
- [ ] `bin/cortex-indexer cli index_repository '{"repo_path":"/nonexistent"}'` returns error + error_phase fields.
- [ ] `npm run survey:phase1 -- --only self/cortex` produces a single JSONL row + valid stats.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Phase 1 §Verification asks for (entity count, edge
  density, directory depth, language mix). All four are computed —
  language mix is the extension histogram from `fs-stats.ts`. Distribution
  output + suggested threshold are produced. Phase 2 / Phase 3 are out of
  scope (separate plans).
- **Open question §2** (corpus selection) is addressed concretely in
  `corpus.json` — 8 archetypes — and is overridable via `--corpus`.
- **Open question §6** (auxiliary content not in CBM) is partially
  addressed: `fs-stats.ts` produces extension + auxiliary-dir signal
  outside the graph. The auxiliary detection layer in `frame-extraction.md`
  itself is Phase 2 work.
- **Branch:** `feature/frame-extraction/phase-1-stats-survey` matches the
  workflow naming convention (`feature/<scope>/<short-description>`).
- **Visual QA:** N/A — no UI changes.
- **Code review (Gate 1):** run `/review` before opening the PR.
- **QA (Gate 2):** run the project's `qa` agent before merge (or skip if
  the agent isn't available and have the user hand-verify).

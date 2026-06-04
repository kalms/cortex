# Nuxt File-Based Route Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `HANDLES` edges non-zero by extracting Nuxt 3 file-based API routes (`server/api/**/*.{get,post,…}.ts`) — capturing each `export default defineEventHandler(...)` arrow as a `Function` node tagged with `route_path` / `route_method`, so the existing route-emission pass produces `Route → HANDLES → handler`.

**Architecture:** All work is upstream in **extraction** (`extract_defs.c`). The emission side (`pass_route_nodes.c::ensure_decorator_routes`) already scans every `Function`/`Method` node for a `route_path` JSON property and emits `Route` + `HANDLES` — it needs no changes. `CtxDefinition` already carries `route_path` / `route_method` fields, and both pipelines (`pass_definitions.c` sequential, `pass_parallel.c` parallel) already serialize them into the node's `data` JSON. So a single new extraction code path that (a) detects a Nuxt route file from `ctx->rel_path`, (b) captures the handler arrow as a `Function` def, and (c) sets `route_path`/`route_method`, flows end-to-end through **both** pipelines automatically.

**Tech Stack:** C (C11), tree-sitter (TypeScript/TSX grammars), the in-repo `test_framework.h` unit harness, SQLite (verification via `sqlite3` against `~/.cache/cortex-indexer/*.db`).

**Design decision (captured in Cortex):** "Capture the `defineEventHandler` arrow as the handler `Function` node" — chosen over synthesizing a stub node or tagging the module node, because the value prop is a traceable graph: `HANDLES` must point at a real handler whose body carries the inner `$fetch` `HTTP_CALLS`. See decision in `.cortex/decisions.db` (title: "Nuxt route handlers are captured as Function nodes tagged with route_path").

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `internal/indexer/extract/extract_nuxt_routes.c` | **New.** Pure path→route derivation (`ctx_nuxt_route_from_path`) + the handler-arrow capture entry (`ctx_try_extract_nuxt_handler`). Self-contained so it can be unit-tested without the full walk. | Create |
| `internal/indexer/extract/extract_nuxt_routes.h` | **New.** Public prototypes for the two functions above. | Create |
| `internal/indexer/extract/extract_defs.c` | Call `ctx_try_extract_nuxt_handler` from the JS/TS `export_statement` dispatch in `walk_defs`. | Modify |
| `internal/indexer/tests/test_nuxt_routes.c` | **New.** Unit tests for path derivation + a small extraction smoke test. | Create |
| `internal/indexer/tests/test_main.c` | Register the new test suite. | Modify |
| `internal/indexer/Makefile` (or the C test build file) | Add `extract_nuxt_routes.c` + `test_nuxt_routes.c` to the build. | Modify |

**Why a separate `.c`/`.h`:** `extract_defs.c` is already 3333 lines. The path→route logic is pure (no tree-sitter), so isolating it makes it directly unit-testable and keeps the new surface in one focused file. Follow the existing `extract_*.c` module convention (e.g. `extract_channels.c`, `extract_sfc.c`).

---

## Route derivation contract (reference for all tasks)

`ctx_nuxt_route_from_path(arena, rel_path, &out_path, &out_method)` returns `true` iff `rel_path` is a Nuxt API route file. Mapping rules:

| `rel_path` | `out_path` | `out_method` |
|---|---|---|
| `apps/activator/server/api/orgs/index.get.ts` | `/api/orgs` | `GET` |
| `server/api/orgs/index.get.ts` | `/api/orgs` | `GET` |
| `apps/arcane/server/api/arcane/uploads/[id].get.ts` | `/api/arcane/uploads/:id` | `GET` |
| `server/api/auth/update-name.patch.ts` | `/api/auth/update-name` | `PATCH` |
| `server/api/items/[...slug].get.ts` | `/api/items/*` | `GET` |
| `server/api/health.ts` (no method suffix) | `/api/health` | `ANY` |
| `src/components/Foo.vue` (no `server/api/`) | — | returns `false` |

Algorithm:
1. Find the substring `"server/api/"` in `rel_path`. If absent → return `false`. (Out of scope, document: `server/routes/` maps to `/`; `server/middleware/` are not routes.)
2. Let `tail` = everything from the `"api/"` that begins that match (i.e. include the `api` segment). Prepend `/`. → `/api/orgs/index.get.ts`.
3. Split the basename on `.`. Recognized HTTP method tokens: `get post put patch delete head options`. If the second-to-last dot-segment is a method token → `out_method` = uppercase(it); the file "stem" is everything before that token. Else `out_method` = `"ANY"` and stem = basename without `.ts`.
4. Drop a trailing `index` stem segment (`/api/orgs/index` → `/api/orgs`).
5. Translate dynamic segments in every path segment: `[...x]` → `*`; `[x]` → `:x`.
6. Collapse to a clean path: no trailing slash except root `/`.

All of this is pure string work — fully covered by Task 2's tests.

---

## Task 1: Confirm the tree-sitter node shape for the handler (fixture trace)

**Files:** none modified — investigation only. This de-risks Task 4 by pinning exact node types before writing capture code.

- [ ] **Step 1: Write a throwaway probe that prints the AST**

Use the existing extraction smoke path. From the repo root:

```bash
cat > /tmp/nuxt_probe.ts <<'EOF'
export default defineEventHandler(async (event) => {
  return []
})
EOF
```

- [ ] **Step 2: Dump the parse tree**

If the project exposes an AST dump (check `bin/cortex-indexer` subcommands and `internal/indexer/tests/test_extraction.c` for the parse helper), use it. Otherwise add a temporary `TSTree` print in a scratch test. Confirm the node chain. **Expected shape (TypeScript grammar):**

```
program
  export_statement            ("export" "default" <value>)
    value: call_expression
      function: identifier     -> "defineEventHandler"
      arguments: arguments
        arrow_function         (parameters: "(event)", body: statement_block)
```

- [ ] **Step 3: Record findings inline in this plan**

Write the confirmed node types (especially: is the export value reachable via `ts_node_child_by_field_name(export_stmt, "value")` or a `declaration` field? Is the call's callee field named `"function"`? Is the arrow the first `arguments` named child?) into a comment block at the top of `extract_nuxt_routes.c` in Task 4. Note variants to also accept: `eventHandler`, `defineCachedEventHandler`, `defineLazyEventHandler`.

- [ ] **Step 4: Clean up**

```bash
rm /tmp/nuxt_probe.ts
```

No commit (investigation only).

---

## Task 2: Pure path→route derivation function

**Files:**
- Create: `internal/indexer/extract/extract_nuxt_routes.h`
- Create: `internal/indexer/extract/extract_nuxt_routes.c`
- Test: `internal/indexer/tests/test_nuxt_routes.c`
- Modify: `internal/indexer/tests/test_main.c`, C test build file

- [ ] **Step 1: Write the header**

`internal/indexer/extract/extract_nuxt_routes.h`:

```c
#ifndef CTX_EXTRACT_NUXT_ROUTES_H
#define CTX_EXTRACT_NUXT_ROUTES_H

#include <stdbool.h>
#include "arena.h"   /* CtxArena — match the include path used by extract_defs.c */

/* If rel_path is a Nuxt file-based API route (contains "server/api/" and a
 * recognized filename shape), set *out_path (e.g. "/api/orgs/:id") and
 * *out_method (e.g. "GET" or "ANY") to arena-allocated strings and return true.
 * Otherwise return false and leave outputs untouched. */
bool ctx_nuxt_route_from_path(CtxArena *a, const char *rel_path,
                              const char **out_path, const char **out_method);

#endif
```

(Confirm the arena include path/name from the top of `extract_defs.c` — it may be `"ctx_arena.h"` or similar. Match it exactly.)

- [ ] **Step 2: Write the failing tests**

`internal/indexer/tests/test_nuxt_routes.c` (follow `test_framework.h` conventions — mirror `test_extraction.c` for the `TEST(...)` macro and arena setup):

```c
#include "test_framework.h"
#include "extract_nuxt_routes.h"
#include "arena.h"
#include <string.h>

static void check_route(CtxArena *a, const char *path, const char *want_path,
                        const char *want_method) {
    const char *p = NULL, *m = NULL;
    bool ok = ctx_nuxt_route_from_path(a, path, &p, &m);
    ASSERT_TRUE(ok);
    ASSERT_STR_EQ(want_path, p);
    ASSERT_STR_EQ(want_method, m);
}

TEST(nuxt_route_index_get) {
    CtxArena *a = ctx_arena_new(4096);
    check_route(a, "apps/activator/server/api/orgs/index.get.ts", "/api/orgs", "GET");
    ctx_arena_free(a);
}

TEST(nuxt_route_dynamic_param) {
    CtxArena *a = ctx_arena_new(4096);
    check_route(a, "apps/arcane/server/api/arcane/uploads/[id].get.ts",
                "/api/arcane/uploads/:id", "GET");
    ctx_arena_free(a);
}

TEST(nuxt_route_patch_named) {
    CtxArena *a = ctx_arena_new(4096);
    check_route(a, "server/api/auth/update-name.patch.ts", "/api/auth/update-name", "PATCH");
    ctx_arena_free(a);
}

TEST(nuxt_route_catchall) {
    CtxArena *a = ctx_arena_new(4096);
    check_route(a, "server/api/items/[...slug].get.ts", "/api/items/*", "GET");
    ctx_arena_free(a);
}

TEST(nuxt_route_no_method_suffix) {
    CtxArena *a = ctx_arena_new(4096);
    check_route(a, "server/api/health.ts", "/api/health", "ANY");
    ctx_arena_free(a);
}

TEST(nuxt_route_rejects_non_route) {
    CtxArena *a = ctx_arena_new(4096);
    const char *p = NULL, *m = NULL;
    ASSERT_FALSE(ctx_nuxt_route_from_path(a, "src/components/Foo.vue", &p, &m));
    ctx_arena_free(a);
}
```

(Use the exact assertion macro names from `test_framework.h` — e.g. it may be `ASSERT_STREQ` not `ASSERT_STR_EQ`. Grep the header first and match.)

- [ ] **Step 3: Register the suite + add to build**

In `internal/indexer/tests/test_main.c`, add the suite registration mirroring an existing entry (grep for how `test_extraction` / `test_service_patterns` register — e.g. a `RUN_SUITE(nuxt_routes)` line or extern declarations). Add `extract_nuxt_routes.c` and `test_nuxt_routes.c` to the C test build file (grep the Makefile for `test_service_patterns.c` and mirror both the lib-object and test-object entries).

- [ ] **Step 4: Run tests to verify they fail (compile + fail)**

Run the project's C test build (grep `package.json` / `Makefile` for the C test target; the handoff runs e.g. `service_patterns`). Expected: link error or `ctx_nuxt_route_from_path` undefined, or assertion failures once stubbed.

- [ ] **Step 5: Implement `ctx_nuxt_route_from_path`**

`internal/indexer/extract/extract_nuxt_routes.c`:

```c
#include "extract_nuxt_routes.h"
#include "arena.h"
#include <string.h>
#include <ctype.h>

static const char *HTTP_METHODS[] = {"get","post","put","patch","delete","head","options",NULL};

static const char *method_token(const char *seg) {
    for (const char **m = HTTP_METHODS; *m; m++) {
        if (strcmp(seg, *m) == 0) return *m;
    }
    return NULL;
}

/* Translate one path segment: [...x] -> *, [x] -> :x, else unchanged. */
static const char *translate_segment(CtxArena *a, const char *seg) {
    size_t n = strlen(seg);
    if (n >= 2 && seg[0] == '[' && seg[n-1] == ']') {
        if (n >= 5 && strncmp(seg+1, "...", 3) == 0) {
            return "*";
        }
        char *out = ctx_arena_alloc(a, n);   /* '[' + ']' removed, ':' added => same size */
        out[0] = ':';
        memcpy(out+1, seg+1, n-2);
        out[n-1] = '\0';
        return out;
    }
    return seg;
}

bool ctx_nuxt_route_from_path(CtxArena *a, const char *rel_path,
                              const char **out_path, const char **out_method) {
    if (!rel_path) return false;
    const char *api = strstr(rel_path, "server/api/");
    if (!api) return false;
    const char *tail = api + strlen("server/");   /* points at "api/..." */

    /* Copy tail so we can tokenize. */
    size_t tn = strlen(tail);
    char *work = ctx_arena_alloc(a, tn + 1);
    memcpy(work, tail, tn + 1);

    /* Split basename off to find method + stem. */
    char *last_slash = strrchr(work, '/');
    char *dir = work;
    char *base = last_slash ? last_slash + 1 : work;
    if (last_slash) *last_slash = '\0'; else dir = "";   /* dir is "api/orgs" or "api" */

    /* base looks like "index.get.ts" / "[id].get.ts" / "health.ts" */
    char *method = "ANY";
    /* find ".ts" */
    char *dot_ts = strstr(base, ".ts");
    if (dot_ts) *dot_ts = '\0';                 /* base now "index.get" / "[id].get" / "health" */
    char *meth_dot = strrchr(base, '.');
    if (meth_dot) {
        const char *mt = method_token(meth_dot + 1);
        if (mt) {
            *meth_dot = '\0';                   /* base now "index" / "[id]" / "health" */
            /* uppercase */
            size_t ml = strlen(mt);
            char *mu = ctx_arena_alloc(a, ml + 1);
            for (size_t i = 0; i < ml; i++) mu[i] = (char)toupper((unsigned char)mt[i]);
            mu[ml] = '\0';
            method = mu;
        }
    }
    /* drop trailing "index" stem */
    bool stem_is_index = (strcmp(base, "index") == 0);

    /* Reassemble: "/" + dir segments + (base unless index), translating each. */
    char buf[1024];
    size_t pos = 0;
    buf[pos++] = '/';
    /* dir segments */
    char *seg = dir;
    while (seg && *seg) {
        char *slash = strchr(seg, '/');
        if (slash) *slash = '\0';
        const char *t = translate_segment(a, seg);
        size_t tl = strlen(t);
        if (pos + tl + 1 >= sizeof(buf)) return false;
        memcpy(buf + pos, t, tl); pos += tl;
        buf[pos++] = '/';
        seg = slash ? slash + 1 : NULL;
    }
    if (!stem_is_index && base[0] != '\0') {
        const char *t = translate_segment(a, base);
        size_t tl = strlen(t);
        if (pos + tl >= sizeof(buf)) return false;
        memcpy(buf + pos, t, tl); pos += tl;
    } else if (pos > 1 && buf[pos-1] == '/') {
        pos--;   /* drop trailing slash from the index case */
    }
    buf[pos] = '\0';

    char *out = ctx_arena_alloc(a, pos + 1);
    memcpy(out, buf, pos + 1);
    *out_path = out;
    *out_method = method;
    return true;
}
```

(Confirm `ctx_arena_alloc` is the real arena alloc name — grep `extract_defs.c`. Adjust the `[...x]` size handling: `*` is shorter than `[...x]`, so returning a literal `"*"` is safe.)

- [ ] **Step 6: Run tests to verify they pass**

Run the C test target. Expected: all 6 `nuxt_route_*` tests PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/indexer/extract/extract_nuxt_routes.{c,h} \
        internal/indexer/tests/test_nuxt_routes.c \
        internal/indexer/tests/test_main.c
# + the build file
git commit -m "feat(indexer): pure Nuxt route path/method derivation + tests"
```

---

## Task 3: Handler-arrow capture entry point

**Files:**
- Modify: `internal/indexer/extract/extract_nuxt_routes.c` / `.h` (add `ctx_try_extract_nuxt_handler`)

This wraps the def-building so `extract_defs.c` calls one function. It builds a `Function` `CtxDefinition` from the arrow node and sets `route_path`/`route_method`.

- [ ] **Step 1: Add the prototype to the header**

```c
#include "tree_sitter/api.h"   /* TSNode — match how extract_defs.c includes it */
struct CtxExtractCtx;          /* forward decl */

/* If export_stmt is `export default defineEventHandler(<arrow>)` in a Nuxt API
 * route file, push a Function def for the arrow tagged with route_path/route_method.
 * Returns true if a handler def was pushed. */
bool ctx_try_extract_nuxt_handler(struct CtxExtractCtx *ctx, TSNode export_stmt);
```

- [ ] **Step 2: Write the implementation**

In `extract_nuxt_routes.c` (uses confirmed node types from Task 1; adjust field names to match the trace):

```c
/* The wrapper-call identifiers that mark a Nuxt server handler. */
static bool is_event_handler_callee(const char *name) {
    return name && (strcmp(name, "defineEventHandler") == 0 ||
                    strcmp(name, "eventHandler") == 0 ||
                    strcmp(name, "defineCachedEventHandler") == 0 ||
                    strcmp(name, "defineLazyEventHandler") == 0);
}

bool ctx_try_extract_nuxt_handler(struct CtxExtractCtx *ctx, TSNode export_stmt) {
    const char *route_path = NULL, *route_method = NULL;
    if (!ctx_nuxt_route_from_path(ctx->arena, ctx->rel_path, &route_path, &route_method)) {
        return false;
    }
    /* Only default exports. Confirm in Task 1 whether "default" is a child token. */
    /* value: the exported expression (call_expression). */
    TSNode value = ts_node_child_by_field_name(export_stmt, TS_FIELD("value"));
    if (ts_node_is_null(value) || strcmp(ts_node_type(value), "call_expression") != 0) {
        return false;
    }
    TSNode callee = ts_node_child_by_field_name(value, TS_FIELD("function"));
    if (ts_node_is_null(callee)) return false;
    char *callee_text = ctx_node_text(ctx->arena, callee, ctx->source);
    if (!is_event_handler_callee(callee_text)) return false;

    TSNode args = ts_node_child_by_field_name(value, TS_FIELD("arguments"));
    if (ts_node_is_null(args)) return false;
    TSNode arrow = ts_node_named_child(args, 0);
    if (ts_node_is_null(arrow)) return false;
    const char *ak = ts_node_type(arrow);
    if (strcmp(ak, "arrow_function") != 0 && strcmp(ak, "function_expression") != 0) {
        return false;
    }

    /* Build the handler Function def. Name is method+path so it is readable and
     * unique within the file (qn also includes rel_path). */
    CtxDefinition def;
    memset(&def, 0, sizeof(def));
    char namebuf[300];
    snprintf(namebuf, sizeof(namebuf), "%s %s", route_method, route_path);
    def.name = ctx_arena_strdup(ctx->arena, namebuf);
    def.qualified_name = ctx_fqn_compute(ctx->arena, ctx->project, ctx->rel_path, def.name);
    def.label = "Function";
    def.file_path = ctx->rel_path;
    def.start_line = ts_node_start_point(arrow).row + TS_LINE_OFFSET;
    def.end_line = ts_node_end_point(arrow).row + TS_LINE_OFFSET;
    def.lines = (int)(def.end_line - def.start_line + TS_LINE_OFFSET);
    def.is_exported = true;
    def.is_entry_point = true;
    def.route_path = route_path;
    def.route_method = route_method;

    /* Parameters from the arrow, for parity with normal function defs. */
    TSNode params = ts_node_child_by_field_name(arrow, TS_FIELD("parameters"));
    if (!ts_node_is_null(params)) {
        def.signature = ctx_node_text(ctx->arena, params, ctx->source);
    }

    ctx_defs_push(&ctx->result->defs, ctx->arena, def);
    return true;
}
```

(`ctx_arena_strdup`, `ctx_node_text`, `ctx_fqn_compute`, `TS_FIELD`, `TS_LINE_OFFSET`, the `CtxExtractCtx` field names `arena`/`rel_path`/`source`/`project`/`result` — all confirmed present in `extract_defs.c`; include the same headers. If `CtxDefinition` is declared in a header not yet included here, add that include.)

- [ ] **Step 3: Build to verify it compiles**

Rebuild `bin/cortex-indexer` (the project postinstall build, or the direct C build). Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add internal/indexer/extract/extract_nuxt_routes.{c,h}
git commit -m "feat(indexer): capture defineEventHandler arrow as tagged Function def"
```

---

## Task 4: Wire the capture into the definition walk

**Files:**
- Modify: `internal/indexer/extract/extract_defs.c` (the JS/TS `export_statement` dispatch in `walk_defs`)

- [ ] **Step 1: Locate the export_statement dispatch**

In `walk_defs` (entry at `extract_defs.c:175`), find where JS/TS node types are dispatched. There is already export handling (`has_export_statement_ancestor`, `extract_defs.c:624`). Identify the point where an `export_statement` node is visited for JS/TS/TSX.

- [ ] **Step 2: Add the include and the call**

Near the top of `extract_defs.c` with the other `extract_*.h` includes:

```c
#include "extract_nuxt_routes.h"
```

In the dispatch, before/at the `export_statement` handling for JS/TS/TSX, add:

```c
if ((ctx->language == CTX_LANG_TYPESCRIPT || ctx->language == CTX_LANG_TSX ||
     ctx->language == CTX_LANG_JAVASCRIPT) &&
    strcmp(ts_node_type(node), "export_statement") == 0) {
    if (ctx_try_extract_nuxt_handler(ctx, node)) {
        /* handler captured; continue walking children for inner calls so the
         * $fetch HTTP_CALLS inside the body still get extracted */
    }
}
```

Do **not** `return` after capture — the walk must still descend into the arrow body so inner calls (`$fetch`, db calls) are extracted and attributed.

- [ ] **Step 3: Rebuild**

Rebuild `bin/cortex-indexer`. Expected: clean compile.

- [ ] **Step 4: Commit**

```bash
git add internal/indexer/extract/extract_defs.c
git commit -m "feat(indexer): dispatch Nuxt handler capture from walk_defs"
```

---

## Task 5: End-to-end verification against anthill-cloud

**Files:** none — verification only.

- [ ] **Step 1: Reindex anthill-cloud from scratch**

```bash
cortex index delete Users-rka-Development-anthill-cloud
cd ~/Development/anthill-cloud && \
  /Users/rka/Development/cortex/bin/cortex-indexer cli index_repository \
  '{"repo_path":"/Users/rka/Development/anthill-cloud"}'
```

- [ ] **Step 2: Assert HANDLES is now non-zero**

```bash
DB=~/.cache/cortex-indexer/Users-rka-Development-anthill-cloud.db
sqlite3 "$DB" "SELECT COUNT(*) FROM edges WHERE relation='HANDLES';"
# Expect: > 0, on the order of the ~106 server/api route files
sqlite3 "$DB" "SELECT COUNT(*) FROM nodes WHERE data LIKE '%route_path%';"
# Expect: ~106 (one tagged handler Function per route file)
```

- [ ] **Step 3: Spot-check a known route end-to-end**

```bash
DB=~/.cache/cortex-indexer/Users-rka-Development-anthill-cloud.db
sqlite3 "$DB" "
  SELECT n.kind, n.name, r.name AS route, e.relation
  FROM edges e
  JOIN nodes n ON n.id = e.source_id
  JOIN nodes r ON r.id = e.target_id
  WHERE e.relation='HANDLES'
    AND n.file_path='apps/activator/server/api/orgs/index.get.ts';"
# Expect a row: function | "GET /api/orgs" | /api/orgs | HANDLES
```

- [ ] **Step 4: Confirm inner HTTP_CALLS still attributed to the handler**

```bash
sqlite3 "$DB" "
  SELECT COUNT(*) FROM edges e JOIN nodes n ON n.id=e.source_id
  WHERE e.relation='HTTP_CALLS'
    AND n.file_path='apps/activator/server/api/orgs/index.get.ts';"
# Expect: >= 1 (the $fetch('/api/platform/orgs') call), now sourced from the handler fn
```

- [ ] **Step 5: Confirm cortex's own index has no regressions**

```bash
cortex index delete Users-rka-Development-cortex 2>/dev/null
cd ~/Development/cortex && bin/cortex-indexer cli index_repository \
  '{"repo_path":"/Users/rka/Development/cortex"}'
sqlite3 ~/.cache/cortex-indexer/Users-rka-Development-cortex.db \
  "SELECT COUNT(*) FROM nodes WHERE data LIKE '%route_path%';"
# Cortex is Hono (call-arg routes), not Nuxt — expect this to stay ~0 (no false positives)
```

No commit (verification only). If HANDLES is still 0, the failure is almost certainly the Task 1 node-type assumptions — re-trace before changing logic (systematic-debugging skill).

---

## Task 6: Regression — full test suites + both pipelines

**Files:** none — verification only. The parallel pipeline (`pass_parallel.c`, production path for repos > 100 files) shares the extraction layer and already serializes `route_path` (`pass_parallel.c:217`); anthill-cloud (>100 files) exercises it. Cortex (smaller) exercises the sequential path. Both are covered by Task 5's two reindexes — this task confirms nothing else broke.

- [ ] **Step 1: Run the full C test suite**

Run the C test target. Expected: the new `nuxt_route_*` tests PASS; pre-existing `store`/`cypher`/`pipeline` sanitizer failures unchanged from baseline (documented in HANDOFF.md).

- [ ] **Step 2: Run the TS suite**

```bash
npm test
# Expect: ~612 passed / 1 skipped / 1 documented Python-venv flake (unchanged)
```

- [ ] **Step 3: Update the diagnostic table in HANDOFF.md**

Update the Item 1 counts table (HANDLES column for anthill-cloud) with the new non-zero number.

- [ ] **Step 4: Commit**

```bash
git add HANDOFF.md
git commit -m "docs(handoff): record Nuxt HANDLES now non-zero"
```

---

## Self-Review notes

- **Spec coverage:** path derivation (Task 2), arrow capture + tagging (Task 3), walk wiring (Task 4), end-to-end HANDLES + no-false-positives (Task 5), both pipelines + regressions (Task 6). The HANDLES emission itself needs no task — `ensure_decorator_routes` already handles any `route_path`-tagged Function.
- **Out of scope (documented, not silently dropped):** `server/routes/**` (maps to `/`), tRPC/Hono patterns (separate extractors, separate plan), template-literal URL args (separate small follow-up already in HANDOFF Item 1.4).
- **Type consistency:** `ctx_nuxt_route_from_path` / `ctx_try_extract_nuxt_handler` signatures are identical across header and tasks. `route_path`/`route_method` are the exact JSON keys `ensure_decorator_routes` reads (`pass_route_nodes.c:341,349`).
- **Risk:** the only empirical unknown is the exact tree-sitter field names — Task 1 pins them before Task 3/4 depend on them.

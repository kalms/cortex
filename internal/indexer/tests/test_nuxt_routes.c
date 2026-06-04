/*
 * test_nuxt_routes.c — Unit tests for ctx_nuxt_route_from_path.
 *
 * Covers all 6 contract rows from the route derivation spec:
 *   1. index.get.ts → /api/orgs, GET   (with apps/ prefix)
 *   2. [id].get.ts  → /api/.../id, GET (dynamic param)
 *   3. .patch.ts    → PATCH method
 *   4. [...slug]    → catch-all wildcard
 *   5. no method suffix → ANY
 *   6. non-route file → returns false
 */
#include "test_framework.h"
#include "extract_nuxt_routes.h"
#include "extract.h"            /* CtxExtractCtx, CtxFileResult, ctx_parse_string */
#include "arena.h"
#include "tree_sitter/api.h"
#include <string.h>

/* ── Helpers ─────────────────────────────────────────────────────── */

static CtxArena test_arena;

static void arena_setup(void) {
    ctx_arena_init(&test_arena);
}

static void arena_teardown(void) {
    ctx_arena_destroy(&test_arena);
}

/* ── Tests ───────────────────────────────────────────────────────── */

/* Row 1: apps/activator/server/api/orgs/index.get.ts → /api/orgs, GET */
TEST(nuxt_route_index_get) {
    arena_setup();
    const char *path = NULL, *method = NULL;
    bool ok = ctx_nuxt_route_from_path(&test_arena,
        "apps/activator/server/api/orgs/index.get.ts",
        &path, &method);
    ASSERT_TRUE(ok);
    ASSERT_STR_EQ(path, "/api/orgs");
    ASSERT_STR_EQ(method, "GET");
    arena_teardown();
    PASS();
}

/* Row 2: apps/arcane/server/api/arcane/uploads/[id].get.ts
 *         → /api/arcane/uploads/:id, GET */
TEST(nuxt_route_dynamic_param) {
    arena_setup();
    const char *path = NULL, *method = NULL;
    bool ok = ctx_nuxt_route_from_path(&test_arena,
        "apps/arcane/server/api/arcane/uploads/[id].get.ts",
        &path, &method);
    ASSERT_TRUE(ok);
    ASSERT_STR_EQ(path, "/api/arcane/uploads/:id");
    ASSERT_STR_EQ(method, "GET");
    arena_teardown();
    PASS();
}

/* Row 3: server/api/auth/update-name.patch.ts → /api/auth/update-name, PATCH */
TEST(nuxt_route_patch_named) {
    arena_setup();
    const char *path = NULL, *method = NULL;
    bool ok = ctx_nuxt_route_from_path(&test_arena,
        "server/api/auth/update-name.patch.ts",
        &path, &method);
    ASSERT_TRUE(ok);
    ASSERT_STR_EQ(path, "/api/auth/update-name");
    ASSERT_STR_EQ(method, "PATCH");
    arena_teardown();
    PASS();
}

/* Row 4: server/api/items/[...slug].get.ts -> /api/items/STAR, GET */
TEST(nuxt_route_catchall) {
    arena_setup();
    const char *path = NULL, *method = NULL;
    bool ok = ctx_nuxt_route_from_path(&test_arena,
        "server/api/items/[...slug].get.ts",
        &path, &method);
    ASSERT_TRUE(ok);
    ASSERT_STR_EQ(path, "/api/items/*");
    ASSERT_STR_EQ(method, "GET");
    arena_teardown();
    PASS();
}

/* Row 5: server/api/health.ts → /api/health, ANY */
TEST(nuxt_route_no_method_suffix) {
    arena_setup();
    const char *path = NULL, *method = NULL;
    bool ok = ctx_nuxt_route_from_path(&test_arena,
        "server/api/health.ts",
        &path, &method);
    ASSERT_TRUE(ok);
    ASSERT_STR_EQ(path, "/api/health");
    ASSERT_STR_EQ(method, "ANY");
    arena_teardown();
    PASS();
}

/* Row 6: src/components/Foo.vue → returns false */
TEST(nuxt_route_rejects_non_route) {
    arena_setup();
    const char *path = NULL, *method = NULL;
    bool ok = ctx_nuxt_route_from_path(&test_arena,
        "src/components/Foo.vue",
        &path, &method);
    ASSERT_FALSE(ok);
    arena_teardown();
    PASS();
}

/* Row 7: server/api/index.get.ts → /api, GET
 * Exercises dir == "api" + stem == "index" (index-drop at api root). */
TEST(nuxt_route_index_at_api_root) {
    arena_setup();
    const char *path = NULL, *method = NULL;
    bool ok = ctx_nuxt_route_from_path(&test_arena,
        "server/api/index.get.ts",
        &path, &method);
    ASSERT_TRUE(ok);
    ASSERT_STR_EQ(path, "/api");
    ASSERT_STR_EQ(method, "GET");
    arena_teardown();
    PASS();
}

/* Row 8: server/api/[org]/[repo]/info.get.ts → /api/:org/:repo/info, GET
 * Exercises dynamic-segment translation in the directory walk. */
TEST(nuxt_route_multiple_dynamic_segments) {
    arena_setup();
    const char *path = NULL, *method = NULL;
    bool ok = ctx_nuxt_route_from_path(&test_arena,
        "server/api/[org]/[repo]/info.get.ts",
        &path, &method);
    ASSERT_TRUE(ok);
    ASSERT_STR_EQ(path, "/api/:org/:repo/info");
    ASSERT_STR_EQ(method, "GET");
    arena_teardown();
    PASS();
}

/* ── Handler-arrow capture (ctx_try_extract_nuxt_handler) ─────────────
 *
 * These tests call ctx_try_extract_nuxt_handler directly on a parsed
 * export_statement node, so they exercise the capture path independently of
 * the AST-walk wiring (which a later task adds to extract_defs.c). */

/* Depth-first search for the first node of a given type. */
static TSNode find_first_node(TSNode node, const char *type) {
    if (strcmp(ts_node_type(node), type) == 0) return node;
    uint32_t n = ts_node_named_child_count(node);
    for (uint32_t i = 0; i < n; i++) {
        TSNode found = find_first_node(ts_node_named_child(node, i), type);
        if (!ts_node_is_null(found)) return found;
    }
    return (TSNode){0};
}

/* Parse a TS snippet, locate the first export_statement, run the handler
 * capture, and return the resulting def array via *out_defs. Returns whether
 * ctx_try_extract_nuxt_handler reported a match. Caller owns test_arena and
 * must keep src/tree alive while reading the def. */
static bool run_handler_capture(const char *src, const char *rel_path,
                                TSTree **out_tree, CtxFileResult *result) {
    ctx_init();
    TSTree *tree = ctx_parse_string(src, (int)strlen(src), CTX_LANG_TYPESCRIPT);
    *out_tree = tree;
    TSNode root = ts_tree_root_node(tree);
    TSNode export_stmt = find_first_node(root, "export_statement");

    CtxExtractCtx ctx;
    memset(&ctx, 0, sizeof(ctx));
    ctx.arena = &test_arena;
    ctx.result = result;
    ctx.source = src;
    ctx.source_len = (int)strlen(src);
    ctx.language = CTX_LANG_TYPESCRIPT;
    ctx.project = "t";
    ctx.rel_path = rel_path;

    return ctx_try_extract_nuxt_handler(&ctx, export_stmt);
}

/* Captures an async arrow handler as a Function def tagged with route info. */
TEST(nuxt_handler_captures_function_def) {
    arena_setup();
    CtxFileResult result;
    memset(&result, 0, sizeof(result));
    TSTree *tree = NULL;
    bool ok = run_handler_capture(
        "export default defineEventHandler(async (event) => { return [] })",
        "server/api/orgs/index.get.ts", &tree, &result);
    ASSERT_TRUE(ok);
    ASSERT_EQ(result.defs.count, 1);
    CtxDefinition *def = &result.defs.items[0];
    ASSERT_STR_EQ(def->label, "Function");
    ASSERT_STR_EQ(def->route_path, "/api/orgs");
    ASSERT_STR_EQ(def->route_method, "GET");
    ASSERT_TRUE(def->is_entry_point);
    ts_tree_delete(tree);
    arena_teardown();
    PASS();
}

/* A non-route file path → no capture, even with a valid handler shape. */
TEST(nuxt_handler_rejects_non_route_path) {
    arena_setup();
    CtxFileResult result;
    memset(&result, 0, sizeof(result));
    TSTree *tree = NULL;
    bool ok = run_handler_capture(
        "export default defineEventHandler(async (event) => { return [] })",
        "src/utils/helper.ts", &tree, &result);
    ASSERT_FALSE(ok);
    ASSERT_EQ(result.defs.count, 0);
    ts_tree_delete(tree);
    arena_teardown();
    PASS();
}

/* A route path but a non-handler export (plain object) → no capture. */
TEST(nuxt_handler_rejects_non_handler_export) {
    arena_setup();
    CtxFileResult result;
    memset(&result, 0, sizeof(result));
    TSTree *tree = NULL;
    bool ok = run_handler_capture(
        "export default { foo: 1 }",
        "server/api/orgs/index.get.ts", &tree, &result);
    ASSERT_FALSE(ok);
    ASSERT_EQ(result.defs.count, 0);
    ts_tree_delete(tree);
    arena_teardown();
    PASS();
}

/* Captures a function_expression (non-arrow) handler as a Function def. */
TEST(nuxt_handler_captures_function_expression) {
    arena_setup();
    CtxFileResult result;
    memset(&result, 0, sizeof(result));
    TSTree *tree = NULL;
    bool ok = run_handler_capture(
        "export default defineEventHandler(function (event) { return [] })",
        "server/api/orgs/index.get.ts", &tree, &result);
    ASSERT_TRUE(ok);
    ASSERT_EQ(result.defs.count, 1);
    CtxDefinition *def = &result.defs.items[0];
    ASSERT_STR_EQ(def->label, "Function");
    ASSERT_STR_EQ(def->route_path, "/api/orgs");
    ASSERT_STR_EQ(def->route_method, "GET");
    ASSERT_TRUE(def->is_entry_point);
    ts_tree_delete(tree);
    arena_teardown();
    PASS();
}

/* ── Suite ───────────────────────────────────────────────────────── */

SUITE(nuxt_routes) {
    RUN_TEST(nuxt_route_index_get);
    RUN_TEST(nuxt_route_dynamic_param);
    RUN_TEST(nuxt_route_patch_named);
    RUN_TEST(nuxt_route_catchall);
    RUN_TEST(nuxt_route_no_method_suffix);
    RUN_TEST(nuxt_route_rejects_non_route);
    RUN_TEST(nuxt_route_index_at_api_root);
    RUN_TEST(nuxt_route_multiple_dynamic_segments);
    RUN_TEST(nuxt_handler_captures_function_def);
    RUN_TEST(nuxt_handler_rejects_non_route_path);
    RUN_TEST(nuxt_handler_rejects_non_handler_export);
    RUN_TEST(nuxt_handler_captures_function_expression);
}

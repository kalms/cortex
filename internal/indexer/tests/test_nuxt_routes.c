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
#include "arena.h"

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
}

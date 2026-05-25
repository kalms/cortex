/*
 * test_service_patterns.c — Unit tests for service pattern matching.
 *
 * Targets the lookup helpers that classify call edges as HTTP/async/config
 * and the new global-HTTP detection used by the pass_calls.c fallback for
 * auto-imports and platform globals.
 */
#include "test_framework.h"
#include "service_patterns.h"
#include "extract.h"

/* ── End-to-end extraction probe ────────────────────────────────── */

static int extract_has_call_with_first_string_arg(CtxFileResult *r, const char *callee,
                                                  const char *url_prefix) {
    for (int i = 0; i < r->calls.count; i++) {
        if (!r->calls.items[i].callee_name) {
            continue;
        }
        if (strcmp(r->calls.items[i].callee_name, callee) != 0) {
            continue;
        }
        if (!url_prefix) {
            return 1;
        }
        const char *arg = r->calls.items[i].first_string_arg;
        if (arg && strncmp(arg, url_prefix, strlen(url_prefix)) == 0) {
            return 1;
        }
    }
    return 0;
}

TEST(extract_nuxt_dollar_fetch_call) {
    const char *src = "export async function load(id: string) {\n"
                      "  const x = await $fetch(`/api/items/${id}`);\n"
                      "  return x;\n"
                      "}\n";
    CtxFileResult *r = ctx_extract_file(src, (int)strlen(src), CTX_LANG_TYPESCRIPT, "t", "load.ts",
                                        0, NULL, NULL);
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(extract_has_call_with_first_string_arg(r, "$fetch", NULL));
    ctx_free_result(r);
    PASS();
}

TEST(extract_use_fetch_call_with_url_arg) {
    const char *src = "export const x = useFetch('/api/me');\n";
    CtxFileResult *r = ctx_extract_file(src, (int)strlen(src), CTX_LANG_TYPESCRIPT, "t", "x.ts", 0,
                                        NULL, NULL);
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(extract_has_call_with_first_string_arg(r, "useFetch", "/api/me"));
    ctx_free_result(r);
    PASS();
}

/* Pinia-store shape (the real anthill-cloud pattern that produced no edge).
 * $fetch is inside an arrow function passed to defineStore. */
TEST(extract_dollar_fetch_inside_define_store) {
    const char *src = "export const useOrgStore = defineStore('org', () => {\n"
                      "  const orgs = ref([]);\n"
                      "  async function load() {\n"
                      "    orgs.value = await $fetch('/api/orgs');\n"
                      "  }\n"
                      "  return { orgs, load };\n"
                      "});\n";
    CtxFileResult *r =
        ctx_extract_file(src, (int)strlen(src), CTX_LANG_TYPESCRIPT, "t", "store.ts", 0, NULL,
                         NULL);
    ASSERT_NOT_NULL(r);
    ASSERT_FALSE(r->has_error);
    ASSERT(extract_has_call_with_first_string_arg(r, "$fetch", "/api/orgs"));
    ctx_free_result(r);
    PASS();
}

/* ── ctx_service_pattern_is_global_http ─────────────────────────── */

TEST(global_http_nuxt_fetch) {
    ASSERT(ctx_service_pattern_is_global_http("$fetch"));
    PASS();
}

TEST(global_http_use_fetch) {
    ASSERT(ctx_service_pattern_is_global_http("useFetch"));
    PASS();
}

TEST(global_http_use_lazy_fetch) {
    ASSERT(ctx_service_pattern_is_global_http("useLazyFetch"));
    PASS();
}

TEST(global_http_platform_fetch) {
    ASSERT(ctx_service_pattern_is_global_http("fetch"));
    PASS();
}

TEST(global_http_rejects_member_form) {
    /* "obj.fetch" is a member expression, not a global — fall through to
     * the normal resolution path. */
    ASSERT(!ctx_service_pattern_is_global_http("obj.fetch"));
    ASSERT(!ctx_service_pattern_is_global_http("cache.fetch"));
    ASSERT(!ctx_service_pattern_is_global_http("nuxt.$fetch"));
    PASS();
}

TEST(global_http_rejects_unrelated) {
    ASSERT(!ctx_service_pattern_is_global_http("requests"));
    ASSERT(!ctx_service_pattern_is_global_http("axios"));
    ASSERT(!ctx_service_pattern_is_global_http("useState"));
    ASSERT(!ctx_service_pattern_is_global_http("fetchUser"));
    PASS();
}

TEST(global_http_rejects_empty_and_null) {
    ASSERT(!ctx_service_pattern_is_global_http(NULL));
    ASSERT(!ctx_service_pattern_is_global_http(""));
    PASS();
}

/* ── ctx_service_pattern_match (QN-substring matching) ──────────── */

TEST(svc_match_requests_qn) {
    ASSERT_EQ(ctx_service_pattern_match("project.venv.requests.api.get"), CTX_SVC_HTTP);
    PASS();
}

TEST(svc_match_axios_qn) {
    ASSERT_EQ(ctx_service_pattern_match("proj.node_modules.axios.post"), CTX_SVC_HTTP);
    PASS();
}

TEST(svc_match_express_is_route_reg) {
    /* Route registration libs must beat HTTP-client libs (both have .get etc.) */
    ASSERT_EQ(ctx_service_pattern_match("proj.node_modules.express.Router.get"),
              CTX_SVC_ROUTE_REG);
    PASS();
}

TEST(svc_match_none_for_arbitrary_qn) {
    ASSERT_EQ(ctx_service_pattern_match("proj.app.User.save"), CTX_SVC_NONE);
    PASS();
}

TEST(svc_match_null_and_empty) {
    ASSERT_EQ(ctx_service_pattern_match(NULL), CTX_SVC_NONE);
    ASSERT_EQ(ctx_service_pattern_match(""), CTX_SVC_NONE);
    PASS();
}

/* ── ctx_service_pattern_http_method (suffix → HTTP method) ─────── */

TEST(http_method_get_suffix) {
    ASSERT_STR_EQ(ctx_service_pattern_http_method("requests.get"), "GET");
    PASS();
}

TEST(http_method_post_async_suffix) {
    ASSERT_STR_EQ(ctx_service_pattern_http_method("client.PostAsync"), "POST");
    PASS();
}

TEST(http_method_unknown_returns_null) {
    ASSERT(ctx_service_pattern_http_method("requests.send") == NULL);
    PASS();
}

/* ── Suite ──────────────────────────────────────────────────────── */

SUITE(service_patterns) {
    RUN_TEST(global_http_nuxt_fetch);
    RUN_TEST(global_http_use_fetch);
    RUN_TEST(global_http_use_lazy_fetch);
    RUN_TEST(global_http_platform_fetch);
    RUN_TEST(global_http_rejects_member_form);
    RUN_TEST(global_http_rejects_unrelated);
    RUN_TEST(global_http_rejects_empty_and_null);
    RUN_TEST(svc_match_requests_qn);
    RUN_TEST(svc_match_axios_qn);
    RUN_TEST(svc_match_express_is_route_reg);
    RUN_TEST(svc_match_none_for_arbitrary_qn);
    RUN_TEST(svc_match_null_and_empty);
    RUN_TEST(http_method_get_suffix);
    RUN_TEST(http_method_post_async_suffix);
    RUN_TEST(http_method_unknown_returns_null);
    RUN_TEST(extract_nuxt_dollar_fetch_call);
    RUN_TEST(extract_use_fetch_call_with_url_arg);
    RUN_TEST(extract_dollar_fetch_inside_define_store);
}

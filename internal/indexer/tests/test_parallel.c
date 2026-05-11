/*
 * test_parallel.c — Tests for the three-phase parallel pipeline.
 *
 * Validates parity between sequential (4-pass) and parallel (3-phase)
 * pipeline modes on a small Go test fixture.
 *
 * Suite: suite_parallel
 */
#include "../src/foundation/compat.h"
#include "test_framework.h"
#include "test_helpers.h"
#include "pipeline/pipeline.h"
#include "pipeline/pipeline_internal.h"
#include "pipeline/worker_pool.h"
#include "graph_buffer/graph_buffer.h"
#include "discover/discover.h"
#include "foundation/platform.h"
#include "foundation/log.h"
#include "extract.h"

#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <sys/stat.h>

/* ── Helper: create temp test repo ───────────────────────────────── */

static char g_par_tmpdir[256];

static int setup_parallel_repo(void) {
    snprintf(g_par_tmpdir, sizeof(g_par_tmpdir), "/tmp/ctx_par_XXXXXX");
    if (!ctx_mkdtemp(g_par_tmpdir))
        return -1;

    char path[512];

    /* main.go */
    snprintf(path, sizeof(path), "%s/main.go", g_par_tmpdir);
    FILE *f = fopen(path, "w");
    if (!f)
        return -1;
    fprintf(f, "package main\n\nimport \"pkg\"\n\n"
               "func main() {\n\tpkg.Serve()\n}\n");
    fclose(f);

    /* pkg/ */
    snprintf(path, sizeof(path), "%s/pkg", g_par_tmpdir);
    ctx_mkdir(path);

    /* pkg/service.go */
    snprintf(path, sizeof(path), "%s/pkg/service.go", g_par_tmpdir);
    f = fopen(path, "w");
    if (!f)
        return -1;
    fprintf(f, "package pkg\n\nimport \"pkg/util\"\n\n"
               "func Serve() {\n\tutil.Help()\n}\n");
    fclose(f);

    /* pkg/util/ */
    snprintf(path, sizeof(path), "%s/pkg/util", g_par_tmpdir);
    ctx_mkdir(path);

    /* pkg/util/helper.go */
    snprintf(path, sizeof(path), "%s/pkg/util/helper.go", g_par_tmpdir);
    f = fopen(path, "w");
    if (!f)
        return -1;
    fprintf(f, "package util\n\nfunc Help() {}\n");
    fclose(f);

    return 0;
}

static void rm_rf(const char *path) {
    th_rmtree(path);
}

static void teardown_parallel_repo(void) {
    if (g_par_tmpdir[0])
        rm_rf(g_par_tmpdir);
    g_par_tmpdir[0] = '\0';
}

/* ── Run sequential pipeline on files, returning gbuf ─────────────── */

static ctx_gbuf_t *run_sequential(const char *project, const char *repo_path,
                                  ctx_file_info_t *files, int file_count) {
    ctx_gbuf_t *gbuf = ctx_gbuf_new(project, repo_path);
    ctx_registry_t *reg = ctx_registry_new();
    atomic_int cancelled;
    atomic_init(&cancelled, 0);

    ctx_pipeline_ctx_t ctx = {
        .project_name = project,
        .repo_path = repo_path,
        .gbuf = gbuf,
        .registry = reg,
        .cancelled = &cancelled,
    };

    ctx_init();
    ctx_pipeline_pass_definitions(&ctx, files, file_count);
    ctx_pipeline_pass_calls(&ctx, files, file_count);
    ctx_pipeline_pass_usages(&ctx, files, file_count);
    ctx_pipeline_pass_semantic(&ctx, files, file_count);

    ctx_registry_free(reg);
    return gbuf;
}

/* ── Run parallel pipeline on files, returning gbuf ───────────────── */

static ctx_gbuf_t *run_parallel(const char *project, const char *repo_path, ctx_file_info_t *files,
                                int file_count, int worker_count) {
    ctx_gbuf_t *gbuf = ctx_gbuf_new(project, repo_path);
    ctx_registry_t *reg = ctx_registry_new();
    atomic_int cancelled;
    atomic_init(&cancelled, 0);

    ctx_pipeline_ctx_t ctx = {
        .project_name = project,
        .repo_path = repo_path,
        .gbuf = gbuf,
        .registry = reg,
        .cancelled = &cancelled,
    };

    _Atomic int64_t shared_ids;
    int64_t gbuf_next = ctx_gbuf_next_id(gbuf);
    atomic_init(&shared_ids, gbuf_next);

    CtxFileResult **result_cache = calloc(file_count, sizeof(CtxFileResult *));

    ctx_init();
    ctx_parallel_extract(&ctx, files, file_count, result_cache, &shared_ids, worker_count);
    ctx_gbuf_set_next_id(gbuf, atomic_load(&shared_ids));

    ctx_build_registry_from_cache(&ctx, files, file_count, result_cache);

    ctx_parallel_resolve(&ctx, files, file_count, result_cache, &shared_ids, worker_count);
    ctx_gbuf_set_next_id(gbuf, atomic_load(&shared_ids));

    for (int i = 0; i < file_count; i++)
        if (result_cache[i])
            ctx_free_result(result_cache[i]);
    free(result_cache);

    ctx_registry_free(reg);
    return gbuf;
}

/* ── Parity Tests ─────────────────────────────────────────────────── */

static ctx_gbuf_t *g_seq_gbuf = NULL;
static ctx_gbuf_t *g_par_gbuf = NULL;
static int g_parity_setup_done = 0;

static int ensure_parity_setup(void) {
    if (g_parity_setup_done)
        return 0;

    if (setup_parallel_repo() != 0)
        return -1;

    /* Discover files */
    ctx_discover_opts_t opts = {.mode = CTX_MODE_FULL};
    ctx_file_info_t *files = NULL;
    int file_count = 0;
    if (ctx_discover(g_par_tmpdir, &opts, &files, &file_count) != 0)
        return -1;

    const char *project = "par-test";

    /* Build structure for both (need File/Folder nodes before definitions) */
    /* For parity, we need the structure pass too. Let's just compare
     * definition/call/usage/semantic edge counts. */

    /* Run both modes */
    g_seq_gbuf = run_sequential(project, g_par_tmpdir, files, file_count);
    g_par_gbuf = run_parallel(project, g_par_tmpdir, files, file_count, 2);

    ctx_discover_free(files, file_count);
    g_parity_setup_done = 1;
    return 0;
}

static void parity_teardown(void) {
    if (g_seq_gbuf) {
        ctx_gbuf_free(g_seq_gbuf);
        g_seq_gbuf = NULL;
    }
    if (g_par_gbuf) {
        ctx_gbuf_free(g_par_gbuf);
        g_par_gbuf = NULL;
    }
    teardown_parallel_repo();
    g_parity_setup_done = 0;
}

/* Node count parity */
TEST(parallel_node_count) {
    if (ensure_parity_setup() != 0)
        SKIP("setup failed");
    int seq = ctx_gbuf_node_count(g_seq_gbuf);
    int par = ctx_gbuf_node_count(g_par_gbuf);
    ASSERT_GT(seq, 0);
    ASSERT_EQ(seq, par);
    PASS();
}

/* Edge type parity tests */
static int assert_edge_type_parity(const char *type) {
    if (ensure_parity_setup() != 0)
        return -1;
    int seq = ctx_gbuf_edge_count_by_type(g_seq_gbuf, type);
    int par = ctx_gbuf_edge_count_by_type(g_par_gbuf, type);
    if (seq != par) {
        printf("  FAIL: %s edges: seq=%d par=%d\n", type, seq, par);
        return 1;
    }
    return 0;
}

TEST(parallel_calls_parity) {
    int rc = assert_edge_type_parity("CALLS");
    if (rc == -1)
        SKIP("setup failed");
    ASSERT_EQ(rc, 0);
    PASS();
}

TEST(parallel_defines_parity) {
    int rc = assert_edge_type_parity("DEFINES");
    if (rc == -1)
        SKIP("setup failed");
    ASSERT_EQ(rc, 0);
    PASS();
}

TEST(parallel_defines_method_parity) {
    int rc = assert_edge_type_parity("DEFINES_METHOD");
    if (rc == -1)
        SKIP("setup failed");
    ASSERT_EQ(rc, 0);
    PASS();
}

TEST(parallel_imports_parity) {
    int rc = assert_edge_type_parity("IMPORTS");
    if (rc == -1)
        SKIP("setup failed");
    ASSERT_EQ(rc, 0);
    PASS();
}

TEST(parallel_usage_parity) {
    int rc = assert_edge_type_parity("USAGE");
    if (rc == -1)
        SKIP("setup failed");
    ASSERT_EQ(rc, 0);
    PASS();
}

TEST(parallel_inherits_parity) {
    int rc = assert_edge_type_parity("INHERITS");
    if (rc == -1)
        SKIP("setup failed");
    ASSERT_EQ(rc, 0);
    PASS();
}

TEST(parallel_implements_parity) {
    int rc = assert_edge_type_parity("IMPLEMENTS");
    if (rc == -1)
        SKIP("setup failed");
    ASSERT_EQ(rc, 0);
    PASS();
}

TEST(parallel_total_edges) {
    if (ensure_parity_setup() != 0)
        SKIP("setup failed");
    int seq = ctx_gbuf_edge_count(g_seq_gbuf);
    int par = ctx_gbuf_edge_count(g_par_gbuf);
    ASSERT_GT(seq, 0);
    ASSERT_EQ(seq, par);
    PASS();
}

/* ── Empty file list ──────────────────────────────────────────────── */

TEST(parallel_empty_files) {
    ctx_gbuf_t *gbuf = ctx_gbuf_new("empty-proj", "/tmp");
    ctx_registry_t *reg = ctx_registry_new();
    atomic_int cancelled;
    atomic_init(&cancelled, 0);

    ctx_pipeline_ctx_t ctx = {
        .project_name = "empty-proj",
        .repo_path = "/tmp",
        .gbuf = gbuf,
        .registry = reg,
        .cancelled = &cancelled,
    };

    _Atomic int64_t shared_ids;
    atomic_init(&shared_ids, 1);

    CtxFileResult **cache = NULL;
    int rc = ctx_parallel_extract(&ctx, NULL, 0, cache, &shared_ids, 2);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(ctx_gbuf_node_count(gbuf), 0);

    ctx_registry_free(reg);
    ctx_gbuf_free(gbuf);
    PASS();
}

/* ── Graph buffer merge tests ─────────────────────────────────────── */

TEST(gbuf_shared_ids_unique) {
    _Atomic int64_t shared = 1;
    ctx_gbuf_t *ga = ctx_gbuf_new_shared_ids("proj", "/", &shared);
    ctx_gbuf_t *gb = ctx_gbuf_new_shared_ids("proj", "/", &shared);

    int64_t id1 = ctx_gbuf_upsert_node(ga, "Function", "foo", "proj.foo", "a.go", 1, 5, "{}");
    int64_t id2 = ctx_gbuf_upsert_node(gb, "Function", "bar", "proj.bar", "b.go", 1, 3, "{}");
    ASSERT_GT(id1, 0);
    ASSERT_GT(id2, 0);
    ASSERT_NEQ(id1, id2);

    ctx_gbuf_free(ga);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_merge_nodes) {
    _Atomic int64_t shared = 1;
    ctx_gbuf_t *dst = ctx_gbuf_new_shared_ids("proj", "/", &shared);
    ctx_gbuf_t *src = ctx_gbuf_new_shared_ids("proj", "/", &shared);

    ctx_gbuf_upsert_node(dst, "Function", "a", "proj.a", "a.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(dst, "Function", "b", "proj.b", "a.go", 6, 10, "{}");
    ctx_gbuf_upsert_node(src, "Function", "c", "proj.c", "b.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(src, "Function", "d", "proj.d", "b.go", 6, 10, "{}");

    ASSERT_EQ(ctx_gbuf_node_count(dst), 2);
    ctx_gbuf_merge(dst, src);
    ASSERT_EQ(ctx_gbuf_node_count(dst), 4);

    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "proj.c"));
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "proj.d"));
    /* dst originals still there */
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "proj.a"));
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "proj.b"));

    ctx_gbuf_free(src);
    ctx_gbuf_free(dst);
    PASS();
}

TEST(gbuf_merge_edges) {
    _Atomic int64_t shared = 1;
    ctx_gbuf_t *dst = ctx_gbuf_new_shared_ids("proj", "/", &shared);
    ctx_gbuf_t *src = ctx_gbuf_new_shared_ids("proj", "/", &shared);

    int64_t a = ctx_gbuf_upsert_node(dst, "Function", "a", "proj.a", "a.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(dst, "Function", "b", "proj.b", "a.go", 6, 10, "{}");
    /* Put an edge in src that references dst nodes (by ID) */
    ctx_gbuf_insert_edge(src, a, b, "CALLS", "{}");

    ctx_gbuf_merge(dst, src);
    ASSERT_GT(ctx_gbuf_edge_count(dst), 0);

    const ctx_gbuf_edge_t **edges = NULL;
    int count = 0;
    ctx_gbuf_find_edges_by_source_type(dst, a, "CALLS", &edges, &count);
    ASSERT_EQ(count, 1);
    ASSERT_EQ(edges[0]->target_id, b);

    ctx_gbuf_free(src);
    ctx_gbuf_free(dst);
    PASS();
}

TEST(gbuf_merge_empty_src) {
    _Atomic int64_t shared = 1;
    ctx_gbuf_t *dst = ctx_gbuf_new_shared_ids("proj", "/", &shared);
    ctx_gbuf_t *src = ctx_gbuf_new_shared_ids("proj", "/", &shared);

    ctx_gbuf_upsert_node(dst, "Function", "a", "proj.a", "a.go", 1, 5, "{}");
    int before = ctx_gbuf_node_count(dst);
    ctx_gbuf_merge(dst, src);
    ASSERT_EQ(ctx_gbuf_node_count(dst), before);

    ctx_gbuf_free(src);
    ctx_gbuf_free(dst);
    PASS();
}

TEST(gbuf_merge_src_free_safe) {
    _Atomic int64_t shared = 1;
    ctx_gbuf_t *dst = ctx_gbuf_new_shared_ids("proj", "/", &shared);
    ctx_gbuf_t *src = ctx_gbuf_new_shared_ids("proj", "/", &shared);

    ctx_gbuf_upsert_node(src, "Function", "x", "proj.x", "x.go", 1, 5, "{}");
    ctx_gbuf_merge(dst, src);
    ctx_gbuf_free(src); /* must not crash */

    /* dst node still accessible */
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "proj.x"));
    ctx_gbuf_free(dst);
    PASS();
}

TEST(gbuf_next_id_accessors) {
    ctx_gbuf_t *gb = ctx_gbuf_new("proj", "/");
    ASSERT_EQ(ctx_gbuf_next_id(gb), 1);

    ctx_gbuf_upsert_node(gb, "Function", "foo", "proj.foo", "f.go", 1, 5, "{}");
    ASSERT_GT(ctx_gbuf_next_id(gb), 1);

    ctx_gbuf_set_next_id(gb, 100);
    int64_t id = ctx_gbuf_upsert_node(gb, "Function", "bar", "proj.bar", "f.go", 6, 10, "{}");
    ASSERT_GTE(id, 100);

    ctx_gbuf_free(gb);
    PASS();
}

/* ── Suite Registration ──────────────────────────────────────────── */

SUITE(parallel) {
    /* Graph buffer merge/shared-ID tests */
    RUN_TEST(gbuf_shared_ids_unique);
    RUN_TEST(gbuf_merge_nodes);
    RUN_TEST(gbuf_merge_edges);
    RUN_TEST(gbuf_merge_empty_src);
    RUN_TEST(gbuf_merge_src_free_safe);
    RUN_TEST(gbuf_next_id_accessors);

    /* Parallel pipeline parity tests */
    RUN_TEST(parallel_node_count);
    RUN_TEST(parallel_calls_parity);
    RUN_TEST(parallel_defines_parity);
    RUN_TEST(parallel_defines_method_parity);
    RUN_TEST(parallel_imports_parity);
    RUN_TEST(parallel_usage_parity);
    RUN_TEST(parallel_inherits_parity);
    RUN_TEST(parallel_implements_parity);
    RUN_TEST(parallel_total_edges);
    RUN_TEST(parallel_empty_files);

    /* Cleanup shared state */
    parity_teardown();
}

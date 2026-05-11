/*
 * test_store_search.c — Tests for search and traversal operations.
 *
 * Ported from internal/store/store_test.go (TestSearch, TestBFS, etc.)
 */
#include "../src/foundation/compat.h"
#include "test_framework.h"
#include "test_helpers.h"
#include <store/store.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>

/* Helper: create a typical graph for search/traversal tests.
 *
 * Nodes: SubmitOrder (Function), ProcessOrder (Function), OrderService (Class)
 * Edges: SubmitOrder → ProcessOrder (CALLS)
 *
 * Returns store handle. Fills ids[3].
 */
static ctx_store_t *setup_search_store(int64_t *ids) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_node_t n1 = {.project = "test",
                     .label = "Function",
                     .name = "SubmitOrder",
                     .qualified_name = "test.main.SubmitOrder",
                     .file_path = "main.go"};
    ctx_node_t n2 = {.project = "test",
                     .label = "Function",
                     .name = "ProcessOrder",
                     .qualified_name = "test.service.ProcessOrder",
                     .file_path = "service.go"};
    ctx_node_t n3 = {.project = "test",
                     .label = "Class",
                     .name = "OrderService",
                     .qualified_name = "test.service.OrderService",
                     .file_path = "service.go"};

    ids[0] = ctx_store_upsert_node(s, &n1);
    ids[1] = ctx_store_upsert_node(s, &n2);
    ids[2] = ctx_store_upsert_node(s, &n3);

    ctx_edge_t e = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_store_insert_edge(s, &e);

    return s;
}

/* ── Search by label ────────────────────────────────────────────── */

TEST(store_search_by_label) {
    int64_t ids[3];
    ctx_store_t *s = setup_search_store(ids);

    ctx_search_params_t params = {
        .project = "test", .label = "Function", .min_degree = -1, .max_degree = -1};
    ctx_search_output_t out = {0};
    int rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out.count, 2);
    ASSERT_EQ(out.total, 2);
    ctx_store_search_free(&out);

    ctx_store_close(s);
    PASS();
}

/* ── Search by name pattern ─────────────────────────────────────── */

TEST(store_search_by_name_pattern) {
    int64_t ids[3];
    ctx_store_t *s = setup_search_store(ids);

    ctx_search_params_t params = {
        .project = "test", .name_pattern = ".*Submit.*", .min_degree = -1, .max_degree = -1};
    ctx_search_output_t out = {0};
    int rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out.count, 1);
    ASSERT_STR_EQ(out.results[0].node.name, "SubmitOrder");
    ctx_store_search_free(&out);

    ctx_store_close(s);
    PASS();
}

/* ── Search by file pattern ─────────────────────────────────────── */

TEST(store_search_by_file_pattern) {
    int64_t ids[3];
    ctx_store_t *s = setup_search_store(ids);

    ctx_search_params_t params = {
        .project = "test", .file_pattern = "service*", .min_degree = -1, .max_degree = -1};
    ctx_search_output_t out = {0};
    int rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out.count, 2);
    ctx_store_search_free(&out);

    ctx_store_close(s);
    PASS();
}

/* ── Search pagination ──────────────────────────────────────────── */

TEST(store_search_pagination) {
    int64_t ids[3];
    ctx_store_t *s = setup_search_store(ids);

    /* limit=1 */
    ctx_search_params_t params = {
        .project = "test", .limit = 1, .min_degree = -1, .max_degree = -1};
    ctx_search_output_t out = {0};
    int rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out.count, 1);
    ASSERT_EQ(out.total, 3);
    ctx_store_search_free(&out);

    /* limit=1, offset=1 */
    params.offset = 1;
    rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out.count, 1);
    ASSERT_EQ(out.total, 3);
    ctx_store_search_free(&out);

    /* offset past end */
    params.offset = 100;
    rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out.count, 0);
    ASSERT_EQ(out.total, 3);
    ctx_store_search_free(&out);

    ctx_store_close(s);
    PASS();
}

/* ── Search with degree filter ──────────────────────────────────── */

TEST(store_search_degree_filter) {
    int64_t ids[3];
    ctx_store_t *s = setup_search_store(ids);

    /* SubmitOrder has out_degree=1, ProcessOrder has in_degree=1.
     * Degree filters: -1 = no filter, 0+ = active. */
    ctx_search_params_t params = {
        .project = "test", .label = "Function", .min_degree = 1, .max_degree = -1};
    ctx_search_output_t out = {0};
    int rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    /* Both functions have degree >= 1 */
    ASSERT_EQ(out.count, 2);
    ctx_store_search_free(&out);

    /* max_degree = 0 should find nodes with no CALLS edges */
    params.min_degree = -1; /* no min */
    params.max_degree = 0;  /* only zero-degree nodes */
    params.label = "Function";
    rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    /* Neither function has degree 0, so 0 results */
    ASSERT_EQ(out.count, 0);
    ctx_store_search_free(&out);

    ctx_store_close(s);
    PASS();
}

/* ── Search all (no filters) ────────────────────────────────────── */

TEST(store_search_all) {
    int64_t ids[3];
    ctx_store_t *s = setup_search_store(ids);

    ctx_search_params_t params = {.project = "test", .min_degree = -1, .max_degree = -1};
    ctx_search_output_t out = {0};
    int rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out.count, 3);
    ASSERT_EQ(out.total, 3);
    ctx_store_search_free(&out);

    ctx_store_close(s);
    PASS();
}

/* ── BFS traversal ──────────────────────────────────────────────── */

TEST(store_bfs_outbound) {
    int64_t ids[4];
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    /* A → B → C → D chain */
    ctx_node_t na = {
        .project = "test", .label = "Function", .name = "A", .qualified_name = "test.A"};
    ctx_node_t nb = {
        .project = "test", .label = "Function", .name = "B", .qualified_name = "test.B"};
    ctx_node_t nc = {
        .project = "test", .label = "Function", .name = "C", .qualified_name = "test.C"};
    ctx_node_t nd = {
        .project = "test", .label = "Function", .name = "D", .qualified_name = "test.D"};
    ids[0] = ctx_store_upsert_node(s, &na);
    ids[1] = ctx_store_upsert_node(s, &nb);
    ids[2] = ctx_store_upsert_node(s, &nc);
    ids[3] = ctx_store_upsert_node(s, &nd);

    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_edge_t e2 = {.project = "test", .source_id = ids[1], .target_id = ids[2], .type = "CALLS"};
    ctx_edge_t e3 = {.project = "test", .source_id = ids[2], .target_id = ids[3], .type = "CALLS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);
    ctx_store_insert_edge(s, &e3);

    /* BFS from A, outbound, depth 3 */
    const char *types[] = {"CALLS"};
    ctx_traverse_result_t result = {0};
    int rc = ctx_store_bfs(s, ids[0], "outbound", types, 1, 3, 100, &result);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_STR_EQ(result.root.name, "A");
    ASSERT_GTE(result.visited_count, 3); /* B, C, D */
    ctx_store_traverse_free(&result);

    /* BFS with depth=1 */
    rc = ctx_store_bfs(s, ids[0], "outbound", types, 1, 1, 100, &result);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(result.visited_count, 1); /* only B */
    ctx_store_traverse_free(&result);

    ctx_store_close(s);
    PASS();
}

TEST(store_bfs_inbound) {
    int64_t ids[3];
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_node_t na = {
        .project = "test", .label = "Function", .name = "A", .qualified_name = "test.A"};
    ctx_node_t nb = {
        .project = "test", .label = "Function", .name = "B", .qualified_name = "test.B"};
    ctx_node_t nc = {
        .project = "test", .label = "Function", .name = "C", .qualified_name = "test.C"};
    ids[0] = ctx_store_upsert_node(s, &na);
    ids[1] = ctx_store_upsert_node(s, &nb);
    ids[2] = ctx_store_upsert_node(s, &nc);

    /* A → C, B → C */
    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[2], .type = "CALLS"};
    ctx_edge_t e2 = {.project = "test", .source_id = ids[1], .target_id = ids[2], .type = "CALLS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);

    /* BFS from C, inbound → should find A and B */
    const char *types[] = {"CALLS"};
    ctx_traverse_result_t result = {0};
    int rc = ctx_store_bfs(s, ids[2], "inbound", types, 1, 3, 100, &result);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(result.visited_count, 2); /* A and B */
    ctx_store_traverse_free(&result);

    ctx_store_close(s);
    PASS();
}

/* ── Transaction ────────────────────────────────────────────────── */

TEST(store_transaction_commit) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_store_begin(s);
    ctx_node_t n = {
        .project = "test", .label = "Function", .name = "TxTest", .qualified_name = "test.TxTest"};
    ctx_store_upsert_node(s, &n);
    ctx_store_commit(s);

    int cnt = ctx_store_count_nodes(s, "test");
    ASSERT_EQ(cnt, 1);

    ctx_store_close(s);
    PASS();
}

TEST(store_transaction_rollback) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_store_begin(s);
    ctx_node_t n = {
        .project = "test", .label = "Function", .name = "TxTest", .qualified_name = "test.TxTest"};
    ctx_store_upsert_node(s, &n);
    ctx_store_rollback(s);

    int cnt = ctx_store_count_nodes(s, "test");
    ASSERT_EQ(cnt, 0);

    ctx_store_close(s);
    PASS();
}

/* ── Bulk write mode ────────────────────────────────────────────── */

TEST(store_bulk_write_mode) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_store_begin_bulk(s);
    ctx_store_drop_indexes(s);

    /* Insert many nodes in bulk */
    for (int i = 0; i < 50; i++) {
        char name[16], qn[32];
        snprintf(name, sizeof(name), "f%d", i);
        snprintf(qn, sizeof(qn), "test.f%d", i);
        ctx_node_t n = {.project = "test", .label = "Function", .name = name, .qualified_name = qn};
        ctx_store_upsert_node(s, &n);
    }

    ctx_store_create_indexes(s);
    ctx_store_end_bulk(s);

    int cnt = ctx_store_count_nodes(s, "test");
    ASSERT_EQ(cnt, 50);

    ctx_store_close(s);
    PASS();
}

/* ── Schema introspection ───────────────────────────────────────── */

TEST(store_schema_info) {
    int64_t ids[3];
    ctx_store_t *s = setup_search_store(ids);

    ctx_schema_info_t schema = {0};
    int rc = ctx_store_get_schema(s, "test", &schema);
    ASSERT_EQ(rc, CTX_STORE_OK);

    /* Should have labels: Function, Class */
    ASSERT_GTE(schema.node_label_count, 2);

    /* Should have edge type: CALLS */
    ASSERT_GTE(schema.edge_type_count, 1);

    ctx_store_schema_free(&schema);
    ctx_store_close(s);
    PASS();
}

/* ── Search with exclude_labels ─────────────────────────────────── */

TEST(store_search_exclude_labels) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    /* Create nodes with different labels */
    ctx_node_t n1 = {.project = "test",
                     .label = "Function",
                     .name = "node_Function",
                     .qualified_name = "test.Function.node_0",
                     .file_path = "test.go"};
    ctx_node_t n2 = {.project = "test",
                     .label = "Route",
                     .name = "node_Route",
                     .qualified_name = "test.Route.node_1",
                     .file_path = "test.go"};
    ctx_node_t n3 = {.project = "test",
                     .label = "Method",
                     .name = "node_Method",
                     .qualified_name = "test.Method.node_2",
                     .file_path = "test.go"};
    ctx_node_t n4 = {.project = "test",
                     .label = "Route",
                     .name = "node_Route2",
                     .qualified_name = "test.Route.node_3",
                     .file_path = "test.go"};
    ctx_store_upsert_node(s, &n1);
    ctx_store_upsert_node(s, &n2);
    ctx_store_upsert_node(s, &n3);
    ctx_store_upsert_node(s, &n4);

    /* Search without exclusion */
    ctx_search_params_t params = {
        .project = "test", .limit = 100, .min_degree = -1, .max_degree = -1};
    ctx_search_output_t out = {0};
    int rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    int total = out.total;
    ASSERT_EQ(total, 4);
    ctx_store_search_free(&out);

    /* Search with Route excluded */
    const char *excl[] = {"Route", NULL};
    ctx_search_params_t params2 = {.project = "test",
                                   .limit = 100,
                                   .min_degree = -1,
                                   .max_degree = -1,
                                   .exclude_labels = excl};
    ctx_search_output_t out2 = {0};
    rc = ctx_store_search(s, &params2, &out2);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_TRUE(out2.total < total);

    /* Verify no Route nodes in results */
    for (int i = 0; i < out2.count; i++) {
        ASSERT_FALSE(strcmp(out2.results[i].node.label, "Route") == 0);
    }
    ctx_store_search_free(&out2);

    ctx_store_close(s);
    PASS();
}

/* ── Dump to file ──────────────────────────────────────────────── */

TEST(store_dump_to_file) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_node_t n = {.project = "test",
                    .label = "Function",
                    .name = "Hello",
                    .qualified_name = "test.main.Hello",
                    .file_path = "main.go",
                    .start_line = 1,
                    .end_line = 5,
                    .properties_json = "{\"sig\":\"func Hello()\"}"};
    int64_t id = ctx_store_upsert_node(s, &n);
    ASSERT_TRUE(id > 0);

    /* Dump to temp file */
    char *td = th_mktempdir("ctx_dump");
    char path[256];
    snprintf(path, sizeof(path), "%s/test.db", td);

    int rc = ctx_store_dump_to_file(s, path);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ctx_store_close(s);

    /* Open dumped file and verify data */
    ctx_store_t *disk = ctx_store_open_path(path);
    ASSERT_NOT_NULL(disk);

    ctx_node_t found = {0};
    rc = ctx_store_find_node_by_qn(disk, "test", "test.main.Hello", &found);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_STR_EQ(found.name, "Hello");
    ctx_node_free_fields(&found);

    ctx_store_close(disk);
    unlink(path);
    PASS();
}

/* ── BFS with cross-service (HTTP_CALLS) edges ─────────────────── */

TEST(store_bfs_cross_service) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_node_t na = {
        .project = "test", .label = "Function", .name = "A", .qualified_name = "test.A"};
    ctx_node_t nb = {
        .project = "test", .label = "Function", .name = "B", .qualified_name = "test.B"};
    int64_t idA = ctx_store_upsert_node(s, &na);
    int64_t idB = ctx_store_upsert_node(s, &nb);

    ctx_edge_t e = {.project = "test", .source_id = idA, .target_id = idB, .type = "HTTP_CALLS"};
    ctx_store_insert_edge(s, &e);

    /* BFS from A with both CALLS and HTTP_CALLS */
    const char *types[] = {"CALLS", "HTTP_CALLS"};
    ctx_traverse_result_t result = {0};
    int rc = ctx_store_bfs(s, idA, "outbound", types, 2, 1, 200, &result);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_GTE(result.visited_count, 1); /* B */

    /* Verify that we found B via HTTP_CALLS */
    int found_b = 0;
    for (int i = 0; i < result.visited_count; i++) {
        if (strcmp(result.visited[i].node.name, "B") == 0)
            found_b = 1;
    }
    ASSERT_TRUE(found_b);

    /* Check edges contain HTTP_CALLS type */
    int found_http = 0;
    for (int i = 0; i < result.edge_count; i++) {
        if (strcmp(result.edges[i].type, "HTTP_CALLS") == 0)
            found_http = 1;
    }
    ASSERT_TRUE(found_http);

    ctx_store_traverse_free(&result);
    ctx_store_close(s);
    PASS();
}

/* ── BFS depth-limited chain ───────────────────────────────────── */

TEST(store_bfs_depth_chain) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    /* Build chain: A → B → C → D */
    ctx_node_t na = {
        .project = "test", .label = "Function", .name = "A", .qualified_name = "test.A"};
    ctx_node_t nb = {
        .project = "test", .label = "Function", .name = "B", .qualified_name = "test.B"};
    ctx_node_t nc = {
        .project = "test", .label = "Function", .name = "C", .qualified_name = "test.C"};
    ctx_node_t nd = {
        .project = "test", .label = "Function", .name = "D", .qualified_name = "test.D"};
    int64_t idA = ctx_store_upsert_node(s, &na);
    int64_t idB = ctx_store_upsert_node(s, &nb);
    int64_t idC = ctx_store_upsert_node(s, &nc);
    int64_t idD = ctx_store_upsert_node(s, &nd);

    ctx_edge_t e1 = {.project = "test", .source_id = idA, .target_id = idB, .type = "CALLS"};
    ctx_edge_t e2 = {.project = "test", .source_id = idB, .target_id = idC, .type = "CALLS"};
    ctx_edge_t e3 = {.project = "test", .source_id = idC, .target_id = idD, .type = "CALLS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);
    ctx_store_insert_edge(s, &e3);

    /* BFS from A, depth=3 should find B(hop1), C(hop2), D(hop3) */
    const char *types[] = {"CALLS"};
    ctx_traverse_result_t result = {0};
    int rc = ctx_store_bfs(s, idA, "outbound", types, 1, 3, 100, &result);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(result.visited_count, 3);

    /* Verify hop distances */
    for (int i = 0; i < result.visited_count; i++) {
        if (strcmp(result.visited[i].node.name, "B") == 0)
            ASSERT_EQ(result.visited[i].hop, 1);
        if (strcmp(result.visited[i].node.name, "C") == 0)
            ASSERT_EQ(result.visited[i].hop, 2);
        if (strcmp(result.visited[i].node.name, "D") == 0)
            ASSERT_EQ(result.visited[i].hop, 3);
    }

    ctx_store_traverse_free(&result);
    ctx_store_close(s);
    PASS();
}

/* ── Search case insensitive ───────────────────────────────────── */

TEST(store_search_case_insensitive) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_node_t n = {.project = "test",
                    .label = "Function",
                    .name = "HandleRequest",
                    .qualified_name = "test.HandleRequest"};
    ctx_store_upsert_node(s, &n);

    /* Case-insensitive search (default) */
    ctx_search_params_t params = {.project = "test",
                                  .name_pattern = ".*handlerequest.*",
                                  .min_degree = -1,
                                  .max_degree = -1,
                                  .case_sensitive = false};
    ctx_search_output_t out = {0};
    int rc = ctx_store_search(s, &params, &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out.count, 1);
    ctx_store_search_free(&out);

    /* Case-sensitive search — should NOT match */
    ctx_search_params_t params2 = {.project = "test",
                                   .name_pattern = ".*handlerequest.*",
                                   .min_degree = -1,
                                   .max_degree = -1,
                                   .case_sensitive = true};
    ctx_search_output_t out2 = {0};
    rc = ctx_store_search(s, &params2, &out2);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(out2.count, 0);
    ctx_store_search_free(&out2);

    ctx_store_close(s);
    PASS();
}

/* ── Impact: HopToRisk ─────────────────────────────────────────── */

TEST(store_hop_to_risk) {
    ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(1)), "CRITICAL");
    ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(2)), "HIGH");
    ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(3)), "MEDIUM");
    ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(4)), "LOW");
    ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(5)), "LOW");
    ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(10)), "LOW");
    PASS();
}

/* ── Impact: BuildImpactSummary ────────────────────────────────── */

TEST(store_build_impact_summary) {
    ctx_node_hop_t hops[5] = {
        {.node = {.id = 1}, .hop = 1}, {.node = {.id = 2}, .hop = 1}, {.node = {.id = 3}, .hop = 2},
        {.node = {.id = 4}, .hop = 3}, {.node = {.id = 5}, .hop = 4},
    };
    ctx_edge_info_t edges[1] = {
        {.from_name = "A", .to_name = "B", .type = "CALLS"},
    };

    ctx_impact_summary_t s = ctx_build_impact_summary(hops, 5, edges, 1);
    ASSERT_EQ(s.critical, 2);
    ASSERT_EQ(s.high, 1);
    ASSERT_EQ(s.medium, 1);
    ASSERT_EQ(s.low, 1);
    ASSERT_EQ(s.total, 5);
    ASSERT_FALSE(s.has_cross_service);
    PASS();
}

/* ── Impact: cross-service detection ──────────────────────────── */

TEST(store_cross_service_detection) {
    ctx_node_hop_t hops[1] = {{.node = {.id = 1}, .hop = 1}};

    ctx_edge_info_t edges_http[1] = {
        {.from_name = "A", .to_name = "B", .type = "HTTP_CALLS"},
    };
    ctx_impact_summary_t s1 = ctx_build_impact_summary(hops, 1, edges_http, 1);
    ASSERT_TRUE(s1.has_cross_service);

    ctx_edge_info_t edges_async[1] = {
        {.from_name = "A", .to_name = "B", .type = "ASYNC_CALLS"},
    };
    ctx_impact_summary_t s2 = ctx_build_impact_summary(hops, 1, edges_async, 1);
    ASSERT_TRUE(s2.has_cross_service);
    PASS();
}

/* ── Impact: DeduplicateHops ──────────────────────────────────── */

TEST(store_deduplicate_hops) {
    ctx_node_hop_t hops[4] = {
        {.node = {.id = 1, .name = "A"}, .hop = 2},
        {.node = {.id = 1, .name = "A"}, .hop = 3}, /* duplicate at higher hop */
        {.node = {.id = 2, .name = "B"}, .hop = 1},
        {.node = {.id = 3, .name = "C"}, .hop = 3},
    };

    ctx_node_hop_t *result = NULL;
    int count = 0;
    int rc = ctx_deduplicate_hops(hops, 4, &result, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 3);

    /* Find node 1 — should have minimum hop = 2 */
    int found1 = 0;
    for (int i = 0; i < count; i++) {
        if (result[i].node.id == 1) {
            ASSERT_EQ(result[i].hop, 2);
            found1 = 1;
        }
    }
    ASSERT_TRUE(found1);

    free(result);
    PASS();
}

/* ── BFS with risk labels (from store_test.go) ─────────────────── */

TEST(store_bfs_with_risk_labels) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    /* Build chain: A → B → C → D */
    ctx_node_t na = {
        .project = "test", .label = "Function", .name = "A", .qualified_name = "test.A"};
    ctx_node_t nb = {
        .project = "test", .label = "Function", .name = "B", .qualified_name = "test.B"};
    ctx_node_t nc = {
        .project = "test", .label = "Function", .name = "C", .qualified_name = "test.C"};
    ctx_node_t nd = {
        .project = "test", .label = "Function", .name = "D", .qualified_name = "test.D"};
    int64_t idA = ctx_store_upsert_node(s, &na);
    (void)ctx_store_upsert_node(s, &nb);
    (void)ctx_store_upsert_node(s, &nc);
    (void)ctx_store_upsert_node(s, &nd);

    ctx_edge_t e1 = {.project = "test", .source_id = idA, .target_id = idA + 1, .type = "CALLS"};
    ctx_edge_t e2 = {
        .project = "test", .source_id = idA + 1, .target_id = idA + 2, .type = "CALLS"};
    ctx_edge_t e3 = {
        .project = "test", .source_id = idA + 2, .target_id = idA + 3, .type = "CALLS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);
    ctx_store_insert_edge(s, &e3);

    const char *types[] = {"CALLS"};
    ctx_traverse_result_t result = {0};
    int rc = ctx_store_bfs(s, idA, "outbound", types, 1, 3, 200, &result);
    ASSERT_EQ(rc, CTX_STORE_OK);

    /* Deduplicate */
    ctx_node_hop_t *deduped = NULL;
    int dcount = 0;
    ctx_deduplicate_hops(result.visited, result.visited_count, &deduped, &dcount);
    ASSERT_EQ(dcount, 3);

    /* Verify risk labels */
    for (int i = 0; i < dcount; i++) {
        if (strcmp(deduped[i].node.name, "B") == 0)
            ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(deduped[i].hop)), "CRITICAL");
        if (strcmp(deduped[i].node.name, "C") == 0)
            ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(deduped[i].hop)), "HIGH");
        if (strcmp(deduped[i].node.name, "D") == 0)
            ASSERT_STR_EQ(ctx_risk_label(ctx_hop_to_risk(deduped[i].hop)), "MEDIUM");
    }

    /* Build summary */
    ctx_impact_summary_t summary =
        ctx_build_impact_summary(deduped, dcount, result.edges, result.edge_count);
    ASSERT_EQ(summary.critical, 1);
    ASSERT_EQ(summary.high, 1);
    ASSERT_EQ(summary.medium, 1);
    ASSERT_EQ(summary.total, 3);

    free(deduped);
    ctx_store_traverse_free(&result);
    ctx_store_close(s);
    PASS();
}

/* ── BFS cross-service summary ─────────────────────────────────── */

TEST(store_bfs_cross_service_summary) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_node_t na = {
        .project = "test", .label = "Function", .name = "A", .qualified_name = "test.A"};
    ctx_node_t nb = {
        .project = "test", .label = "Function", .name = "B", .qualified_name = "test.B"};
    int64_t idA = ctx_store_upsert_node(s, &na);
    int64_t idB = ctx_store_upsert_node(s, &nb);

    ctx_edge_t e = {.project = "test", .source_id = idA, .target_id = idB, .type = "HTTP_CALLS"};
    ctx_store_insert_edge(s, &e);

    const char *types[] = {"CALLS", "HTTP_CALLS"};
    ctx_traverse_result_t result = {0};
    int rc = ctx_store_bfs(s, idA, "outbound", types, 2, 1, 200, &result);
    ASSERT_EQ(rc, CTX_STORE_OK);

    ctx_impact_summary_t summary = ctx_build_impact_summary(result.visited, result.visited_count,
                                                            result.edges, result.edge_count);
    ASSERT_TRUE(summary.has_cross_service);

    ctx_store_traverse_free(&result);
    ctx_store_close(s);
    PASS();
}

/* ── GlobToLike ─────────────────────────────────────────────────── */

TEST(store_glob_to_like) {
    struct {
        const char *pattern;
        const char *want;
    } tests[] = {
        {"**/*.py", "%%.py"},
        {"**/dir/**", "%dir%"},
        {"*.go", "%.go"},
        {"src/**", "src%"},
        {"**/test_*.py", "%test_%.py"},
        {"file?.txt", "file_.txt"},
        {"exact.go", "exact.go"},
        {"**/custom-pip-package/**", "%custom-pip-package%"},
    };

    for (int i = 0; i < 8; i++) {
        char *got = ctx_glob_to_like(tests[i].pattern);
        ASSERT_NOT_NULL(got);
        ASSERT_STR_EQ(got, tests[i].want);
        free(got);
    }

    /* NULL returns NULL */
    ASSERT_NULL(ctx_glob_to_like(NULL));

    PASS();
}

/* ── ExtractLikeHints ────────────────────────────────────────────── */

TEST(store_extract_like_hints) {
    char *hints[16];
    int n;

    /* Basic: .*handler.* → ["handler"] */
    n = ctx_extract_like_hints(".*handler.*", hints, 16);
    ASSERT_EQ(n, 1);
    ASSERT_STR_EQ(hints[0], "handler");
    free(hints[0]);

    /* Multiple segments: .*Order.*Handler.* → ["Order", "Handler"] */
    n = ctx_extract_like_hints(".*Order.*Handler.*", hints, 16);
    ASSERT_EQ(n, 2);
    ASSERT_STR_EQ(hints[0], "Order");
    ASSERT_STR_EQ(hints[1], "Handler");
    free(hints[0]);
    free(hints[1]);

    /* Plain literal: "handler" → ["handler"] */
    n = ctx_extract_like_hints("handler", hints, 16);
    ASSERT_EQ(n, 1);
    ASSERT_STR_EQ(hints[0], "handler");
    free(hints[0]);

    /* Anchored: ^handleRequest$ → ["handleRequest"] */
    n = ctx_extract_like_hints("^handleRequest$", hints, 16);
    ASSERT_EQ(n, 1);
    ASSERT_STR_EQ(hints[0], "handleRequest");
    free(hints[0]);

    /* Too generic: .* → no hints */
    n = ctx_extract_like_hints(".*", hints, 16);
    ASSERT_EQ(n, 0);

    /* Short literal: .*ab.* → "ab" is only 2 chars, below threshold */
    n = ctx_extract_like_hints(".*ab.*", hints, 16);
    ASSERT_EQ(n, 0);

    /* Exactly 3 chars: .*abc.* → ["abc"] */
    n = ctx_extract_like_hints(".*abc.*", hints, 16);
    ASSERT_EQ(n, 1);
    ASSERT_STR_EQ(hints[0], "abc");
    free(hints[0]);

    /* Alternation: bail out */
    n = ctx_extract_like_hints(".*foo|.*bar", hints, 16);
    ASSERT_EQ(n, 0);

    n = ctx_extract_like_hints(".*Order.*|.*Handler.*", hints, 16);
    ASSERT_EQ(n, 0);

    /* Escaped dot: \\. is ".", only 1 char */
    n = ctx_extract_like_hints("\\.", hints, 16);
    ASSERT_EQ(n, 0);

    /* Multi-segment with underscore: .*test_.*helper.* → ["test_", "helper"] */
    n = ctx_extract_like_hints(".*test_.*helper.*", hints, 16);
    ASSERT_EQ(n, 2);
    ASSERT_STR_EQ(hints[0], "test_");
    ASSERT_STR_EQ(hints[1], "helper");
    free(hints[0]);
    free(hints[1]);

    /* NULL safety */
    n = ctx_extract_like_hints(NULL, hints, 16);
    ASSERT_EQ(n, 0);

    PASS();
}

/* ── EnsureCaseInsensitive ──────────────────────────────────────── */

TEST(store_ensure_case_insensitive) {
    ASSERT_STR_EQ(ctx_ensure_case_insensitive("handler"), "(?i)handler");
    ASSERT_STR_EQ(ctx_ensure_case_insensitive("(?i)handler"), "(?i)handler");
    ASSERT_STR_EQ(ctx_ensure_case_insensitive(".*Order.*"), "(?i).*Order.*");
    ASSERT_STR_EQ(ctx_ensure_case_insensitive(""), "(?i)");
    PASS();
}

/* ── StripCaseFlag ──────────────────────────────────────────────── */

TEST(store_strip_case_flag) {
    ASSERT_STR_EQ(ctx_strip_case_flag("(?i)handler"), "handler");
    ASSERT_STR_EQ(ctx_strip_case_flag("handler"), "handler");
    ASSERT_STR_EQ(ctx_strip_case_flag("(?i)(?i)double"), "(?i)double");
    PASS();
}

TEST(store_batch_count_degrees) {
    ctx_store_t *s = ctx_store_open_memory();
    ASSERT_NOT_NULL(s);
    ctx_store_upsert_project(s, "test", "/tmp/test");

    /* A -> B, A -> C, B -> C (CALLS), A -> C (USAGE) */
    ctx_node_t na = {
        .project = "test", .label = "Function", .name = "A", .qualified_name = "test.A"};
    ctx_node_t nb = {
        .project = "test", .label = "Function", .name = "B", .qualified_name = "test.B"};
    ctx_node_t nc = {
        .project = "test", .label = "Function", .name = "C", .qualified_name = "test.C"};
    int64_t idA = ctx_store_upsert_node(s, &na);
    int64_t idB = ctx_store_upsert_node(s, &nb);
    int64_t idC = ctx_store_upsert_node(s, &nc);

    ctx_edge_t e1 = {.project = "test", .source_id = idA, .target_id = idB, .type = "CALLS"};
    ctx_edge_t e2 = {.project = "test", .source_id = idA, .target_id = idC, .type = "CALLS"};
    ctx_edge_t e3 = {.project = "test", .source_id = idB, .target_id = idC, .type = "CALLS"};
    ctx_edge_t e4 = {.project = "test", .source_id = idA, .target_id = idC, .type = "USAGE"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);
    ctx_store_insert_edge(s, &e3);
    ctx_store_insert_edge(s, &e4);

    /* All edge types */
    int64_t ids3[] = {idA, idB, idC};
    int in3[3], out3[3];
    int rc = ctx_store_batch_count_degrees(s, ids3, 3, NULL, in3, out3);
    ASSERT_EQ(rc, CTX_STORE_OK);
    /* A: in=0, out=3 (2 CALLS + 1 USAGE) */
    ASSERT_EQ(in3[0], 0);
    ASSERT_EQ(out3[0], 3);
    /* B: in=1, out=1 */
    ASSERT_EQ(in3[1], 1);
    ASSERT_EQ(out3[1], 1);
    /* C: in=3, out=0 */
    ASSERT_EQ(in3[2], 3);
    ASSERT_EQ(out3[2], 0);

    /* Filtered by CALLS only */
    int64_t ids2[] = {idA, idC};
    int in2[2], out2[2];
    rc = ctx_store_batch_count_degrees(s, ids2, 2, "CALLS", in2, out2);
    ASSERT_EQ(rc, CTX_STORE_OK);
    /* A: in=0, out=2 (CALLS only) */
    ASSERT_EQ(in2[0], 0);
    ASSERT_EQ(out2[0], 2);
    /* C: in=2, out=0 (CALLS only) */
    ASSERT_EQ(in2[1], 2);
    ASSERT_EQ(out2[1], 0);

    ctx_store_close(s);
    PASS();
}

/* ── GlobToLike edge cases ──────────────────────────────────────── */

TEST(store_glob_to_like_empty) {
    char *got = ctx_glob_to_like("");
    ASSERT_NOT_NULL(got);
    ASSERT_STR_EQ(got, "");
    free(got);
    PASS();
}

TEST(store_glob_to_like_only_star) {
    char *got = ctx_glob_to_like("*");
    ASSERT_NOT_NULL(got);
    ASSERT_STR_EQ(got, "%");
    free(got);
    PASS();
}

TEST(store_glob_to_like_consecutive_doublestar) {
    /* double-star slash double-star should collapse to %% */
    char *got = ctx_glob_to_like("**/**");
    ASSERT_NOT_NULL(got);
    ASSERT_STR_EQ(got, "%%");
    free(got);
    PASS();
}

TEST(store_glob_to_like_dot_and_brackets) {
    /* Dots and brackets are literal in glob-to-LIKE — passed through */
    char *got = ctx_glob_to_like("src/[abc]/*.ts");
    ASSERT_NOT_NULL(got);
    ASSERT_STR_EQ(got, "src/[abc]/%.ts");
    free(got);
    PASS();
}

TEST(store_glob_to_like_question_marks) {
    /* Multiple ? should produce multiple _ */
    char *got = ctx_glob_to_like("f???.txt");
    ASSERT_NOT_NULL(got);
    ASSERT_STR_EQ(got, "f___.txt");
    free(got);
    PASS();
}

/* ── ExtractLikeHints edge cases ───────────────────────────────── */

TEST(store_extract_like_hints_null_out) {
    /* NULL out array */
    int n = ctx_extract_like_hints(".*handler.*", NULL, 16);
    ASSERT_EQ(n, 0);
    PASS();
}

TEST(store_extract_like_hints_zero_max) {
    char *hints[4];
    int n = ctx_extract_like_hints(".*handler.*", hints, 0);
    ASSERT_EQ(n, 0);
    PASS();
}

TEST(store_extract_like_hints_alternation_complex) {
    char *hints[16];
    /* Alternation with multiple segments on each side */
    int n = ctx_extract_like_hints("(foo|bar)baz", hints, 16);
    ASSERT_EQ(n, 0);
    PASS();
}

TEST(store_extract_like_hints_short_segments) {
    char *hints[16];
    /* All segments < 3 chars — no hints */
    int n = ctx_extract_like_hints(".*ab.*cd.*", hints, 16);
    ASSERT_EQ(n, 0);
    PASS();
}

TEST(store_extract_like_hints_complex_multi_segment) {
    char *hints[16];
    /* .*Foo.*Bar.* should extract both */
    int n = ctx_extract_like_hints(".*Foo.*Bar.*", hints, 16);
    ASSERT_EQ(n, 2);
    ASSERT_STR_EQ(hints[0], "Foo");
    ASSERT_STR_EQ(hints[1], "Bar");
    free(hints[0]);
    free(hints[1]);
    PASS();
}

TEST(store_extract_like_hints_max_out_limit) {
    char *hints[2];
    /* More segments than max_out — should stop at max */
    int n = ctx_extract_like_hints(".*aaa.*bbb.*ccc.*ddd.*", hints, 2);
    ASSERT_EQ(n, 2);
    ASSERT_STR_EQ(hints[0], "aaa");
    ASSERT_STR_EQ(hints[1], "bbb");
    free(hints[0]);
    free(hints[1]);
    PASS();
}

TEST(store_extract_like_hints_escaped_chars) {
    char *hints[16];
    /* Backslash escaping: \. makes the dot literal, so it becomes part of the
     * accumulated literal string. ".handler" is the extracted hint. */
    int n = ctx_extract_like_hints("\\.handler", hints, 16);
    ASSERT_EQ(n, 1);
    ASSERT_STR_EQ(hints[0], ".handler");
    free(hints[0]);
    PASS();
}

/* ── Case helper edge cases ────────────────────────────────────── */

TEST(store_ensure_case_insensitive_null) {
    const char *result = ctx_ensure_case_insensitive(NULL);
    ASSERT_STR_EQ(result, "");
    PASS();
}

TEST(store_ensure_case_insensitive_already_ci) {
    /* Already case-insensitive — should NOT double-prefix */
    ASSERT_STR_EQ(ctx_ensure_case_insensitive("(?i).*Order.*"), "(?i).*Order.*");
    PASS();
}

TEST(store_ensure_case_insensitive_plain) {
    ASSERT_STR_EQ(ctx_ensure_case_insensitive("FooBar"), "(?i)FooBar");
    PASS();
}

TEST(store_strip_case_flag_null) {
    const char *result = ctx_strip_case_flag(NULL);
    ASSERT_STR_EQ(result, "");
    PASS();
}

TEST(store_strip_case_flag_no_flag) {
    ASSERT_STR_EQ(ctx_strip_case_flag("plain_pattern"), "plain_pattern");
    PASS();
}

TEST(store_strip_case_flag_empty) {
    ASSERT_STR_EQ(ctx_strip_case_flag(""), "");
    PASS();
}

/* ── Architecture helper edge cases ────────────────────────────── */

TEST(store_qn_to_package_single_segment) {
    /* No dots — returns empty string */
    ASSERT_STR_EQ(ctx_qn_to_package("nodots"), "");
    PASS();
}

TEST(store_qn_to_package_two_segments) {
    /* project.name — returns segment[1] */
    ASSERT_STR_EQ(ctx_qn_to_package("proj.name"), "name");
    PASS();
}

TEST(store_qn_to_package_many_segments) {
    /* project.dir.pkg.Func — 4+ segments returns segment[2] */
    ASSERT_STR_EQ(ctx_qn_to_package("myproj.dir.pkg.Func"), "pkg");
    PASS();
}

TEST(store_qn_to_package_null) {
    ASSERT_STR_EQ(ctx_qn_to_package(NULL), "");
    PASS();
}

TEST(store_qn_to_package_empty) {
    ASSERT_STR_EQ(ctx_qn_to_package(""), "");
    PASS();
}

TEST(store_qn_to_top_package_single_segment) {
    ASSERT_STR_EQ(ctx_qn_to_top_package("nodots"), "");
    PASS();
}

TEST(store_qn_to_top_package_two_segments) {
    /* project.dir — returns "dir" */
    ASSERT_STR_EQ(ctx_qn_to_top_package("proj.dir"), "dir");
    PASS();
}

TEST(store_qn_to_top_package_many_segments) {
    /* Always returns segment[1] regardless of depth */
    ASSERT_STR_EQ(ctx_qn_to_top_package("proj.dir.sub.Func"), "dir");
    PASS();
}

TEST(store_qn_to_top_package_null) {
    ASSERT_STR_EQ(ctx_qn_to_top_package(NULL), "");
    PASS();
}

TEST(store_is_test_file_various) {
    /* Positive cases */
    ASSERT_TRUE(ctx_is_test_file_path("test_handler.py"));
    ASSERT_TRUE(ctx_is_test_file_path("handler_test.go"));
    ASSERT_TRUE(ctx_is_test_file_path("handler.test.ts"));
    ASSERT_FALSE(ctx_is_test_file_path("handler.spec.ts")); /* "spec" not "test" — no match */
    ASSERT_TRUE(ctx_is_test_file_path("src/__tests__/handler.js"));
    ASSERT_TRUE(ctx_is_test_file_path("tests/unit/handler.py"));

    /* Negative cases */
    ASSERT_FALSE(ctx_is_test_file_path("handler.go"));
    ASSERT_FALSE(ctx_is_test_file_path("main.py"));
    ASSERT_FALSE(ctx_is_test_file_path("service.ts"));

    /* Edge: NULL and empty */
    ASSERT_FALSE(ctx_is_test_file_path(NULL));
    ASSERT_FALSE(ctx_is_test_file_path(""));
    PASS();
}

/* ── Risk/impact edge cases ────────────────────────────────────── */

TEST(store_hop_to_risk_all_levels) {
    /* hop 0 hits the default case → LOW */
    ASSERT_EQ(ctx_hop_to_risk(0), CTX_RISK_LOW);
    /* hop 1 → CRITICAL */
    ASSERT_EQ(ctx_hop_to_risk(1), CTX_RISK_CRITICAL);
    /* hop 2 → HIGH */
    ASSERT_EQ(ctx_hop_to_risk(2), CTX_RISK_HIGH);
    /* hop 3 → MEDIUM */
    ASSERT_EQ(ctx_hop_to_risk(3), CTX_RISK_MEDIUM);
    /* hop 4+ → LOW */
    ASSERT_EQ(ctx_hop_to_risk(4), CTX_RISK_LOW);
    ASSERT_EQ(ctx_hop_to_risk(100), CTX_RISK_LOW);
    /* negative → LOW (default) */
    ASSERT_EQ(ctx_hop_to_risk(-1), CTX_RISK_LOW);
    PASS();
}

TEST(store_risk_label_all_levels) {
    ASSERT_STR_EQ(ctx_risk_label(CTX_RISK_CRITICAL), "CRITICAL");
    ASSERT_STR_EQ(ctx_risk_label(CTX_RISK_HIGH), "HIGH");
    ASSERT_STR_EQ(ctx_risk_label(CTX_RISK_MEDIUM), "MEDIUM");
    ASSERT_STR_EQ(ctx_risk_label(CTX_RISK_LOW), "LOW");
    /* Out-of-range enum value falls to default → LOW */
    ASSERT_STR_EQ(ctx_risk_label((ctx_risk_level_t)99), "LOW");
    PASS();
}

TEST(store_impact_summary_empty) {
    /* Zero hops and edges */
    ctx_impact_summary_t s = ctx_build_impact_summary(NULL, 0, NULL, 0);
    ASSERT_EQ(s.total, 0);
    ASSERT_EQ(s.critical, 0);
    ASSERT_EQ(s.high, 0);
    ASSERT_EQ(s.medium, 0);
    ASSERT_EQ(s.low, 0);
    ASSERT_FALSE(s.has_cross_service);
    PASS();
}

SUITE(store_search) {
    RUN_TEST(store_search_by_label);
    RUN_TEST(store_search_by_name_pattern);
    RUN_TEST(store_search_by_file_pattern);
    RUN_TEST(store_search_pagination);
    RUN_TEST(store_search_degree_filter);
    RUN_TEST(store_search_all);
    RUN_TEST(store_search_exclude_labels);
    RUN_TEST(store_search_case_insensitive);
    RUN_TEST(store_bfs_outbound);
    RUN_TEST(store_bfs_inbound);
    RUN_TEST(store_bfs_cross_service);
    RUN_TEST(store_bfs_depth_chain);
    RUN_TEST(store_transaction_commit);
    RUN_TEST(store_transaction_rollback);
    RUN_TEST(store_bulk_write_mode);
    RUN_TEST(store_schema_info);
    RUN_TEST(store_dump_to_file);
    RUN_TEST(store_hop_to_risk);
    RUN_TEST(store_build_impact_summary);
    RUN_TEST(store_cross_service_detection);
    RUN_TEST(store_deduplicate_hops);
    RUN_TEST(store_bfs_with_risk_labels);
    RUN_TEST(store_bfs_cross_service_summary);
    RUN_TEST(store_glob_to_like);
    RUN_TEST(store_extract_like_hints);
    RUN_TEST(store_ensure_case_insensitive);
    RUN_TEST(store_strip_case_flag);
    RUN_TEST(store_batch_count_degrees);
    /* Edge case tests */
    RUN_TEST(store_glob_to_like_empty);
    RUN_TEST(store_glob_to_like_only_star);
    RUN_TEST(store_glob_to_like_consecutive_doublestar);
    RUN_TEST(store_glob_to_like_dot_and_brackets);
    RUN_TEST(store_glob_to_like_question_marks);
    RUN_TEST(store_extract_like_hints_null_out);
    RUN_TEST(store_extract_like_hints_zero_max);
    RUN_TEST(store_extract_like_hints_alternation_complex);
    RUN_TEST(store_extract_like_hints_short_segments);
    RUN_TEST(store_extract_like_hints_complex_multi_segment);
    RUN_TEST(store_extract_like_hints_max_out_limit);
    RUN_TEST(store_extract_like_hints_escaped_chars);
    RUN_TEST(store_ensure_case_insensitive_null);
    RUN_TEST(store_ensure_case_insensitive_already_ci);
    RUN_TEST(store_ensure_case_insensitive_plain);
    RUN_TEST(store_strip_case_flag_null);
    RUN_TEST(store_strip_case_flag_no_flag);
    RUN_TEST(store_strip_case_flag_empty);
    RUN_TEST(store_qn_to_package_single_segment);
    RUN_TEST(store_qn_to_package_two_segments);
    RUN_TEST(store_qn_to_package_many_segments);
    RUN_TEST(store_qn_to_package_null);
    RUN_TEST(store_qn_to_package_empty);
    RUN_TEST(store_qn_to_top_package_single_segment);
    RUN_TEST(store_qn_to_top_package_two_segments);
    RUN_TEST(store_qn_to_top_package_many_segments);
    RUN_TEST(store_qn_to_top_package_null);
    RUN_TEST(store_is_test_file_various);
    RUN_TEST(store_hop_to_risk_all_levels);
    RUN_TEST(store_risk_label_all_levels);
    RUN_TEST(store_impact_summary_empty);
}

/*
 * test_store_edges.c — Tests for edge CRUD operations.
 *
 * Ported from internal/store/store_test.go (TestEdgeCRUD, TestInsertEdgeBatch,
 * TestFindEdgesByURLPath, etc.)
 */
#include "test_framework.h"
#include <store/store.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

/* Helper: create a store with project + N nodes (A, B, C, ...) */
static ctx_store_t *setup_store_with_nodes(int n, int64_t *ids) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    char name[8], qn[32];
    for (int i = 0; i < n; i++) {
        snprintf(name, sizeof(name), "%c", 'A' + i);
        snprintf(qn, sizeof(qn), "test.%c", 'A' + i);
        ctx_node_t node = {
            .project = "test", .label = "Function", .name = name, .qualified_name = qn};
        ids[i] = ctx_store_upsert_node(s, &node);
    }
    return s;
}

/* ── Edge CRUD ──────────────────────────────────────────────────── */

TEST(store_edge_insert_find) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    /* Insert edge */
    ctx_edge_t e = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    int64_t eid = ctx_store_insert_edge(s, &e);
    ASSERT_GT(eid, 0);

    /* Find by source */
    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_source(s, ids[0], &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 1);
    ASSERT_STR_EQ(edges[0].type, "CALLS");
    ASSERT_EQ(edges[0].source_id, ids[0]);
    ASSERT_EQ(edges[0].target_id, ids[1]);
    ctx_store_free_edges(edges, count);

    /* Find by target */
    rc = ctx_store_find_edges_by_target(s, ids[1], &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 1);
    ctx_store_free_edges(edges, count);

    /* Count */
    int ecnt = ctx_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 1);

    ctx_store_close(s);
    PASS();
}

TEST(store_edge_dedup) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    /* Insert same edge twice — should not duplicate */
    ctx_edge_t e = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_store_insert_edge(s, &e);
    ctx_store_insert_edge(s, &e);

    int ecnt = ctx_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 1);

    ctx_store_close(s);
    PASS();
}

TEST(store_edge_find_by_source_type) {
    int64_t ids[3];
    ctx_store_t *s = setup_store_with_nodes(3, ids);

    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_edge_t e2 = {
        .project = "test", .source_id = ids[0], .target_id = ids[2], .type = "IMPORTS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);

    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_source_type(s, ids[0], "CALLS", &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 1);
    ASSERT_STR_EQ(edges[0].type, "CALLS");
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

TEST(store_edge_find_by_target_type) {
    int64_t ids[3];
    ctx_store_t *s = setup_store_with_nodes(3, ids);

    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[2], .type = "CALLS"};
    ctx_edge_t e2 = {
        .project = "test", .source_id = ids[1], .target_id = ids[2], .type = "IMPORTS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);

    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_target_type(s, ids[2], "CALLS", &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 1);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

TEST(store_edge_find_by_type) {
    int64_t ids[3];
    ctx_store_t *s = setup_store_with_nodes(3, ids);

    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_edge_t e2 = {.project = "test", .source_id = ids[1], .target_id = ids[2], .type = "CALLS"};
    ctx_edge_t e3 = {
        .project = "test", .source_id = ids[0], .target_id = ids[2], .type = "IMPORTS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);
    ctx_store_insert_edge(s, &e3);

    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_type(s, "test", "CALLS", &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 2);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

TEST(store_edge_count_by_type) {
    int64_t ids[3];
    ctx_store_t *s = setup_store_with_nodes(3, ids);

    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_edge_t e2 = {.project = "test", .source_id = ids[1], .target_id = ids[2], .type = "CALLS"};
    ctx_edge_t e3 = {
        .project = "test", .source_id = ids[0], .target_id = ids[2], .type = "IMPORTS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);
    ctx_store_insert_edge(s, &e3);

    int cnt = ctx_store_count_edges_by_type(s, "test", "CALLS");
    ASSERT_EQ(cnt, 2);

    cnt = ctx_store_count_edges_by_type(s, "test", "IMPORTS");
    ASSERT_EQ(cnt, 1);

    cnt = ctx_store_count_edges_by_type(s, "test", "NONEXISTENT");
    ASSERT_EQ(cnt, 0);

    ctx_store_close(s);
    PASS();
}

TEST(store_edge_delete_by_type) {
    int64_t ids[3];
    ctx_store_t *s = setup_store_with_nodes(3, ids);

    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_edge_t e2 = {
        .project = "test", .source_id = ids[0], .target_id = ids[2], .type = "IMPORTS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);

    ctx_store_delete_edges_by_type(s, "test", "CALLS");
    int ecnt = ctx_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 1);

    ctx_store_close(s);
    PASS();
}

/* ── Edge properties ────────────────────────────────────────────── */

TEST(store_edge_properties_json) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    ctx_edge_t e = {.project = "test",
                    .source_id = ids[0],
                    .target_id = ids[1],
                    .type = "HTTP_CALLS",
                    .properties_json = "{\"url_path\":\"/api/orders/create\",\"confidence\":0.8}"};
    ctx_store_insert_edge(s, &e);

    ctx_edge_t *edges = NULL;
    int count = 0;
    ctx_store_find_edges_by_source(s, ids[0], &edges, &count);
    ASSERT_EQ(count, 1);
    ASSERT_NOT_NULL(edges[0].properties_json);
    ASSERT(strstr(edges[0].properties_json, "url_path") != NULL);
    ASSERT(strstr(edges[0].properties_json, "/api/orders/create") != NULL);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

TEST(store_edge_null_properties) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    ctx_edge_t e = {.project = "test",
                    .source_id = ids[0],
                    .target_id = ids[1],
                    .type = "CALLS",
                    .properties_json = NULL};
    ctx_store_insert_edge(s, &e);

    ctx_edge_t *edges = NULL;
    int count = 0;
    ctx_store_find_edges_by_source(s, ids[0], &edges, &count);
    ASSERT_EQ(count, 1);
    ASSERT_NOT_NULL(edges[0].properties_json);
    ASSERT_STR_EQ(edges[0].properties_json, "{}");
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

/* ── Batch edge insert ──────────────────────────────────────────── */

TEST(store_edge_batch_insert) {
    int64_t ids[10];
    ctx_store_t *s = setup_store_with_nodes(10, ids);

    /* Create edges: each node calls the next */
    ctx_edge_t edges[9];
    for (int i = 0; i < 9; i++) {
        edges[i] = (ctx_edge_t){
            .project = "test", .source_id = ids[i], .target_id = ids[i + 1], .type = "CALLS"};
    }

    int rc = ctx_store_insert_edge_batch(s, edges, 9);
    ASSERT_EQ(rc, CTX_STORE_OK);

    int ecnt = ctx_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 9);

    /* Re-insert should not duplicate */
    rc = ctx_store_insert_edge_batch(s, edges, 9);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ecnt = ctx_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 9);

    ctx_store_close(s);
    PASS();
}

TEST(store_edge_batch_empty) {
    ctx_store_t *s = ctx_store_open_memory();
    int rc = ctx_store_insert_edge_batch(s, NULL, 0);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ctx_store_close(s);
    PASS();
}

/* ── Edge cascade on node delete ────────────────────────────────── */

TEST(store_edge_cascade_on_node_delete) {
    int64_t ids[3];
    ctx_store_t *s = setup_store_with_nodes(3, ids);

    /* A→B, A→C */
    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_edge_t e2 = {.project = "test", .source_id = ids[0], .target_id = ids[2], .type = "CALLS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);

    /* Delete node A — edges should cascade */
    ctx_store_delete_nodes_by_project(s, "test");
    int ecnt = ctx_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 0);

    ctx_store_close(s);
    PASS();
}

/* ── Batch insert with count=0 (non-NULL array) ────────────────── */

TEST(store_edge_batch_insert_zero_count) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_edge_t dummy = {.project = "test", .source_id = 1, .target_id = 2, .type = "CALLS"};
    int rc = ctx_store_insert_edge_batch(s, &dummy, 0);
    ASSERT_EQ(rc, CTX_STORE_OK);

    int ecnt = ctx_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 0);

    ctx_store_close(s);
    PASS();
}

/* ── Batch insert stress: 50 edges ─────────────────────────────── */

TEST(store_edge_batch_insert_50) {
    /* Create 51 nodes so we can have 50 A→B edges with distinct targets */
    int64_t ids[51];
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    for (int i = 0; i < 51; i++) {
        char name[8], qn[32];
        snprintf(name, sizeof(name), "N%d", i);
        snprintf(qn, sizeof(qn), "test.N%d", i);
        ctx_node_t node = {
            .project = "test", .label = "Function", .name = name, .qualified_name = qn};
        ids[i] = ctx_store_upsert_node(s, &node);
    }

    /* 50 edges: N0→N1, N1→N2, ..., N49→N50 */
    ctx_edge_t edges[50];
    for (int i = 0; i < 50; i++) {
        edges[i] = (ctx_edge_t){
            .project = "test", .source_id = ids[i], .target_id = ids[i + 1], .type = "CALLS"};
    }

    int rc = ctx_store_insert_edge_batch(s, edges, 50);
    ASSERT_EQ(rc, CTX_STORE_OK);

    int ecnt = ctx_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 50);

    ctx_store_close(s);
    PASS();
}

/* ── find_edges_by_source with non-existent source ─────────────── */

TEST(store_edge_find_source_nonexistent) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_source(s, 999999, &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 0);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

/* ── find_edges_by_target with non-existent target ─────────────── */

TEST(store_edge_find_target_nonexistent) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "test", "/tmp/test");

    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_target(s, 999999, &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 0);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

/* ── find_edges_by_type for non-existent type ──────────────────── */

TEST(store_edge_find_type_nonexistent) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    ctx_edge_t e = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_store_insert_edge(s, &e);

    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_type(s, "test", "DOES_NOT_EXIST", &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 0);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

/* ── count_edges on empty project ──────────────────────────────── */

TEST(store_edge_count_empty_project) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "empty", "/tmp/empty");

    int ecnt = ctx_store_count_edges(s, "empty");
    ASSERT_EQ(ecnt, 0);

    ctx_store_close(s);
    PASS();
}

/* ── count_edges_by_type for missing type ──────────────────────── */

TEST(store_edge_count_by_type_missing) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    ctx_edge_t e = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_store_insert_edge(s, &e);

    int cnt = ctx_store_count_edges_by_type(s, "test", "NEVER_EXISTS");
    ASSERT_EQ(cnt, 0);

    ctx_store_close(s);
    PASS();
}

/* ── delete_edges_by_type preserves other types ────────────────── */

TEST(store_edge_delete_by_type_preserves_others) {
    int64_t ids[3];
    ctx_store_t *s = setup_store_with_nodes(3, ids);

    ctx_edge_t e1 = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_edge_t e2 = {
        .project = "test", .source_id = ids[0], .target_id = ids[2], .type = "IMPORTS"};
    ctx_edge_t e3 = {
        .project = "test", .source_id = ids[1], .target_id = ids[2], .type = "HTTP_CALLS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);
    ctx_store_insert_edge(s, &e3);
    ASSERT_EQ(ctx_store_count_edges(s, "test"), 3);

    /* Delete only CALLS */
    ctx_store_delete_edges_by_type(s, "test", "CALLS");
    ASSERT_EQ(ctx_store_count_edges(s, "test"), 2);

    /* IMPORTS and HTTP_CALLS still exist */
    ASSERT_EQ(ctx_store_count_edges_by_type(s, "test", "IMPORTS"), 1);
    ASSERT_EQ(ctx_store_count_edges_by_type(s, "test", "HTTP_CALLS"), 1);
    ASSERT_EQ(ctx_store_count_edges_by_type(s, "test", "CALLS"), 0);

    ctx_store_close(s);
    PASS();
}

/* ── delete_edges_by_project preserves other projects ──────────── */

TEST(store_edge_delete_by_project_preserves_others) {
    ctx_store_t *s = ctx_store_open_memory();
    ctx_store_upsert_project(s, "alpha", "/tmp/alpha");
    ctx_store_upsert_project(s, "beta", "/tmp/beta");

    /* Create nodes in both projects */
    ctx_node_t na = {
        .project = "alpha", .label = "Function", .name = "A", .qualified_name = "alpha.A"};
    ctx_node_t nb = {
        .project = "alpha", .label = "Function", .name = "B", .qualified_name = "alpha.B"};
    ctx_node_t nc = {
        .project = "beta", .label = "Function", .name = "C", .qualified_name = "beta.C"};
    ctx_node_t nd = {
        .project = "beta", .label = "Function", .name = "D", .qualified_name = "beta.D"};
    int64_t idA = ctx_store_upsert_node(s, &na);
    int64_t idB = ctx_store_upsert_node(s, &nb);
    int64_t idC = ctx_store_upsert_node(s, &nc);
    int64_t idD = ctx_store_upsert_node(s, &nd);

    ctx_edge_t e1 = {
        .project = "alpha", .source_id = idA, .target_id = idB, .type = "CALLS"};
    ctx_edge_t e2 = {
        .project = "beta", .source_id = idC, .target_id = idD, .type = "CALLS"};
    ctx_store_insert_edge(s, &e1);
    ctx_store_insert_edge(s, &e2);

    ASSERT_EQ(ctx_store_count_edges(s, "alpha"), 1);
    ASSERT_EQ(ctx_store_count_edges(s, "beta"), 1);

    /* Delete alpha edges only */
    ctx_store_delete_edges_by_project(s, "alpha");
    ASSERT_EQ(ctx_store_count_edges(s, "alpha"), 0);
    ASSERT_EQ(ctx_store_count_edges(s, "beta"), 1);

    ctx_store_close(s);
    PASS();
}

/* ── Edge with special chars in properties_json ────────────────── */

TEST(store_edge_properties_special_chars) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    /* JSON with unicode, quotes, backslashes */
    const char *json = "{\"desc\":\"line1\\nline2\",\"path\":\"/api/v1/users?q=foo&bar=baz\","
                       "\"emoji\":\"\\u2603\"}";
    ctx_edge_t e = {.project = "test",
                    .source_id = ids[0],
                    .target_id = ids[1],
                    .type = "HTTP_CALLS",
                    .properties_json = json};
    ctx_store_insert_edge(s, &e);

    ctx_edge_t *edges = NULL;
    int count = 0;
    ctx_store_find_edges_by_source(s, ids[0], &edges, &count);
    ASSERT_EQ(count, 1);
    ASSERT_NOT_NULL(edges[0].properties_json);
    /* Round-trip should preserve the JSON string */
    ASSERT(strstr(edges[0].properties_json, "line1\\nline2") != NULL);
    ASSERT(strstr(edges[0].properties_json, "/api/v1/users") != NULL);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

/* ── Edge with very long type string ───────────────────────────── */

TEST(store_edge_long_type_string) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    /* 200-char type string */
    char long_type[201];
    memset(long_type, 'X', 200);
    long_type[200] = '\0';

    ctx_edge_t e = {.project = "test",
                    .source_id = ids[0],
                    .target_id = ids[1],
                    .type = long_type};
    int64_t eid = ctx_store_insert_edge(s, &e);
    ASSERT_GT(eid, 0);

    /* Verify it round-trips */
    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_source(s, ids[0], &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 1);
    ASSERT_STR_EQ(edges[0].type, long_type);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

/* ── find_edges_by_source_type with non-existent type ──────────── */

TEST(store_edge_find_source_type_nonexistent) {
    int64_t ids[2];
    ctx_store_t *s = setup_store_with_nodes(2, ids);

    ctx_edge_t e = {.project = "test", .source_id = ids[0], .target_id = ids[1], .type = "CALLS"};
    ctx_store_insert_edge(s, &e);

    ctx_edge_t *edges = NULL;
    int count = 0;
    int rc = ctx_store_find_edges_by_source_type(s, ids[0], "NOPE", &edges, &count);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_EQ(count, 0);
    ctx_store_free_edges(edges, count);

    ctx_store_close(s);
    PASS();
}

SUITE(store_edges) {
    RUN_TEST(store_edge_insert_find);
    RUN_TEST(store_edge_dedup);
    RUN_TEST(store_edge_find_by_source_type);
    RUN_TEST(store_edge_find_by_target_type);
    RUN_TEST(store_edge_find_by_type);
    RUN_TEST(store_edge_count_by_type);
    RUN_TEST(store_edge_delete_by_type);
    RUN_TEST(store_edge_properties_json);
    RUN_TEST(store_edge_null_properties);
    RUN_TEST(store_edge_batch_insert);
    RUN_TEST(store_edge_batch_empty);
    RUN_TEST(store_edge_cascade_on_node_delete);
    /* Edge case tests */
    RUN_TEST(store_edge_batch_insert_zero_count);
    RUN_TEST(store_edge_batch_insert_50);
    RUN_TEST(store_edge_find_source_nonexistent);
    RUN_TEST(store_edge_find_target_nonexistent);
    RUN_TEST(store_edge_find_type_nonexistent);
    RUN_TEST(store_edge_count_empty_project);
    RUN_TEST(store_edge_count_by_type_missing);
    RUN_TEST(store_edge_delete_by_type_preserves_others);
    RUN_TEST(store_edge_delete_by_project_preserves_others);
    RUN_TEST(store_edge_properties_special_chars);
    RUN_TEST(store_edge_long_type_string);
    RUN_TEST(store_edge_find_source_type_nonexistent);
}

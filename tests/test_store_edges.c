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
static cbm_store_t* setup_store_with_nodes(int n, int64_t* ids) {
    cbm_store_t* s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "test", "/tmp/test");

    char name[8], qn[32];
    for (int i = 0; i < n; i++) {
        snprintf(name, sizeof(name), "%c", 'A' + i);
        snprintf(qn, sizeof(qn), "test.%c", 'A' + i);
        cbm_node_t node = {
            .project = "test", .label = "Function",
            .name = name, .qualified_name = qn
        };
        ids[i] = cbm_store_upsert_node(s, &node);
    }
    return s;
}

/* ── Edge CRUD ──────────────────────────────────────────────────── */

TEST(store_edge_insert_find) {
    int64_t ids[2];
    cbm_store_t* s = setup_store_with_nodes(2, ids);

    /* Insert edge */
    cbm_edge_t e = {.project="test", .source_id=ids[0], .target_id=ids[1], .type="CALLS"};
    int64_t eid = cbm_store_insert_edge(s, &e);
    ASSERT_GT(eid, 0);

    /* Find by source */
    cbm_edge_t* edges = NULL;
    int count = 0;
    int rc = cbm_store_find_edges_by_source(s, ids[0], &edges, &count);
    ASSERT_EQ(rc, CBM_STORE_OK);
    ASSERT_EQ(count, 1);
    ASSERT_STR_EQ(edges[0].type, "CALLS");
    ASSERT_EQ(edges[0].source_id, ids[0]);
    ASSERT_EQ(edges[0].target_id, ids[1]);
    cbm_store_free_edges(edges, count);

    /* Find by target */
    rc = cbm_store_find_edges_by_target(s, ids[1], &edges, &count);
    ASSERT_EQ(rc, CBM_STORE_OK);
    ASSERT_EQ(count, 1);
    cbm_store_free_edges(edges, count);

    /* Count */
    int ecnt = cbm_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 1);

    cbm_store_close(s);
    PASS();
}

TEST(store_edge_dedup) {
    int64_t ids[2];
    cbm_store_t* s = setup_store_with_nodes(2, ids);

    /* Insert same edge twice — should not duplicate */
    cbm_edge_t e = {.project="test", .source_id=ids[0], .target_id=ids[1], .type="CALLS"};
    cbm_store_insert_edge(s, &e);
    cbm_store_insert_edge(s, &e);

    int ecnt = cbm_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 1);

    cbm_store_close(s);
    PASS();
}

TEST(store_edge_find_by_source_type) {
    int64_t ids[3];
    cbm_store_t* s = setup_store_with_nodes(3, ids);

    cbm_edge_t e1 = {.project="test", .source_id=ids[0], .target_id=ids[1], .type="CALLS"};
    cbm_edge_t e2 = {.project="test", .source_id=ids[0], .target_id=ids[2], .type="IMPORTS"};
    cbm_store_insert_edge(s, &e1);
    cbm_store_insert_edge(s, &e2);

    cbm_edge_t* edges = NULL;
    int count = 0;
    int rc = cbm_store_find_edges_by_source_type(s, ids[0], "CALLS", &edges, &count);
    ASSERT_EQ(rc, CBM_STORE_OK);
    ASSERT_EQ(count, 1);
    ASSERT_STR_EQ(edges[0].type, "CALLS");
    cbm_store_free_edges(edges, count);

    cbm_store_close(s);
    PASS();
}

TEST(store_edge_find_by_target_type) {
    int64_t ids[3];
    cbm_store_t* s = setup_store_with_nodes(3, ids);

    cbm_edge_t e1 = {.project="test", .source_id=ids[0], .target_id=ids[2], .type="CALLS"};
    cbm_edge_t e2 = {.project="test", .source_id=ids[1], .target_id=ids[2], .type="IMPORTS"};
    cbm_store_insert_edge(s, &e1);
    cbm_store_insert_edge(s, &e2);

    cbm_edge_t* edges = NULL;
    int count = 0;
    int rc = cbm_store_find_edges_by_target_type(s, ids[2], "CALLS", &edges, &count);
    ASSERT_EQ(rc, CBM_STORE_OK);
    ASSERT_EQ(count, 1);
    cbm_store_free_edges(edges, count);

    cbm_store_close(s);
    PASS();
}

TEST(store_edge_find_by_type) {
    int64_t ids[3];
    cbm_store_t* s = setup_store_with_nodes(3, ids);

    cbm_edge_t e1 = {.project="test", .source_id=ids[0], .target_id=ids[1], .type="CALLS"};
    cbm_edge_t e2 = {.project="test", .source_id=ids[1], .target_id=ids[2], .type="CALLS"};
    cbm_edge_t e3 = {.project="test", .source_id=ids[0], .target_id=ids[2], .type="IMPORTS"};
    cbm_store_insert_edge(s, &e1);
    cbm_store_insert_edge(s, &e2);
    cbm_store_insert_edge(s, &e3);

    cbm_edge_t* edges = NULL;
    int count = 0;
    int rc = cbm_store_find_edges_by_type(s, "test", "CALLS", &edges, &count);
    ASSERT_EQ(rc, CBM_STORE_OK);
    ASSERT_EQ(count, 2);
    cbm_store_free_edges(edges, count);

    cbm_store_close(s);
    PASS();
}

TEST(store_edge_count_by_type) {
    int64_t ids[3];
    cbm_store_t* s = setup_store_with_nodes(3, ids);

    cbm_edge_t e1 = {.project="test", .source_id=ids[0], .target_id=ids[1], .type="CALLS"};
    cbm_edge_t e2 = {.project="test", .source_id=ids[1], .target_id=ids[2], .type="CALLS"};
    cbm_edge_t e3 = {.project="test", .source_id=ids[0], .target_id=ids[2], .type="IMPORTS"};
    cbm_store_insert_edge(s, &e1);
    cbm_store_insert_edge(s, &e2);
    cbm_store_insert_edge(s, &e3);

    int cnt = cbm_store_count_edges_by_type(s, "test", "CALLS");
    ASSERT_EQ(cnt, 2);

    cnt = cbm_store_count_edges_by_type(s, "test", "IMPORTS");
    ASSERT_EQ(cnt, 1);

    cnt = cbm_store_count_edges_by_type(s, "test", "NONEXISTENT");
    ASSERT_EQ(cnt, 0);

    cbm_store_close(s);
    PASS();
}

TEST(store_edge_delete_by_type) {
    int64_t ids[3];
    cbm_store_t* s = setup_store_with_nodes(3, ids);

    cbm_edge_t e1 = {.project="test", .source_id=ids[0], .target_id=ids[1], .type="CALLS"};
    cbm_edge_t e2 = {.project="test", .source_id=ids[0], .target_id=ids[2], .type="IMPORTS"};
    cbm_store_insert_edge(s, &e1);
    cbm_store_insert_edge(s, &e2);

    cbm_store_delete_edges_by_type(s, "test", "CALLS");
    int ecnt = cbm_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 1);

    cbm_store_close(s);
    PASS();
}

/* ── Edge properties ────────────────────────────────────────────── */

TEST(store_edge_properties_json) {
    int64_t ids[2];
    cbm_store_t* s = setup_store_with_nodes(2, ids);

    cbm_edge_t e = {
        .project = "test", .source_id = ids[0], .target_id = ids[1],
        .type = "HTTP_CALLS",
        .properties_json = "{\"url_path\":\"/api/orders/create\",\"confidence\":0.8}"
    };
    cbm_store_insert_edge(s, &e);

    cbm_edge_t* edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_source(s, ids[0], &edges, &count);
    ASSERT_EQ(count, 1);
    ASSERT_NOT_NULL(edges[0].properties_json);
    ASSERT(strstr(edges[0].properties_json, "url_path") != NULL);
    ASSERT(strstr(edges[0].properties_json, "/api/orders/create") != NULL);
    cbm_store_free_edges(edges, count);

    cbm_store_close(s);
    PASS();
}

TEST(store_edge_null_properties) {
    int64_t ids[2];
    cbm_store_t* s = setup_store_with_nodes(2, ids);

    cbm_edge_t e = {
        .project = "test", .source_id = ids[0], .target_id = ids[1],
        .type = "CALLS", .properties_json = NULL
    };
    cbm_store_insert_edge(s, &e);

    cbm_edge_t* edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_source(s, ids[0], &edges, &count);
    ASSERT_EQ(count, 1);
    ASSERT_NOT_NULL(edges[0].properties_json);
    ASSERT_STR_EQ(edges[0].properties_json, "{}");
    cbm_store_free_edges(edges, count);

    cbm_store_close(s);
    PASS();
}

/* ── Batch edge insert ──────────────────────────────────────────── */

TEST(store_edge_batch_insert) {
    int64_t ids[10];
    cbm_store_t* s = setup_store_with_nodes(10, ids);

    /* Create edges: each node calls the next */
    cbm_edge_t edges[9];
    for (int i = 0; i < 9; i++) {
        edges[i] = (cbm_edge_t){
            .project = "test", .source_id = ids[i], .target_id = ids[i+1],
            .type = "CALLS"
        };
    }

    int rc = cbm_store_insert_edge_batch(s, edges, 9);
    ASSERT_EQ(rc, CBM_STORE_OK);

    int ecnt = cbm_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 9);

    /* Re-insert should not duplicate */
    rc = cbm_store_insert_edge_batch(s, edges, 9);
    ASSERT_EQ(rc, CBM_STORE_OK);
    ecnt = cbm_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 9);

    cbm_store_close(s);
    PASS();
}

TEST(store_edge_batch_empty) {
    cbm_store_t* s = cbm_store_open_memory();
    int rc = cbm_store_insert_edge_batch(s, NULL, 0);
    ASSERT_EQ(rc, CBM_STORE_OK);
    cbm_store_close(s);
    PASS();
}

/* ── Edge cascade on node delete ────────────────────────────────── */

TEST(store_edge_cascade_on_node_delete) {
    int64_t ids[3];
    cbm_store_t* s = setup_store_with_nodes(3, ids);

    /* A→B, A→C */
    cbm_edge_t e1 = {.project="test", .source_id=ids[0], .target_id=ids[1], .type="CALLS"};
    cbm_edge_t e2 = {.project="test", .source_id=ids[0], .target_id=ids[2], .type="CALLS"};
    cbm_store_insert_edge(s, &e1);
    cbm_store_insert_edge(s, &e2);

    /* Delete node A — edges should cascade */
    cbm_store_delete_nodes_by_project(s, "test");
    int ecnt = cbm_store_count_edges(s, "test");
    ASSERT_EQ(ecnt, 0);

    cbm_store_close(s);
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
}

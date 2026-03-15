/*
 * test_graph_buffer.c — Tests for in-memory graph buffer.
 *
 * RED phase: Tests define expected behavior for node/edge insertion,
 * lookup, dedup, delete, and dump to SQLite.
 */
#include "test_framework.h"
#include "graph_buffer/graph_buffer.h"
#include "store/store.h"

/* ── Node operations ───────────────────────────────────────────── */

TEST(gbuf_create_free) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test-proj", "/tmp/repo");
    ASSERT_NOT_NULL(gb);
    ASSERT_EQ(cbm_gbuf_node_count(gb), 0);
    ASSERT_EQ(cbm_gbuf_edge_count(gb), 0);
    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_free_null) {
    cbm_gbuf_free(NULL); /* should not crash */
    PASS();
}

TEST(gbuf_upsert_node) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t id = cbm_gbuf_upsert_node(gb, "Function", "main", "pkg.main", "main.go", 1, 10, "{}");
    ASSERT_GT(id, 0);
    ASSERT_EQ(cbm_gbuf_node_count(gb), 1);

    const cbm_gbuf_node_t *n = cbm_gbuf_find_by_qn(gb, "pkg.main");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->label, "Function");
    ASSERT_STR_EQ(n->name, "main");
    ASSERT_STR_EQ(n->qualified_name, "pkg.main");
    ASSERT_STR_EQ(n->file_path, "main.go");
    ASSERT_EQ(n->start_line, 1);
    ASSERT_EQ(n->end_line, 10);
    ASSERT_EQ(n->id, id);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_upsert_updates) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t id1 = cbm_gbuf_upsert_node(gb, "Function", "main", "pkg.main", "main.go", 1, 10, "{}");
    /* Upsert same QN with different fields */
    int64_t id2 = cbm_gbuf_upsert_node(gb, "Method", "main", "pkg.main", "main.go", 5, 20,
                                       "{\"key\":\"val\"}");
    ASSERT_EQ(id1, id2);                   /* same temp ID */
    ASSERT_EQ(cbm_gbuf_node_count(gb), 1); /* still one node */

    const cbm_gbuf_node_t *n = cbm_gbuf_find_by_qn(gb, "pkg.main");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->label, "Method"); /* updated */
    ASSERT_EQ(n->end_line, 20);        /* updated */

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_id) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t id = cbm_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "foo.go", 1, 5, "{}");

    const cbm_gbuf_node_t *n = cbm_gbuf_find_by_id(gb, id);
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->name, "foo");

    /* Not found */
    ASSERT_NULL(cbm_gbuf_find_by_id(gb, 999));

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_label) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    cbm_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");
    cbm_gbuf_upsert_node(gb, "Function", "bar", "pkg.bar", "f.go", 6, 10, "{}");
    cbm_gbuf_upsert_node(gb, "Class", "Baz", "pkg.Baz", "f.go", 11, 20, "{}");

    const cbm_gbuf_node_t **nodes = NULL;
    int count = 0;
    int rc = cbm_gbuf_find_by_label(gb, "Function", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 2);

    rc = cbm_gbuf_find_by_label(gb, "Class", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 1);

    rc = cbm_gbuf_find_by_label(gb, "Module", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 0);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_name) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    cbm_gbuf_upsert_node(gb, "Function", "main", "a.main", "a.go", 1, 5, "{}");
    cbm_gbuf_upsert_node(gb, "Function", "main", "b.main", "b.go", 1, 5, "{}");

    const cbm_gbuf_node_t **nodes = NULL;
    int count = 0;
    int rc = cbm_gbuf_find_by_name(gb, "main", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 2);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_delete_by_label) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t f1 = cbm_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");
    int64_t f2 = cbm_gbuf_upsert_node(gb, "Function", "bar", "pkg.bar", "f.go", 6, 10, "{}");
    cbm_gbuf_upsert_node(gb, "Class", "Baz", "pkg.Baz", "f.go", 11, 20, "{}");

    /* Add edge between functions */
    cbm_gbuf_insert_edge(gb, f1, f2, "CALLS", "{}");
    ASSERT_EQ(cbm_gbuf_edge_count(gb), 1);

    /* Delete all functions — should cascade-delete the CALLS edge */
    cbm_gbuf_delete_by_label(gb, "Function");
    ASSERT_EQ(cbm_gbuf_node_count(gb), 1); /* only Class remains */
    ASSERT_EQ(cbm_gbuf_edge_count(gb), 0); /* edge cascade-deleted */

    ASSERT_NULL(cbm_gbuf_find_by_qn(gb, "pkg.foo"));
    ASSERT_NULL(cbm_gbuf_find_by_qn(gb, "pkg.bar"));
    ASSERT_NOT_NULL(cbm_gbuf_find_by_qn(gb, "pkg.Baz"));

    cbm_gbuf_free(gb);
    PASS();
}

/* ── Edge operations ───────────────────────────────────────────── */

TEST(gbuf_insert_edge) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t n1 = cbm_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t n2 = cbm_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    int64_t eid = cbm_gbuf_insert_edge(gb, n1, n2, "CALLS", "{}");
    ASSERT_GT(eid, 0);
    ASSERT_EQ(cbm_gbuf_edge_count(gb), 1);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_edge_dedup) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t n1 = cbm_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t n2 = cbm_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    int64_t eid1 = cbm_gbuf_insert_edge(gb, n1, n2, "CALLS", "{}");
    int64_t eid2 = cbm_gbuf_insert_edge(gb, n1, n2, "CALLS", "{\"weight\":5}");
    ASSERT_EQ(eid1, eid2); /* same edge, deduped */
    ASSERT_EQ(cbm_gbuf_edge_count(gb), 1);

    /* Different type = different edge */
    int64_t eid3 = cbm_gbuf_insert_edge(gb, n1, n2, "IMPORTS", "{}");
    ASSERT_NEQ(eid1, eid3);
    ASSERT_EQ(cbm_gbuf_edge_count(gb), 2);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_edges_by_source_type) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t a = cbm_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = cbm_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    int64_t c = cbm_gbuf_upsert_node(gb, "Function", "c", "pkg.c", "f.go", 11, 15, "{}");

    cbm_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    cbm_gbuf_insert_edge(gb, a, c, "CALLS", "{}");
    cbm_gbuf_insert_edge(gb, a, b, "IMPORTS", "{}");

    const cbm_gbuf_edge_t **edges = NULL;
    int count = 0;
    cbm_gbuf_find_edges_by_source_type(gb, a, "CALLS", &edges, &count);
    ASSERT_EQ(count, 2);

    cbm_gbuf_find_edges_by_source_type(gb, a, "IMPORTS", &edges, &count);
    ASSERT_EQ(count, 1);

    cbm_gbuf_find_edges_by_source_type(gb, b, "CALLS", &edges, &count);
    ASSERT_EQ(count, 0);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_edges_by_target_type) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t a = cbm_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = cbm_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    cbm_gbuf_insert_edge(gb, a, b, "CALLS", "{}");

    const cbm_gbuf_edge_t **edges = NULL;
    int count = 0;
    cbm_gbuf_find_edges_by_target_type(gb, b, "CALLS", &edges, &count);
    ASSERT_EQ(count, 1);

    cbm_gbuf_find_edges_by_target_type(gb, a, "CALLS", &edges, &count);
    ASSERT_EQ(count, 0);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_edges_by_type) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t a = cbm_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = cbm_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    cbm_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    cbm_gbuf_insert_edge(gb, b, a, "CALLS", "{}");

    const cbm_gbuf_edge_t **edges = NULL;
    int count = 0;
    cbm_gbuf_find_edges_by_type(gb, "CALLS", &edges, &count);
    ASSERT_EQ(count, 2);

    cbm_gbuf_find_edges_by_type(gb, "IMPORTS", &edges, &count);
    ASSERT_EQ(count, 0);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_delete_edges_by_type) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t a = cbm_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = cbm_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    cbm_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    cbm_gbuf_insert_edge(gb, a, b, "IMPORTS", "{}");
    ASSERT_EQ(cbm_gbuf_edge_count(gb), 2);

    cbm_gbuf_delete_edges_by_type(gb, "CALLS");
    ASSERT_EQ(cbm_gbuf_edge_count(gb), 1);
    ASSERT_EQ(cbm_gbuf_edge_count_by_type(gb, "CALLS"), 0);
    ASSERT_EQ(cbm_gbuf_edge_count_by_type(gb, "IMPORTS"), 1);

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_edge_count_by_type) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");
    int64_t a = cbm_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = cbm_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    int64_t c = cbm_gbuf_upsert_node(gb, "Function", "c", "pkg.c", "f.go", 11, 15, "{}");

    cbm_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    cbm_gbuf_insert_edge(gb, a, c, "CALLS", "{}");
    cbm_gbuf_insert_edge(gb, b, c, "IMPORTS", "{}");

    ASSERT_EQ(cbm_gbuf_edge_count_by_type(gb, "CALLS"), 2);
    ASSERT_EQ(cbm_gbuf_edge_count_by_type(gb, "IMPORTS"), 1);
    ASSERT_EQ(cbm_gbuf_edge_count_by_type(gb, "HTTP_CALLS"), 0);

    cbm_gbuf_free(gb);
    PASS();
}

/* ── Dump to SQLite ────────────────────────────────────────────── */

TEST(gbuf_dump_empty) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");

    /* Dump empty buffer should succeed */
    int rc = cbm_gbuf_flush_to_store(gb, NULL);
    /* NULL store should be handled gracefully — we just skip */
    (void)rc;

    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_flush_to_store) {
    /* Create a buffer with some data */
    cbm_gbuf_t *gb = cbm_gbuf_new("test-proj", "/tmp/repo");
    int64_t n1 = cbm_gbuf_upsert_node(gb, "Function", "main", "test-proj::main.go::main", "main.go",
                                      1, 10, "{}");
    int64_t n2 = cbm_gbuf_upsert_node(gb, "Function", "helper", "test-proj::helper.go::helper",
                                      "helper.go", 1, 5, "{}");
    cbm_gbuf_insert_edge(gb, n1, n2, "CALLS", "{}");

    /* Open an in-memory store and flush */
    cbm_store_t *store = cbm_store_open_memory();
    ASSERT_NOT_NULL(store);

    int rc = cbm_gbuf_flush_to_store(gb, store);
    ASSERT_EQ(rc, 0);

    /* Verify data landed in store */
    int node_count = cbm_store_count_nodes(store, "test-proj");
    ASSERT_EQ(node_count, 2);

    int edge_count = cbm_store_count_edges(store, "test-proj");
    ASSERT_EQ(edge_count, 1);

    cbm_store_close(store);
    cbm_gbuf_free(gb);
    PASS();
}

TEST(gbuf_many_nodes) {
    cbm_gbuf_t *gb = cbm_gbuf_new("test", "/tmp");

    /* Insert 1000 nodes */
    for (int i = 0; i < 1000; i++) {
        char name[32], qn[64];
        snprintf(name, sizeof(name), "func_%d", i);
        snprintf(qn, sizeof(qn), "pkg.func_%d", i);
        int64_t id = cbm_gbuf_upsert_node(gb, "Function", name, qn, "f.go", i, i + 5, "{}");
        ASSERT_GT(id, 0);
    }
    ASSERT_EQ(cbm_gbuf_node_count(gb), 1000);

    /* Verify lookup */
    const cbm_gbuf_node_t *n = cbm_gbuf_find_by_qn(gb, "pkg.func_500");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->name, "func_500");

    cbm_gbuf_free(gb);
    PASS();
}

/* ── Suite ─────────────────────────────────────────────────────── */

SUITE(graph_buffer) {
    RUN_TEST(gbuf_create_free);
    RUN_TEST(gbuf_free_null);
    RUN_TEST(gbuf_upsert_node);
    RUN_TEST(gbuf_upsert_updates);
    RUN_TEST(gbuf_find_by_id);
    RUN_TEST(gbuf_find_by_label);
    RUN_TEST(gbuf_find_by_name);
    RUN_TEST(gbuf_delete_by_label);
    RUN_TEST(gbuf_insert_edge);
    RUN_TEST(gbuf_edge_dedup);
    RUN_TEST(gbuf_find_edges_by_source_type);
    RUN_TEST(gbuf_find_edges_by_target_type);
    RUN_TEST(gbuf_find_edges_by_type);
    RUN_TEST(gbuf_delete_edges_by_type);
    RUN_TEST(gbuf_edge_count_by_type);
    RUN_TEST(gbuf_dump_empty);
    RUN_TEST(gbuf_flush_to_store);
    RUN_TEST(gbuf_many_nodes);
}

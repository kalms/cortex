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
    ctx_gbuf_t *gb = ctx_gbuf_new("test-proj", "/tmp/repo");
    ASSERT_NOT_NULL(gb);
    ASSERT_EQ(ctx_gbuf_node_count(gb), 0);
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 0);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_free_null) {
    ctx_gbuf_free(NULL); /* should not crash */
    PASS();
}

TEST(gbuf_upsert_node) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t id = ctx_gbuf_upsert_node(gb, "Function", "main", "pkg.main", "main.go", 1, 10, "{}");
    ASSERT_GT(id, 0);
    ASSERT_EQ(ctx_gbuf_node_count(gb), 1);

    const ctx_gbuf_node_t *n = ctx_gbuf_find_by_qn(gb, "pkg.main");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->label, "Function");
    ASSERT_STR_EQ(n->name, "main");
    ASSERT_STR_EQ(n->qualified_name, "pkg.main");
    ASSERT_STR_EQ(n->file_path, "main.go");
    ASSERT_EQ(n->start_line, 1);
    ASSERT_EQ(n->end_line, 10);
    ASSERT_EQ(n->id, id);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_upsert_updates) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t id1 = ctx_gbuf_upsert_node(gb, "Function", "main", "pkg.main", "main.go", 1, 10, "{}");
    /* Upsert same QN with different fields */
    int64_t id2 = ctx_gbuf_upsert_node(gb, "Method", "main", "pkg.main", "main.go", 5, 20,
                                       "{\"key\":\"val\"}");
    ASSERT_EQ(id1, id2);                   /* same temp ID */
    ASSERT_EQ(ctx_gbuf_node_count(gb), 1); /* still one node */

    const ctx_gbuf_node_t *n = ctx_gbuf_find_by_qn(gb, "pkg.main");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->label, "Method"); /* updated */
    ASSERT_EQ(n->end_line, 20);        /* updated */

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_id) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t id = ctx_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "foo.go", 1, 5, "{}");

    const ctx_gbuf_node_t *n = ctx_gbuf_find_by_id(gb, id);
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->name, "foo");

    /* Not found */
    ASSERT_NULL(ctx_gbuf_find_by_id(gb, 999));

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_label) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(gb, "Function", "bar", "pkg.bar", "f.go", 6, 10, "{}");
    ctx_gbuf_upsert_node(gb, "Class", "Baz", "pkg.Baz", "f.go", 11, 20, "{}");

    const ctx_gbuf_node_t **nodes = NULL;
    int count = 0;
    int rc = ctx_gbuf_find_by_label(gb, "Function", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 2);

    rc = ctx_gbuf_find_by_label(gb, "Class", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 1);

    rc = ctx_gbuf_find_by_label(gb, "Module", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 0);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_name) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_upsert_node(gb, "Function", "main", "a.main", "a.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(gb, "Function", "main", "b.main", "b.go", 1, 5, "{}");

    const ctx_gbuf_node_t **nodes = NULL;
    int count = 0;
    int rc = ctx_gbuf_find_by_name(gb, "main", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 2);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_delete_by_label) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t f1 = ctx_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");
    int64_t f2 = ctx_gbuf_upsert_node(gb, "Function", "bar", "pkg.bar", "f.go", 6, 10, "{}");
    ctx_gbuf_upsert_node(gb, "Class", "Baz", "pkg.Baz", "f.go", 11, 20, "{}");

    /* Add edge between functions */
    ctx_gbuf_insert_edge(gb, f1, f2, "CALLS", "{}");
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 1);

    /* Delete all functions — should cascade-delete the CALLS edge */
    ctx_gbuf_delete_by_label(gb, "Function");
    ASSERT_EQ(ctx_gbuf_node_count(gb), 1); /* only Class remains */
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 0); /* edge cascade-deleted */

    ASSERT_NULL(ctx_gbuf_find_by_qn(gb, "pkg.foo"));
    ASSERT_NULL(ctx_gbuf_find_by_qn(gb, "pkg.bar"));
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(gb, "pkg.Baz"));

    ctx_gbuf_free(gb);
    PASS();
}

/* ── Edge operations ───────────────────────────────────────────── */

TEST(gbuf_insert_edge) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t n1 = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t n2 = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    int64_t eid = ctx_gbuf_insert_edge(gb, n1, n2, "CALLS", "{}");
    ASSERT_GT(eid, 0);
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 1);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_edge_dedup) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t n1 = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t n2 = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    int64_t eid1 = ctx_gbuf_insert_edge(gb, n1, n2, "CALLS", "{}");
    int64_t eid2 = ctx_gbuf_insert_edge(gb, n1, n2, "CALLS", "{\"weight\":5}");
    ASSERT_EQ(eid1, eid2); /* same edge, deduped */
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 1);

    /* Different type = different edge */
    int64_t eid3 = ctx_gbuf_insert_edge(gb, n1, n2, "IMPORTS", "{}");
    ASSERT_NEQ(eid1, eid3);
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 2);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_edges_by_source_type) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t a = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    int64_t c = ctx_gbuf_upsert_node(gb, "Function", "c", "pkg.c", "f.go", 11, 15, "{}");

    ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, a, c, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, a, b, "IMPORTS", "{}");

    const ctx_gbuf_edge_t **edges = NULL;
    int count = 0;
    ctx_gbuf_find_edges_by_source_type(gb, a, "CALLS", &edges, &count);
    ASSERT_EQ(count, 2);

    ctx_gbuf_find_edges_by_source_type(gb, a, "IMPORTS", &edges, &count);
    ASSERT_EQ(count, 1);

    ctx_gbuf_find_edges_by_source_type(gb, b, "CALLS", &edges, &count);
    ASSERT_EQ(count, 0);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_edges_by_target_type) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t a = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{}");

    const ctx_gbuf_edge_t **edges = NULL;
    int count = 0;
    ctx_gbuf_find_edges_by_target_type(gb, b, "CALLS", &edges, &count);
    ASSERT_EQ(count, 1);

    ctx_gbuf_find_edges_by_target_type(gb, a, "CALLS", &edges, &count);
    ASSERT_EQ(count, 0);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_edges_by_type) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t a = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, b, a, "CALLS", "{}");

    const ctx_gbuf_edge_t **edges = NULL;
    int count = 0;
    ctx_gbuf_find_edges_by_type(gb, "CALLS", &edges, &count);
    ASSERT_EQ(count, 2);

    ctx_gbuf_find_edges_by_type(gb, "IMPORTS", &edges, &count);
    ASSERT_EQ(count, 0);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_delete_edges_by_type) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t a = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, a, b, "IMPORTS", "{}");
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 2);

    ctx_gbuf_delete_edges_by_type(gb, "CALLS");
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 1);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "CALLS"), 0);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "IMPORTS"), 1);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_edge_count_by_type) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t a = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    int64_t c = ctx_gbuf_upsert_node(gb, "Function", "c", "pkg.c", "f.go", 11, 15, "{}");

    ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, a, c, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, b, c, "IMPORTS", "{}");

    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "CALLS"), 2);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "IMPORTS"), 1);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "HTTP_CALLS"), 0);

    ctx_gbuf_free(gb);
    PASS();
}

/* ── Dump to SQLite ────────────────────────────────────────────── */

TEST(gbuf_dump_empty) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");

    /* Dump empty buffer should succeed */
    int rc = ctx_gbuf_flush_to_store(gb, NULL);
    /* NULL store should be handled gracefully — we just skip */
    (void)rc;

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_flush_to_store) {
    /* Create a buffer with some data */
    ctx_gbuf_t *gb = ctx_gbuf_new("test-proj", "/tmp/repo");
    int64_t n1 = ctx_gbuf_upsert_node(gb, "Function", "main", "test-proj::main.go::main", "main.go",
                                      1, 10, "{}");
    int64_t n2 = ctx_gbuf_upsert_node(gb, "Function", "helper", "test-proj::helper.go::helper",
                                      "helper.go", 1, 5, "{}");
    ctx_gbuf_insert_edge(gb, n1, n2, "CALLS", "{}");

    /* Open an in-memory store and flush */
    ctx_store_t *store = ctx_store_open_memory();
    ASSERT_NOT_NULL(store);

    int rc = ctx_gbuf_flush_to_store(gb, store);
    ASSERT_EQ(rc, 0);

    /* Verify data landed in store */
    int node_count = ctx_store_count_nodes(store, "test-proj");
    ASSERT_EQ(node_count, 2);

    int edge_count = ctx_store_count_edges(store, "test-proj");
    ASSERT_EQ(edge_count, 1);

    ctx_store_close(store);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_many_nodes) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");

    /* Insert 1000 nodes */
    for (int i = 0; i < 1000; i++) {
        char name[32], qn[64];
        snprintf(name, sizeof(name), "func_%d", i);
        snprintf(qn, sizeof(qn), "pkg.func_%d", i);
        int64_t id = ctx_gbuf_upsert_node(gb, "Function", name, qn, "f.go", i, i + 5, "{}");
        ASSERT_GT(id, 0);
    }
    ASSERT_EQ(ctx_gbuf_node_count(gb), 1000);

    /* Verify lookup */
    const ctx_gbuf_node_t *n = ctx_gbuf_find_by_qn(gb, "pkg.func_500");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->name, "func_500");

    ctx_gbuf_free(gb);
    PASS();
}

/* ── Node edge cases ───────────────────────────────────────────── */

TEST(gbuf_upsert_null_qn) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    /* NULL qualified_name → returns 0 (error), no node inserted */
    int64_t id = ctx_gbuf_upsert_node(gb, "Function", "foo", NULL, "f.go", 1, 5, "{}");
    ASSERT_EQ(id, 0);
    ASSERT_EQ(ctx_gbuf_node_count(gb), 0);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_upsert_empty_qn) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    /* Empty string QN is valid — it's a non-NULL key */
    int64_t id = ctx_gbuf_upsert_node(gb, "Function", "anon", "", "f.go", 1, 5, "{}");
    ASSERT_GT(id, 0);
    ASSERT_EQ(ctx_gbuf_node_count(gb), 1);

    const ctx_gbuf_node_t *n = ctx_gbuf_find_by_qn(gb, "");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->qualified_name, "");

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_upsert_same_qn_updates_all_fields) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t id1 = ctx_gbuf_upsert_node(gb, "Function", "old_name", "pkg.fn", "old.go", 1, 10,
                                        "{\"k\":\"v1\"}");
    int64_t id2 = ctx_gbuf_upsert_node(gb, "Method", "new_name", "pkg.fn", "new.go", 20, 30,
                                        "{\"k\":\"v2\"}");
    ASSERT_EQ(id1, id2);
    ASSERT_EQ(ctx_gbuf_node_count(gb), 1);

    const ctx_gbuf_node_t *n = ctx_gbuf_find_by_qn(gb, "pkg.fn");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->label, "Method");
    ASSERT_STR_EQ(n->name, "new_name");
    ASSERT_STR_EQ(n->file_path, "new.go");
    ASSERT_EQ(n->start_line, 20);
    ASSERT_EQ(n->end_line, 30);
    ASSERT_STR_EQ(n->properties_json, "{\"k\":\"v2\"}");

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_upsert_long_qn) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");

    /* Build a 1200-char QN */
    char long_qn[1201];
    memset(long_qn, 'a', 1200);
    long_qn[1200] = '\0';

    int64_t id = ctx_gbuf_upsert_node(gb, "Function", "long", long_qn, "f.go", 1, 5, "{}");
    ASSERT_GT(id, 0);

    const ctx_gbuf_node_t *n = ctx_gbuf_find_by_qn(gb, long_qn);
    ASSERT_NOT_NULL(n);
    ASSERT_EQ(strlen(n->qualified_name), 1200);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_qn_missing) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");

    ASSERT_NULL(ctx_gbuf_find_by_qn(gb, "does.not.exist"));
    ASSERT_NULL(ctx_gbuf_find_by_qn(gb, ""));
    ASSERT_NULL(ctx_gbuf_find_by_qn(gb, "pkg.FOO")); /* case sensitive */

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_id_missing) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");

    ASSERT_NULL(ctx_gbuf_find_by_id(gb, 0));
    ASSERT_NULL(ctx_gbuf_find_by_id(gb, -1));
    ASSERT_NULL(ctx_gbuf_find_by_id(gb, 999));
    ASSERT_NULL(ctx_gbuf_find_by_id(gb, INT64_MAX));

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_label_no_matches) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_upsert_node(gb, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");

    const ctx_gbuf_node_t **nodes = NULL;
    int count = 0;
    int rc = ctx_gbuf_find_by_label(gb, "Route", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 0);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_by_name_multiple) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_upsert_node(gb, "Function", "init", "a.init", "a.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(gb, "Function", "init", "b.init", "b.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(gb, "Method", "init", "c.S.init", "c.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(gb, "Function", "other", "d.other", "d.go", 1, 5, "{}");

    const ctx_gbuf_node_t **nodes = NULL;
    int count = 0;
    int rc = ctx_gbuf_find_by_name(gb, "init", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 3);

    rc = ctx_gbuf_find_by_name(gb, "other", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 1);

    rc = ctx_gbuf_find_by_name(gb, "missing", &nodes, &count);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(count, 0);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_delete_by_label_cascades_edges) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t f = ctx_gbuf_upsert_node(gb, "Function", "fn", "pkg.fn", "f.go", 1, 5, "{}");
    int64_t c = ctx_gbuf_upsert_node(gb, "Class", "Cls", "pkg.Cls", "f.go", 10, 20, "{}");
    int64_t m = ctx_gbuf_upsert_node(gb, "Method", "meth", "pkg.Cls.meth", "f.go", 12, 18, "{}");

    /* Edges: fn→Cls, fn→meth, meth→fn */
    ctx_gbuf_insert_edge(gb, f, c, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, f, m, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, m, f, "CALLS", "{}");
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 3);

    /* Delete all Class nodes — should remove fn→Cls edge only */
    ctx_gbuf_delete_by_label(gb, "Class");
    ASSERT_EQ(ctx_gbuf_node_count(gb), 2);
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 2); /* fn→meth and meth→fn survive */

    /* Verify edge source/target type lookups are consistent after cascade */
    const ctx_gbuf_edge_t **edges = NULL;
    int ecount = 0;
    ctx_gbuf_find_edges_by_source_type(gb, f, "CALLS", &edges, &ecount);
    ASSERT_EQ(ecount, 1); /* only fn→meth remains */

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_node_count_empty) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ASSERT_EQ(ctx_gbuf_node_count(gb), 0);
    ASSERT_EQ(ctx_gbuf_node_count(NULL), 0);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_upsert_100_nodes_stress) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    for (int i = 0; i < 100; i++) {
        char name[32], qn[64];
        snprintf(name, sizeof(name), "f%d", i);
        snprintf(qn, sizeof(qn), "pkg.f%d", i);
        int64_t id = ctx_gbuf_upsert_node(gb, "Function", name, qn, "f.go", i, i + 1, "{}");
        ASSERT_GT(id, 0);
    }
    ASSERT_EQ(ctx_gbuf_node_count(gb), 100);

    /* Verify each node is findable */
    for (int i = 0; i < 100; i++) {
        char qn[64];
        snprintf(qn, sizeof(qn), "pkg.f%d", i);
        ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(gb, qn));
    }

    ctx_gbuf_free(gb);
    PASS();
}

/* ── Edge edge cases ──────────────────────────────────────────── */

TEST(gbuf_edge_nonexistent_endpoints) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    /* Edges with non-existent source/target IDs are accepted (no FK validation
     * in the buffer — validation happens at flush time when remapping IDs) */
    int64_t eid = ctx_gbuf_insert_edge(gb, 9999, 8888, "CALLS", "{}");
    ASSERT_GT(eid, 0);
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 1);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_edge_dedup_merges_properties) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t a = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");

    int64_t eid1 = ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{\"weight\":1}");
    int64_t eid2 = ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{\"weight\":5}");
    ASSERT_EQ(eid1, eid2);
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 1);

    /* Verify second insert's properties win (merge = replace) */
    const ctx_gbuf_edge_t **edges = NULL;
    int count = 0;
    ctx_gbuf_find_edges_by_source_type(gb, a, "CALLS", &edges, &count);
    ASSERT_EQ(count, 1);
    ASSERT_STR_EQ(edges[0]->properties_json, "{\"weight\":5}");

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_edge_count_empty) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 0);
    ASSERT_EQ(ctx_gbuf_edge_count(NULL), 0);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_edge_count_by_type_missing) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "CALLS"), 0);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "UNKNOWN"), 0);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, ""), 0);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_delete_edges_preserves_other_types) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t a = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    int64_t c = ctx_gbuf_upsert_node(gb, "Function", "c", "pkg.c", "f.go", 11, 15, "{}");

    ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, b, c, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, a, b, "IMPORTS", "{}");
    ctx_gbuf_insert_edge(gb, a, c, "HTTP_CALLS", "{}");
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 4);

    ctx_gbuf_delete_edges_by_type(gb, "CALLS");
    ASSERT_EQ(ctx_gbuf_edge_count(gb), 2);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "CALLS"), 0);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "IMPORTS"), 1);
    ASSERT_EQ(ctx_gbuf_edge_count_by_type(gb, "HTTP_CALLS"), 1);

    /* Verify secondary indexes are consistent after rebuild */
    const ctx_gbuf_edge_t **edges = NULL;
    int count = 0;
    ctx_gbuf_find_edges_by_source_type(gb, a, "IMPORTS", &edges, &count);
    ASSERT_EQ(count, 1);
    ctx_gbuf_find_edges_by_target_type(gb, c, "HTTP_CALLS", &edges, &count);
    ASSERT_EQ(count, 1);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_find_edges_by_target_type_multiple) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    int64_t a = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    int64_t c = ctx_gbuf_upsert_node(gb, "Function", "c", "pkg.c", "f.go", 11, 15, "{}");

    /* Both a and c call b */
    ctx_gbuf_insert_edge(gb, a, b, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, c, b, "CALLS", "{}");

    const ctx_gbuf_edge_t **edges = NULL;
    int count = 0;
    ctx_gbuf_find_edges_by_target_type(gb, b, "CALLS", &edges, &count);
    ASSERT_EQ(count, 2);

    /* No IMPORTS edges targeting b */
    ctx_gbuf_find_edges_by_target_type(gb, b, "IMPORTS", &edges, &count);
    ASSERT_EQ(count, 0);

    ctx_gbuf_free(gb);
    PASS();
}

/* ── Merge tests ──────────────────────────────────────────────── */

TEST(gbuf_merge_overlapping_qns) {
    ctx_gbuf_t *dst = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_t *src = ctx_gbuf_new("test", "/tmp");

    /* dst has node with QN "pkg.fn" */
    ctx_gbuf_upsert_node(dst, "Function", "fn_old", "pkg.fn", "old.go", 1, 10, "{\"from\":\"dst\"}");
    ctx_gbuf_upsert_node(dst, "Function", "unique_dst", "pkg.unique_dst", "u.go", 1, 5, "{}");

    /* src has same QN with different fields — src should win */
    ctx_gbuf_upsert_node(src, "Method", "fn_new", "pkg.fn", "new.go", 20, 30, "{\"from\":\"src\"}");
    ctx_gbuf_upsert_node(src, "Function", "unique_src", "pkg.unique_src", "s.go", 1, 5, "{}");

    int rc = ctx_gbuf_merge(dst, src);
    ASSERT_EQ(rc, 0);

    /* Total: 3 nodes (1 merged + 1 dst-only + 1 src-only) */
    ASSERT_EQ(ctx_gbuf_node_count(dst), 3);

    /* Verify src fields won for the overlapping QN */
    const ctx_gbuf_node_t *n = ctx_gbuf_find_by_qn(dst, "pkg.fn");
    ASSERT_NOT_NULL(n);
    ASSERT_STR_EQ(n->label, "Method");
    ASSERT_STR_EQ(n->name, "fn_new");
    ASSERT_STR_EQ(n->file_path, "new.go");
    ASSERT_EQ(n->start_line, 20);
    ASSERT_STR_EQ(n->properties_json, "{\"from\":\"src\"}");

    /* Both unique nodes present */
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "pkg.unique_dst"));
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "pkg.unique_src"));

    ctx_gbuf_free(dst);
    ctx_gbuf_free(src);
    PASS();
}

TEST(gbuf_merge_edge_dedup) {
    _Atomic int64_t shared = 1;
    ctx_gbuf_t *dst = ctx_gbuf_new_shared_ids("test", "/tmp", &shared);
    ctx_gbuf_t *src = ctx_gbuf_new_shared_ids("test", "/tmp", &shared);

    int64_t a = ctx_gbuf_upsert_node(dst, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(dst, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    ctx_gbuf_insert_edge(dst, a, b, "CALLS", "{}");

    /* src has same nodes (by QN) and same edge */
    ctx_gbuf_upsert_node(src, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(src, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    /* This edge's src/target IDs differ from dst's, but after merge remap
     * it becomes the same (src, tgt, type) tuple → deduped */
    int64_t sa = ctx_gbuf_find_by_qn(src, "pkg.a")->id;
    int64_t sb = ctx_gbuf_find_by_qn(src, "pkg.b")->id;
    ctx_gbuf_insert_edge(src, sa, sb, "CALLS", "{}");

    int rc = ctx_gbuf_merge(dst, src);
    ASSERT_EQ(rc, 0);

    ASSERT_EQ(ctx_gbuf_node_count(dst), 2);
    ASSERT_EQ(ctx_gbuf_edge_count(dst), 1); /* deduped */

    ctx_gbuf_free(dst);
    ctx_gbuf_free(src);
    PASS();
}

TEST(gbuf_merge_empty_src_into_populated_dst) {
    ctx_gbuf_t *dst = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_t *src = ctx_gbuf_new("test", "/tmp");

    ctx_gbuf_upsert_node(dst, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");
    ctx_gbuf_upsert_node(dst, "Function", "bar", "pkg.bar", "f.go", 6, 10, "{}");

    int rc = ctx_gbuf_merge(dst, src);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(ctx_gbuf_node_count(dst), 2); /* unchanged */

    ctx_gbuf_free(dst);
    ctx_gbuf_free(src);
    PASS();
}

TEST(gbuf_merge_populated_src_into_empty_dst) {
    ctx_gbuf_t *dst = ctx_gbuf_new("test", "/tmp");
    ctx_gbuf_t *src = ctx_gbuf_new("test", "/tmp");

    int64_t a = ctx_gbuf_upsert_node(src, "Function", "foo", "pkg.foo", "f.go", 1, 5, "{}");
    int64_t b = ctx_gbuf_upsert_node(src, "Function", "bar", "pkg.bar", "f.go", 6, 10, "{}");
    ctx_gbuf_insert_edge(src, a, b, "CALLS", "{}");

    int rc = ctx_gbuf_merge(dst, src);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(ctx_gbuf_node_count(dst), 2);
    ASSERT_EQ(ctx_gbuf_edge_count(dst), 1);

    /* Verify nodes are findable in dst */
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "pkg.foo"));
    ASSERT_NOT_NULL(ctx_gbuf_find_by_qn(dst, "pkg.bar"));

    ctx_gbuf_free(dst);
    ctx_gbuf_free(src);
    PASS();
}

TEST(gbuf_merge_null_args) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    ASSERT_EQ(ctx_gbuf_merge(NULL, gb), -1);
    ASSERT_EQ(ctx_gbuf_merge(gb, NULL), -1);
    ASSERT_EQ(ctx_gbuf_merge(NULL, NULL), -1);
    ctx_gbuf_free(gb);
    PASS();
}

/* ── Flush / merge-into-store tests ───────────────────────────── */

TEST(gbuf_flush_to_store_null) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");
    /* NULL store returns -1 */
    ASSERT_EQ(ctx_gbuf_flush_to_store(gb, NULL), -1);
    /* NULL gbuf returns -1 */
    ctx_store_t *store = ctx_store_open_memory();
    ASSERT_EQ(ctx_gbuf_flush_to_store(NULL, store), -1);
    ctx_store_close(store);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_flush_verify_store_data) {
    ctx_gbuf_t *gb = ctx_gbuf_new("proj", "/tmp/repo");
    int64_t n1 = ctx_gbuf_upsert_node(gb, "Function", "alpha", "proj::alpha", "a.go", 1, 10, "{}");
    int64_t n2 = ctx_gbuf_upsert_node(gb, "Class", "Beta", "proj::Beta", "b.go", 1, 20, "{}");
    int64_t n3 = ctx_gbuf_upsert_node(gb, "Function", "gamma", "proj::gamma", "c.go", 1, 5, "{}");
    ctx_gbuf_insert_edge(gb, n1, n2, "CALLS", "{}");
    ctx_gbuf_insert_edge(gb, n1, n3, "IMPORTS", "{}");

    ctx_store_t *store = ctx_store_open_memory();
    ASSERT_NOT_NULL(store);
    int rc = ctx_gbuf_flush_to_store(gb, store);
    ASSERT_EQ(rc, 0);

    /* Verify counts */
    ASSERT_EQ(ctx_store_count_nodes(store, "proj"), 3);
    ASSERT_EQ(ctx_store_count_edges(store, "proj"), 2);

    /* Verify node lookup by QN */
    ctx_node_t out;
    rc = ctx_store_find_node_by_qn(store, "proj", "proj::alpha", &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_STR_EQ(out.name, "alpha");
    ASSERT_STR_EQ(out.label, "Function");
    ctx_node_free_fields(&out);

    rc = ctx_store_find_node_by_qn(store, "proj", "proj::Beta", &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ASSERT_STR_EQ(out.label, "Class");
    ctx_node_free_fields(&out);

    ctx_store_close(store);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_merge_into_store_preserves) {
    /* First, flush initial data via flush_to_store */
    ctx_gbuf_t *gb1 = ctx_gbuf_new("proj", "/tmp/repo");
    ctx_gbuf_upsert_node(gb1, "Function", "existing", "proj::existing", "e.go", 1, 10, "{}");

    ctx_store_t *store = ctx_store_open_memory();
    ASSERT_NOT_NULL(store);
    ctx_store_upsert_project(store, "proj", "/tmp/repo");
    int rc = ctx_gbuf_flush_to_store(gb1, store);
    ASSERT_EQ(rc, 0);
    ASSERT_EQ(ctx_store_count_nodes(store, "proj"), 1);

    /* Now merge_into_store with new data — should NOT delete existing */
    ctx_gbuf_t *gb2 = ctx_gbuf_new("proj", "/tmp/repo");
    ctx_gbuf_upsert_node(gb2, "Function", "newone", "proj::newone", "n.go", 1, 5, "{}");

    rc = ctx_gbuf_merge_into_store(gb2, store);
    ASSERT_EQ(rc, 0);

    /* Both nodes should exist */
    ASSERT_EQ(ctx_store_count_nodes(store, "proj"), 2);

    ctx_node_t out;
    rc = ctx_store_find_node_by_qn(store, "proj", "proj::existing", &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ctx_node_free_fields(&out);

    rc = ctx_store_find_node_by_qn(store, "proj", "proj::newone", &out);
    ASSERT_EQ(rc, CTX_STORE_OK);
    ctx_node_free_fields(&out);

    ctx_store_close(store);
    ctx_gbuf_free(gb1);
    ctx_gbuf_free(gb2);
    PASS();
}

/* ── Shared ID tests ──────────────────────────────────────────── */

TEST(gbuf_shared_ids_unique) {
    _Atomic int64_t shared = 1;
    ctx_gbuf_t *gb1 = ctx_gbuf_new_shared_ids("test", "/tmp", &shared);
    ctx_gbuf_t *gb2 = ctx_gbuf_new_shared_ids("test", "/tmp", &shared);

    int64_t id1 = ctx_gbuf_upsert_node(gb1, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    int64_t id2 = ctx_gbuf_upsert_node(gb2, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    int64_t id3 = ctx_gbuf_upsert_node(gb1, "Function", "c", "pkg.c", "f.go", 11, 15, "{}");
    int64_t id4 = ctx_gbuf_upsert_node(gb2, "Function", "d", "pkg.d", "f.go", 16, 20, "{}");

    /* All IDs must be unique */
    ASSERT_NEQ(id1, id2);
    ASSERT_NEQ(id1, id3);
    ASSERT_NEQ(id1, id4);
    ASSERT_NEQ(id2, id3);
    ASSERT_NEQ(id2, id4);
    ASSERT_NEQ(id3, id4);

    /* IDs should be sequential from the shared source */
    ASSERT_EQ(id1, 1);
    ASSERT_EQ(id2, 2);
    ASSERT_EQ(id3, 3);
    ASSERT_EQ(id4, 4);

    ctx_gbuf_free(gb1);
    ctx_gbuf_free(gb2);
    PASS();
}

TEST(gbuf_shared_ids_null_fallback) {
    /* NULL id_source → behaves like ctx_gbuf_new() */
    ctx_gbuf_t *gb = ctx_gbuf_new_shared_ids("test", "/tmp", NULL);
    ASSERT_NOT_NULL(gb);
    int64_t id = ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    ASSERT_EQ(id, 1);
    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_next_id_set_next_id_roundtrip) {
    ctx_gbuf_t *gb = ctx_gbuf_new("test", "/tmp");

    /* Initial next_id is 1 */
    ASSERT_EQ(ctx_gbuf_next_id(gb), 1);

    /* Insert a node, next_id advances */
    ctx_gbuf_upsert_node(gb, "Function", "a", "pkg.a", "f.go", 1, 5, "{}");
    ASSERT_EQ(ctx_gbuf_next_id(gb), 2);

    /* Set next_id to an arbitrary value */
    ctx_gbuf_set_next_id(gb, 100);
    ASSERT_EQ(ctx_gbuf_next_id(gb), 100);

    /* Next insert uses the new base */
    int64_t id = ctx_gbuf_upsert_node(gb, "Function", "b", "pkg.b", "f.go", 6, 10, "{}");
    ASSERT_EQ(id, 100);
    ASSERT_EQ(ctx_gbuf_next_id(gb), 101);

    ctx_gbuf_free(gb);
    PASS();
}

TEST(gbuf_next_id_null_safe) {
    /* next_id on NULL returns 1 (default) */
    ASSERT_EQ(ctx_gbuf_next_id(NULL), 1);
    /* set_next_id on NULL should not crash */
    ctx_gbuf_set_next_id(NULL, 42);
    PASS();
}

/* ── Flush edge case: orphan edges skipped ────────────────────── */

TEST(gbuf_flush_skips_orphan_edges) {
    ctx_gbuf_t *gb = ctx_gbuf_new("proj", "/tmp/repo");
    int64_t n1 = ctx_gbuf_upsert_node(gb, "Function", "real", "proj::real", "f.go", 1, 5, "{}");

    /* Valid edge */
    ctx_gbuf_insert_edge(gb, n1, n1, "CALLS", "{}");
    /* Orphan edge — target ID 9999 does not map to any node */
    ctx_gbuf_insert_edge(gb, n1, 9999, "CALLS", "{}");

    ctx_store_t *store = ctx_store_open_memory();
    ASSERT_NOT_NULL(store);
    int rc = ctx_gbuf_flush_to_store(gb, store);
    ASSERT_EQ(rc, 0);

    /* Only the valid edge should land in the store */
    ASSERT_EQ(ctx_store_count_nodes(store, "proj"), 1);
    ASSERT_EQ(ctx_store_count_edges(store, "proj"), 1);

    ctx_store_close(store);
    ctx_gbuf_free(gb);
    PASS();
}

/* ── Suite ─────────────────────────────────────────────────────── */

SUITE(graph_buffer) {
    /* Original tests */
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

    /* Node edge cases */
    RUN_TEST(gbuf_upsert_null_qn);
    RUN_TEST(gbuf_upsert_empty_qn);
    RUN_TEST(gbuf_upsert_same_qn_updates_all_fields);
    RUN_TEST(gbuf_upsert_long_qn);
    RUN_TEST(gbuf_find_by_qn_missing);
    RUN_TEST(gbuf_find_by_id_missing);
    RUN_TEST(gbuf_find_by_label_no_matches);
    RUN_TEST(gbuf_find_by_name_multiple);
    RUN_TEST(gbuf_delete_by_label_cascades_edges);
    RUN_TEST(gbuf_node_count_empty);
    RUN_TEST(gbuf_upsert_100_nodes_stress);

    /* Edge edge cases */
    RUN_TEST(gbuf_edge_nonexistent_endpoints);
    RUN_TEST(gbuf_edge_dedup_merges_properties);
    RUN_TEST(gbuf_edge_count_empty);
    RUN_TEST(gbuf_edge_count_by_type_missing);
    RUN_TEST(gbuf_delete_edges_preserves_other_types);
    RUN_TEST(gbuf_find_edges_by_target_type_multiple);

    /* Merge tests */
    RUN_TEST(gbuf_merge_overlapping_qns);
    RUN_TEST(gbuf_merge_edge_dedup);
    RUN_TEST(gbuf_merge_empty_src_into_populated_dst);
    RUN_TEST(gbuf_merge_populated_src_into_empty_dst);
    RUN_TEST(gbuf_merge_null_args);

    /* Flush/merge-into-store tests */
    RUN_TEST(gbuf_flush_to_store_null);
    RUN_TEST(gbuf_flush_verify_store_data);
    RUN_TEST(gbuf_merge_into_store_preserves);
    RUN_TEST(gbuf_flush_skips_orphan_edges);

    /* Shared ID tests */
    RUN_TEST(gbuf_shared_ids_unique);
    RUN_TEST(gbuf_shared_ids_null_fallback);
    RUN_TEST(gbuf_next_id_set_next_id_roundtrip);
    RUN_TEST(gbuf_next_id_null_safe);
}

/*
 * graph_buffer.c — In-memory graph buffer for pipeline indexing.
 *
 * Uses foundation hash tables for O(1) node lookup by QN and edge dedup.
 * Uses dynamic arrays for ordered iteration and secondary indexes.
 *
 * Memory ownership: each node/edge is individually heap-allocated so that
 * pointers stored in hash tables remain stable when the pointer-array grows.
 * The buffer frees everything in cbm_gbuf_free().
 */
#include "graph_buffer/graph_buffer.h"
#include "store/store.h"
#include "foundation/hash_table.h"
#include "foundation/dyn_array.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

/* ── Internal types ──────────────────────────────────────────────── */

/* Edge key for dedup hash table — composite key as string "srcID:tgtID:type" */
#define EDGE_KEY_BUF 128

/* Per-type or per-key edge list stored in hash tables as values */
typedef CBM_DYN_ARRAY(const cbm_gbuf_edge_t *) edge_ptr_array_t;

/* Per-label or per-name node list */
typedef CBM_DYN_ARRAY(const cbm_gbuf_node_t *) node_ptr_array_t;

struct cbm_gbuf {
    char *project;
    char *root_path;
    int64_t next_id;
    _Atomic int64_t *shared_ids; /* NULL = use next_id, non-NULL = atomic source */

    /* Node storage: array of pointers to individually heap-allocated nodes.
     * This ensures pointers stored in hash tables remain valid when the
     * pointer array reallocs (only the pointer array moves, not the nodes). */
    CBM_DYN_ARRAY(cbm_gbuf_node_t *) nodes;

    /* Primary index: QN → cbm_gbuf_node_t* */
    CBMHashTable *node_by_qn;
    /* Primary index: "id" string → cbm_gbuf_node_t* */
    CBMHashTable *node_by_id;

    /* Secondary node indexes */
    CBMHashTable *nodes_by_label; /* key: label, value: (node_ptr_array_t*) */
    CBMHashTable *nodes_by_name;  /* key: name, value: (node_ptr_array_t*) */

    /* Edge storage: array of pointers to individually heap-allocated edges */
    CBM_DYN_ARRAY(cbm_gbuf_edge_t *) edges;

    /* Edge dedup index: "srcID:tgtID:type" → cbm_gbuf_edge_t* */
    CBMHashTable *edge_by_key;

    /* Edge secondary indexes: composite keys → edge_ptr_array_t */
    CBMHashTable *edges_by_source_type; /* "srcID:type" → edge_ptr_array_t* */
    CBMHashTable *edges_by_target_type; /* "tgtID:type" → edge_ptr_array_t* */
    CBMHashTable *edges_by_type;        /* "type" → edge_ptr_array_t* */
};

/* ── Helpers ─────────────────────────────────────────────────────── */

static char *heap_strdup(const char *s) {
    return s ? strdup(s) : strdup("{}");
}

static void make_id_key(char *buf, size_t bufsz, int64_t id) {
    snprintf(buf, bufsz, "%lld", (long long)id);
}

static void make_edge_key(char *buf, size_t bufsz, int64_t src, int64_t tgt, const char *type) {
    snprintf(buf, bufsz, "%lld:%lld:%s", (long long)src, (long long)tgt, type);
}

static void make_src_type_key(char *buf, size_t bufsz, int64_t src, const char *type) {
    snprintf(buf, bufsz, "%lld:%s", (long long)src, type);
}

/* Get or create a node_ptr_array_t in a hash table */
static node_ptr_array_t *get_or_create_node_array(CBMHashTable *ht, const char *key) {
    node_ptr_array_t *arr = cbm_ht_get(ht, key);
    if (!arr) {
        arr = calloc(1, sizeof(node_ptr_array_t));
        cbm_ht_set(ht, strdup(key), arr);
    }
    return arr;
}

/* Get or create an edge_ptr_array_t in a hash table */
static edge_ptr_array_t *get_or_create_edge_array(CBMHashTable *ht, const char *key) {
    edge_ptr_array_t *arr = cbm_ht_get(ht, key);
    if (!arr) {
        arr = calloc(1, sizeof(edge_ptr_array_t));
        cbm_ht_set(ht, strdup(key), arr);
    }
    return arr;
}

/* Free a node_ptr_array_t (callback for hash table iteration) */
static void free_node_array(const char *key, void *value, void *ud) {
    (void)ud;
    node_ptr_array_t *arr = value;
    if (arr) {
        cbm_da_free(arr);
        free(arr);
    }
    free((void *)key);
}

/* Free an edge_ptr_array_t (callback) */
static void free_edge_array(const char *key, void *value, void *ud) {
    (void)ud;
    edge_ptr_array_t *arr = value;
    if (arr) {
        cbm_da_free(arr);
        free(arr);
    }
    free((void *)key);
}

/* Free keys only (for node_by_id, edge_by_key) */
static void free_key_only(const char *key, void *value, void *ud) {
    (void)value;
    (void)ud;
    free((void *)key);
}

/* Free a single node's owned strings */
static void free_node_strings(cbm_gbuf_node_t *n) {
    free(n->label);
    free(n->name);
    free(n->qualified_name);
    free(n->file_path);
    free(n->properties_json);
}

/* Free a single edge's owned strings */
static void free_edge_strings(cbm_gbuf_edge_t *e) {
    free(e->type);
    free(e->properties_json);
}

/* ── Lifecycle ──────────────────────────────────────────────────── */

cbm_gbuf_t *cbm_gbuf_new(const char *project, const char *root_path) {
    cbm_gbuf_t *gb = calloc(1, sizeof(cbm_gbuf_t));
    if (!gb)
        return NULL;

    gb->project = strdup(project ? project : "");
    gb->root_path = strdup(root_path ? root_path : "");
    gb->next_id = 1;
    gb->shared_ids = NULL;

    gb->node_by_qn = cbm_ht_create(256);
    gb->node_by_id = cbm_ht_create(256);
    gb->nodes_by_label = cbm_ht_create(32);
    gb->nodes_by_name = cbm_ht_create(256);

    gb->edge_by_key = cbm_ht_create(512);
    gb->edges_by_source_type = cbm_ht_create(256);
    gb->edges_by_target_type = cbm_ht_create(256);
    gb->edges_by_type = cbm_ht_create(32);

    return gb;
}

cbm_gbuf_t *cbm_gbuf_new_shared_ids(const char *project, const char *root_path,
                                    _Atomic int64_t *id_source) {
    cbm_gbuf_t *gb = cbm_gbuf_new(project, root_path);
    if (gb && id_source) {
        gb->shared_ids = id_source;
    }
    return gb;
}

void cbm_gbuf_free(cbm_gbuf_t *gb) {
    if (!gb)
        return;

    /* Free each individually-allocated node */
    for (int i = 0; i < gb->nodes.count; i++) {
        cbm_gbuf_node_t *n = gb->nodes.items[i];
        free_node_strings(n);
        free(n);
    }
    cbm_da_free(&gb->nodes);

    /* Free each individually-allocated edge */
    for (int i = 0; i < gb->edges.count; i++) {
        cbm_gbuf_edge_t *e = gb->edges.items[i];
        free_edge_strings(e);
        free(e);
    }
    cbm_da_free(&gb->edges);

    /* Free hash tables — node_by_qn values point to nodes already freed above */
    cbm_ht_free(gb->node_by_qn);

    /* node_by_id keys are heap-allocated id strings */
    cbm_ht_foreach(gb->node_by_id, free_key_only, NULL);
    cbm_ht_free(gb->node_by_id);

    /* Secondary indexes own their keys and arrays */
    cbm_ht_foreach(gb->nodes_by_label, free_node_array, NULL);
    cbm_ht_free(gb->nodes_by_label);
    cbm_ht_foreach(gb->nodes_by_name, free_node_array, NULL);
    cbm_ht_free(gb->nodes_by_name);

    /* Edge indexes */
    cbm_ht_foreach(gb->edge_by_key, free_key_only, NULL);
    cbm_ht_free(gb->edge_by_key);
    cbm_ht_foreach(gb->edges_by_source_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_source_type);
    cbm_ht_foreach(gb->edges_by_target_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_target_type);
    cbm_ht_foreach(gb->edges_by_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_type);

    free(gb->project);
    free(gb->root_path);
    free(gb);
}

/* ── ID accessors ────────────────────────────────────────────────── */

int64_t cbm_gbuf_next_id(const cbm_gbuf_t *gb) {
    if (!gb)
        return 1;
    if (gb->shared_ids)
        return atomic_load(gb->shared_ids);
    return gb->next_id;
}

void cbm_gbuf_set_next_id(cbm_gbuf_t *gb, int64_t next_id) {
    if (!gb)
        return;
    gb->next_id = next_id;
}

/* ── Node operations ─────────────────────────────────────────────── */

int64_t cbm_gbuf_upsert_node(cbm_gbuf_t *gb, const char *label, const char *name,
                             const char *qualified_name, const char *file_path, int start_line,
                             int end_line, const char *properties_json) {
    if (!gb || !qualified_name)
        return 0;

    /* Check if node already exists */
    cbm_gbuf_node_t *existing = cbm_ht_get(gb->node_by_qn, qualified_name);
    if (existing) {
        /* Update in-place */
        free(existing->label);
        existing->label = heap_strdup(label);
        free(existing->name);
        existing->name = heap_strdup(name);
        free(existing->file_path);
        existing->file_path = heap_strdup(file_path);
        existing->start_line = start_line;
        existing->end_line = end_line;
        if (properties_json) {
            free(existing->properties_json);
            existing->properties_json = heap_strdup(properties_json);
        }
        return existing->id;
    }

    /* Heap-allocate a new node (pointer stays stable across array growth) */
    cbm_gbuf_node_t *node = calloc(1, sizeof(cbm_gbuf_node_t));
    if (!node)
        return 0;

    int64_t id;
    if (gb->shared_ids) {
        id = atomic_fetch_add_explicit(gb->shared_ids, 1, memory_order_relaxed);
    } else {
        id = gb->next_id++;
    }
    node->id = id;
    node->project = gb->project;
    node->label = heap_strdup(label);
    node->name = heap_strdup(name);
    node->qualified_name = heap_strdup(qualified_name);
    node->file_path = heap_strdup(file_path);
    node->start_line = start_line;
    node->end_line = end_line;
    node->properties_json = heap_strdup(properties_json);

    /* Store pointer in array */
    cbm_da_push(&gb->nodes, node);

    /* Primary indexes — QN key is borrowed from the node's own string */
    cbm_ht_set(gb->node_by_qn, node->qualified_name, node);

    char id_buf[32];
    make_id_key(id_buf, sizeof(id_buf), id);
    cbm_ht_set(gb->node_by_id, strdup(id_buf), node);

    /* Secondary indexes */
    node_ptr_array_t *by_label = get_or_create_node_array(gb->nodes_by_label, label ? label : "");
    cbm_da_push(by_label, (const cbm_gbuf_node_t *)node);

    node_ptr_array_t *by_name = get_or_create_node_array(gb->nodes_by_name, name ? name : "");
    cbm_da_push(by_name, (const cbm_gbuf_node_t *)node);

    return id;
}

const cbm_gbuf_node_t *cbm_gbuf_find_by_qn(const cbm_gbuf_t *gb, const char *qn) {
    if (!gb || !qn)
        return NULL;
    return cbm_ht_get(gb->node_by_qn, qn);
}

const cbm_gbuf_node_t *cbm_gbuf_find_by_id(const cbm_gbuf_t *gb, int64_t id) {
    if (!gb)
        return NULL;
    char key[32];
    make_id_key(key, sizeof(key), id);
    return cbm_ht_get(gb->node_by_id, key);
}

int cbm_gbuf_find_by_label(const cbm_gbuf_t *gb, const char *label, const cbm_gbuf_node_t ***out,
                           int *count) {
    if (!gb || !out || !count)
        return -1;
    node_ptr_array_t *arr = cbm_ht_get(gb->nodes_by_label, label ? label : "");
    if (arr && arr->count > 0) {
        *out = arr->items;
        *count = arr->count;
    } else {
        *out = NULL;
        *count = 0;
    }
    return 0;
}

int cbm_gbuf_find_by_name(const cbm_gbuf_t *gb, const char *name, const cbm_gbuf_node_t ***out,
                          int *count) {
    if (!gb || !out || !count)
        return -1;
    node_ptr_array_t *arr = cbm_ht_get(gb->nodes_by_name, name ? name : "");
    if (arr && arr->count > 0) {
        *out = arr->items;
        *count = arr->count;
    } else {
        *out = NULL;
        *count = 0;
    }
    return 0;
}

int cbm_gbuf_node_count(const cbm_gbuf_t *gb) {
    /* Use QN hash table count since it's authoritative (handles deletes) */
    return gb ? (int)cbm_ht_count(gb->node_by_qn) : 0;
}

int cbm_gbuf_delete_by_label(cbm_gbuf_t *gb, const char *label) {
    if (!gb || !label)
        return -1;

    node_ptr_array_t *arr = cbm_ht_get(gb->nodes_by_label, label);
    if (!arr || arr->count == 0)
        return 0;

    /* Collect IDs of deleted nodes and remove from indexes */
    CBM_DYN_ARRAY(int64_t) deleted_ids = {0};
    for (int i = 0; i < arr->count; i++) {
        const cbm_gbuf_node_t *n = arr->items[i];
        cbm_da_push(&deleted_ids, n->id);

        /* Remove from primary indexes */
        cbm_ht_delete(gb->node_by_qn, n->qualified_name);
        char id_buf[32];
        make_id_key(id_buf, sizeof(id_buf), n->id);
        void *removed_key = cbm_ht_delete(gb->node_by_id, id_buf);
        (void)removed_key;
    }

    /* Clear the label array */
    cbm_da_clear(arr);

    /* Cascade-delete edges referencing deleted nodes.
     * Rebuild edges pointer array, freeing deleted edges. */
    int write_idx = 0;
    for (int i = 0; i < gb->edges.count; i++) {
        cbm_gbuf_edge_t *e = gb->edges.items[i];
        bool should_delete = false;
        for (int j = 0; j < deleted_ids.count; j++) {
            if (e->source_id == deleted_ids.items[j] || e->target_id == deleted_ids.items[j]) {
                should_delete = true;
                break;
            }
        }
        if (should_delete) {
            /* Remove from edge dedup index */
            char key[EDGE_KEY_BUF];
            make_edge_key(key, sizeof(key), e->source_id, e->target_id, e->type);
            void *k = cbm_ht_delete(gb->edge_by_key, key);
            (void)k;

            /* Free the edge */
            free_edge_strings(e);
            free(e);
        } else {
            gb->edges.items[write_idx++] = gb->edges.items[i];
        }
    }
    gb->edges.count = write_idx;

    /* Rebuild edge secondary indexes from scratch */
    cbm_ht_foreach(gb->edges_by_source_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_source_type);
    cbm_ht_foreach(gb->edges_by_target_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_target_type);
    cbm_ht_foreach(gb->edges_by_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_type);

    gb->edges_by_source_type = cbm_ht_create(256);
    gb->edges_by_target_type = cbm_ht_create(256);
    gb->edges_by_type = cbm_ht_create(32);

    for (int i = 0; i < gb->edges.count; i++) {
        cbm_gbuf_edge_t *e = gb->edges.items[i];
        char key[EDGE_KEY_BUF];

        make_src_type_key(key, sizeof(key), e->source_id, e->type);
        edge_ptr_array_t *st = get_or_create_edge_array(gb->edges_by_source_type, key);
        cbm_da_push(st, (const cbm_gbuf_edge_t *)e);

        make_src_type_key(key, sizeof(key), e->target_id, e->type);
        edge_ptr_array_t *tt = get_or_create_edge_array(gb->edges_by_target_type, key);
        cbm_da_push(tt, (const cbm_gbuf_edge_t *)e);

        edge_ptr_array_t *bt = get_or_create_edge_array(gb->edges_by_type, e->type);
        cbm_da_push(bt, (const cbm_gbuf_edge_t *)e);
    }

    // cppcheck-suppress unreadVariable
    cbm_da_free(&deleted_ids);
    return 0;
}

/* ── Edge operations ─────────────────────────────────────────────── */

int64_t cbm_gbuf_insert_edge(cbm_gbuf_t *gb, int64_t source_id, int64_t target_id, const char *type,
                             const char *properties_json) {
    if (!gb || !type)
        return 0;

    /* Check for dedup */
    char key[EDGE_KEY_BUF];
    make_edge_key(key, sizeof(key), source_id, target_id, type);

    cbm_gbuf_edge_t *existing = cbm_ht_get(gb->edge_by_key, key);
    if (existing) {
        /* Merge properties (just replace for now) */
        if (properties_json && strcmp(properties_json, "{}") != 0) {
            free(existing->properties_json);
            existing->properties_json = heap_strdup(properties_json);
        }
        return existing->id;
    }

    /* Heap-allocate a new edge (pointer stays stable) */
    cbm_gbuf_edge_t *edge = calloc(1, sizeof(cbm_gbuf_edge_t));
    if (!edge)
        return 0;

    int64_t id;
    if (gb->shared_ids) {
        id = atomic_fetch_add_explicit(gb->shared_ids, 1, memory_order_relaxed);
    } else {
        id = gb->next_id++;
    }
    edge->id = id;
    edge->project = gb->project;
    edge->source_id = source_id;
    edge->target_id = target_id;
    edge->type = heap_strdup(type);
    edge->properties_json = heap_strdup(properties_json);

    /* Store pointer in array */
    cbm_da_push(&gb->edges, edge);

    /* Dedup index */
    cbm_ht_set(gb->edge_by_key, strdup(key), edge);

    /* Secondary indexes */
    make_src_type_key(key, sizeof(key), source_id, type);
    edge_ptr_array_t *st = get_or_create_edge_array(gb->edges_by_source_type, key);
    cbm_da_push(st, (const cbm_gbuf_edge_t *)edge);

    make_src_type_key(key, sizeof(key), target_id, type);
    edge_ptr_array_t *tt = get_or_create_edge_array(gb->edges_by_target_type, key);
    cbm_da_push(tt, (const cbm_gbuf_edge_t *)edge);

    edge_ptr_array_t *bt = get_or_create_edge_array(gb->edges_by_type, type);
    cbm_da_push(bt, (const cbm_gbuf_edge_t *)edge);

    return id;
}

int cbm_gbuf_find_edges_by_source_type(const cbm_gbuf_t *gb, int64_t source_id, const char *type,
                                       const cbm_gbuf_edge_t ***out, int *count) {
    if (!gb || !out || !count)
        return -1;
    char key[EDGE_KEY_BUF];
    make_src_type_key(key, sizeof(key), source_id, type);
    edge_ptr_array_t *arr = cbm_ht_get(gb->edges_by_source_type, key);
    if (arr && arr->count > 0) {
        *out = arr->items;
        *count = arr->count;
    } else {
        *out = NULL;
        *count = 0;
    }
    return 0;
}

int cbm_gbuf_find_edges_by_target_type(const cbm_gbuf_t *gb, int64_t target_id, const char *type,
                                       const cbm_gbuf_edge_t ***out, int *count) {
    if (!gb || !out || !count)
        return -1;
    char key[EDGE_KEY_BUF];
    make_src_type_key(key, sizeof(key), target_id, type);
    edge_ptr_array_t *arr = cbm_ht_get(gb->edges_by_target_type, key);
    if (arr && arr->count > 0) {
        *out = arr->items;
        *count = arr->count;
    } else {
        *out = NULL;
        *count = 0;
    }
    return 0;
}

int cbm_gbuf_find_edges_by_type(const cbm_gbuf_t *gb, const char *type,
                                const cbm_gbuf_edge_t ***out, int *count) {
    if (!gb || !out || !count)
        return -1;
    edge_ptr_array_t *arr = cbm_ht_get(gb->edges_by_type, type);
    if (arr && arr->count > 0) {
        *out = arr->items;
        *count = arr->count;
    } else {
        *out = NULL;
        *count = 0;
    }
    return 0;
}

int cbm_gbuf_edge_count(const cbm_gbuf_t *gb) {
    return gb ? gb->edges.count : 0;
}

int cbm_gbuf_edge_count_by_type(const cbm_gbuf_t *gb, const char *type) {
    if (!gb || !type)
        return 0;
    edge_ptr_array_t *arr = cbm_ht_get(gb->edges_by_type, type);
    return arr ? arr->count : 0;
}

int cbm_gbuf_delete_edges_by_type(cbm_gbuf_t *gb, const char *type) {
    if (!gb || !type)
        return -1;

    /* Rebuild edges array without the deleted type */
    int write_idx = 0;
    for (int i = 0; i < gb->edges.count; i++) {
        cbm_gbuf_edge_t *e = gb->edges.items[i];
        if (strcmp(e->type, type) == 0) {
            char key[EDGE_KEY_BUF];
            make_edge_key(key, sizeof(key), e->source_id, e->target_id, e->type);
            void *k = cbm_ht_delete(gb->edge_by_key, key);
            (void)k;
            free_edge_strings(e);
            free(e);
        } else {
            gb->edges.items[write_idx++] = gb->edges.items[i];
        }
    }
    gb->edges.count = write_idx;

    /* Rebuild edge secondary indexes */
    cbm_ht_foreach(gb->edges_by_source_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_source_type);
    cbm_ht_foreach(gb->edges_by_target_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_target_type);
    cbm_ht_foreach(gb->edges_by_type, free_edge_array, NULL);
    cbm_ht_free(gb->edges_by_type);

    gb->edges_by_source_type = cbm_ht_create(256);
    gb->edges_by_target_type = cbm_ht_create(256);
    gb->edges_by_type = cbm_ht_create(32);

    for (int i = 0; i < gb->edges.count; i++) {
        cbm_gbuf_edge_t *e = gb->edges.items[i];
        char key[EDGE_KEY_BUF];

        make_src_type_key(key, sizeof(key), e->source_id, e->type);
        edge_ptr_array_t *st = get_or_create_edge_array(gb->edges_by_source_type, key);
        cbm_da_push(st, (const cbm_gbuf_edge_t *)e);

        make_src_type_key(key, sizeof(key), e->target_id, e->type);
        edge_ptr_array_t *tt = get_or_create_edge_array(gb->edges_by_target_type, key);
        cbm_da_push(tt, (const cbm_gbuf_edge_t *)e);

        edge_ptr_array_t *bt = get_or_create_edge_array(gb->edges_by_type, e->type);
        cbm_da_push(bt, (const cbm_gbuf_edge_t *)e);
    }

    return 0;
}

/* ── Merge ───────────────────────────────────────────────────────── */

/* Free remap hash table entries (key = heap string, value = heap int64_t*) */
static void free_remap_entry(const char *key, void *val, void *ud) {
    (void)ud;
    free((void *)key);
    free(val);
}

int cbm_gbuf_merge(cbm_gbuf_t *dst, cbm_gbuf_t *src) {
    if (!dst || !src)
        return -1;
    if (src->nodes.count == 0 && src->edges.count == 0)
        return 0;

    /* ID remap for QN-colliding nodes: "src_id" → (int64_t*) dst_id.
     * Only populated when a src node's QN already exists in dst. */
    CBMHashTable *remap = NULL;

    for (int i = 0; i < src->nodes.count; i++) {
        cbm_gbuf_node_t *sn = src->nodes.items[i];
        if (!sn->qualified_name)
            continue;

        /* Skip nodes deleted from QN index */
        if (!cbm_ht_get(src->node_by_qn, sn->qualified_name))
            continue;

        cbm_gbuf_node_t *existing = cbm_ht_get(dst->node_by_qn, sn->qualified_name);
        if (existing) {
            /* QN collision: update dst node fields (src wins), keep dst's ID */
            free(existing->label);
            existing->label = heap_strdup(sn->label);
            free(existing->name);
            existing->name = heap_strdup(sn->name);
            free(existing->file_path);
            existing->file_path = heap_strdup(sn->file_path);
            existing->start_line = sn->start_line;
            existing->end_line = sn->end_line;
            if (sn->properties_json) {
                free(existing->properties_json);
                existing->properties_json = heap_strdup(sn->properties_json);
            }

            /* Record remap if IDs differ */
            if (sn->id != existing->id) {
                if (!remap)
                    remap = cbm_ht_create(32);
                char key[32];
                make_id_key(key, sizeof(key), sn->id);
                int64_t *val = malloc(sizeof(int64_t));
                *val = existing->id;
                cbm_ht_set(remap, strdup(key), val);
            }
        } else {
            /* No collision: copy node with original src ID */
            cbm_gbuf_node_t *node = calloc(1, sizeof(cbm_gbuf_node_t));
            if (!node)
                continue;

            node->id = sn->id;
            node->project = dst->project;
            node->label = heap_strdup(sn->label);
            node->name = heap_strdup(sn->name);
            node->qualified_name = heap_strdup(sn->qualified_name);
            node->file_path = heap_strdup(sn->file_path);
            node->start_line = sn->start_line;
            node->end_line = sn->end_line;
            node->properties_json = heap_strdup(sn->properties_json);

            /* Store in array */
            cbm_da_push(&dst->nodes, node);

            /* Primary indexes */
            cbm_ht_set(dst->node_by_qn, node->qualified_name, node);
            char id_buf[32];
            make_id_key(id_buf, sizeof(id_buf), node->id);
            cbm_ht_set(dst->node_by_id, strdup(id_buf), node);

            /* Secondary indexes */
            node_ptr_array_t *by_label =
                get_or_create_node_array(dst->nodes_by_label, node->label ? node->label : "");
            cbm_da_push(by_label, (const cbm_gbuf_node_t *)node);

            node_ptr_array_t *by_name =
                get_or_create_node_array(dst->nodes_by_name, node->name ? node->name : "");
            cbm_da_push(by_name, (const cbm_gbuf_node_t *)node);

            /* Keep next_id above all inserted IDs */
            if (node->id >= dst->next_id) {
                dst->next_id = node->id + 1;
            }
        }
    }

    /* Merge edges with optional ID remapping */
    for (int i = 0; i < src->edges.count; i++) {
        cbm_gbuf_edge_t *se = src->edges.items[i];

        int64_t new_src = se->source_id;
        int64_t new_tgt = se->target_id;

        if (remap) {
            char key[32];
            make_id_key(key, sizeof(key), se->source_id);
            int64_t *remapped = cbm_ht_get(remap, key);
            if (remapped)
                new_src = *remapped;

            make_id_key(key, sizeof(key), se->target_id);
            remapped = cbm_ht_get(remap, key);
            if (remapped)
                new_tgt = *remapped;
        }

        cbm_gbuf_insert_edge(dst, new_src, new_tgt, se->type, se->properties_json);
    }

    if (remap) {
        cbm_ht_foreach(remap, free_remap_entry, NULL);
        cbm_ht_free(remap);
    }

    return 0;
}

/* ── Dump / Flush ────────────────────────────────────────────────── */

int cbm_gbuf_dump_to_sqlite(cbm_gbuf_t *gb, const char *path) {
    /* TODO: Wire to cbm_write_db() when pipeline is ready.
     * For now, fall through to flush_to_store with a file-backed store. */
    if (!gb || !path)
        return -1;

    cbm_store_t *store = cbm_store_open_path(path);
    if (!store)
        return -1;

    int rc = cbm_gbuf_flush_to_store(gb, store);
    if (rc == 0) {
        cbm_store_checkpoint(store);
    }
    cbm_store_close(store);
    return rc;
}

int cbm_gbuf_flush_to_store(cbm_gbuf_t *gb, cbm_store_t *store) {
    if (!gb || !store)
        return -1;

    /* Upsert project */
    cbm_store_upsert_project(store, gb->project, gb->root_path);

    /* Begin bulk mode */
    cbm_store_begin_bulk(store);
    cbm_store_drop_indexes(store);
    cbm_store_begin(store);

    /* Delete existing project data */
    cbm_store_delete_edges_by_project(store, gb->project);
    cbm_store_delete_nodes_by_project(store, gb->project);

    /* Build temp_id → real_id map.
     * Temp IDs start at 1 and are sequential, but can have gaps from edge inserts.
     * Use max_id as size. */
    int64_t max_temp_id = gb->next_id;
    int64_t *temp_to_real = calloc(max_temp_id, sizeof(int64_t));

    for (int i = 0; i < gb->nodes.count; i++) {
        cbm_gbuf_node_t *n = gb->nodes.items[i];

        /* Skip if deleted from QN index */
        if (!cbm_ht_get(gb->node_by_qn, n->qualified_name))
            continue;

        cbm_node_t sn = {
            .project = gb->project,
            .label = n->label,
            .name = n->name,
            .qualified_name = n->qualified_name,
            .file_path = n->file_path,
            .start_line = n->start_line,
            .end_line = n->end_line,
            .properties_json = n->properties_json,
        };
        int64_t real_id = cbm_store_upsert_node(store, &sn);
        if (real_id > 0 && n->id < max_temp_id) {
            temp_to_real[n->id] = real_id;
        }
    }

    /* Insert all edges with remapped IDs */
    for (int i = 0; i < gb->edges.count; i++) {
        cbm_gbuf_edge_t *e = gb->edges.items[i];
        int64_t real_src = (e->source_id < max_temp_id) ? temp_to_real[e->source_id] : 0;
        int64_t real_tgt = (e->target_id < max_temp_id) ? temp_to_real[e->target_id] : 0;
        if (real_src == 0 || real_tgt == 0)
            continue;

        cbm_edge_t se = {
            .project = gb->project,
            .source_id = real_src,
            .target_id = real_tgt,
            .type = e->type,
            .properties_json = e->properties_json,
        };
        cbm_store_insert_edge(store, &se);
    }

    cbm_store_commit(store);
    cbm_store_create_indexes(store);
    cbm_store_end_bulk(store);

    free(temp_to_real);
    return 0;
}

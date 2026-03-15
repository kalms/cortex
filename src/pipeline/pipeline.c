/*
 * pipeline.c — Indexing pipeline orchestrator.
 *
 * Coordinates multi-pass indexing:
 *   1. Discover files
 *   2. Build structure (Project/Folder/Package/File nodes)
 *   3. Bulk load sources (read + LZ4 HC compress)
 *   4. Extract definitions (fused: extract + write nodes + build registry)
 *   5. Resolve imports, calls, usages, semantic edges
 *   6. Post-passes: tests, communities, HTTP links, git history
 *   7. Dump graph buffer to SQLite
 */
#include "pipeline/pipeline.h"
#include "pipeline/pipeline_internal.h"
#include "pipeline/worker_pool.h"
#include "graph_buffer/graph_buffer.h"
#include "store/store.h"
#include "discover/discover.h"
#include "foundation/platform.h"
#include "foundation/log.h"
#include "foundation/hash_table.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <time.h>

/* ── Internal state ──────────────────────────────────────────────── */

struct cbm_pipeline {
    char *repo_path;
    char *db_path;
    char *project_name;
    cbm_index_mode_t mode;
    atomic_int cancelled;

    /* Indexing state (set during run) */
    cbm_gbuf_t *gbuf;
    cbm_store_t *store;
    cbm_registry_t *registry;
};

/* ── Timing helper ──────────────────────────────────────────────── */

static double elapsed_ms(struct timespec start) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (now.tv_sec - start.tv_sec) * 1000.0 + (now.tv_nsec - start.tv_nsec) / 1e6;
}

/* Format int to string for logging. Thread-safe via TLS rotating buffers. */
static const char *itoa_buf(int val) {
    static _Thread_local char bufs[4][32];
    static _Thread_local int idx = 0;
    int i = idx;
    idx = (idx + 1) & 3;
    snprintf(bufs[i], sizeof(bufs[i]), "%d", val);
    return bufs[i];
}

/* ── Lifecycle ──────────────────────────────────────────────────── */

cbm_pipeline_t *cbm_pipeline_new(const char *repo_path, const char *db_path,
                                 cbm_index_mode_t mode) {
    if (!repo_path)
        return NULL;

    cbm_pipeline_t *p = calloc(1, sizeof(cbm_pipeline_t));
    if (!p)
        return NULL;

    p->repo_path = strdup(repo_path);
    p->db_path = db_path ? strdup(db_path) : NULL;
    p->project_name = cbm_project_name_from_path(repo_path);
    p->mode = mode;
    atomic_init(&p->cancelled, 0);

    return p;
}

void cbm_pipeline_free(cbm_pipeline_t *p) {
    if (!p)
        return;
    free(p->repo_path);
    free(p->db_path);
    free(p->project_name);
    /* gbuf, store, registry freed during/after run */
    free(p);
}

void cbm_pipeline_cancel(cbm_pipeline_t *p) {
    if (p)
        atomic_store(&p->cancelled, 1);
}

const char *cbm_pipeline_project_name(const cbm_pipeline_t *p) {
    return p ? p->project_name : NULL;
}

static int check_cancel(const cbm_pipeline_t *p) {
    return atomic_load(&p->cancelled) ? -1 : 0;
}

/* ── Hash table cleanup callback ─────────────────────────────────── */

static void free_seen_dir_key(const char *key, void *val, void *ud) {
    (void)val;
    (void)ud;
    free((void *)key);
}

/* ── Pass 1: Structure ──────────────────────────────────────────── */

/* Create Project, Folder/Package, and File nodes in the graph buffer. */
static int pass_structure(cbm_pipeline_t *p, const cbm_file_info_t *files, int file_count) {
    cbm_log_info("pass.start", "pass", "structure", "files", itoa_buf(file_count));

    /* Project node */
    cbm_gbuf_upsert_node(p->gbuf, "Project", p->project_name, p->project_name, NULL, 0, 0, "{}");

    /* Collect unique directories and create Folder/Package nodes */
    CBMHashTable *seen_dirs = cbm_ht_create(256);

    for (int i = 0; i < file_count; i++) {
        const char *rel = files[i].rel_path;
        if (!rel)
            continue;

        /* Create File node */
        char *file_qn = cbm_pipeline_fqn_compute(p->project_name, rel, "__file__");
        /* Extract basename */
        const char *slash = strrchr(rel, '/');
        const char *basename = slash ? slash + 1 : rel;

        char props[256];
        const char *ext = strrchr(basename, '.');
        snprintf(props, sizeof(props), "{\"extension\":\"%s\"}", ext ? ext : "");

        const char *qualified_name = file_qn;
        const char *file_path = rel;
        cbm_gbuf_upsert_node(p->gbuf, "File", basename, qualified_name, file_path, 0, 0, props);

        /* CONTAINS_FILE edge: parent dir -> file */
        char *dir = strdup(rel);
        char *last_slash = strrchr(dir, '/');
        if (last_slash)
            *last_slash = '\0';
        else {
            free(dir);
            dir = strdup("");
        }

        const char *parent_qn;
        char *parent_qn_heap = NULL;
        if (dir[0] == '\0') {
            parent_qn = p->project_name;
        } else {
            parent_qn_heap = cbm_pipeline_fqn_folder(p->project_name, dir);
            parent_qn = parent_qn_heap;
        }

        /* Walk up directory chain, creating Folder nodes */
        char *walk_dir = strdup(dir);
        while (walk_dir[0] != '\0' && !cbm_ht_get(seen_dirs, walk_dir)) {
            cbm_ht_set(seen_dirs, strdup(walk_dir), (void *)1);

            char *folder_qn = cbm_pipeline_fqn_folder(p->project_name, walk_dir);
            const char *dir_base = strrchr(walk_dir, '/');
            dir_base = dir_base ? dir_base + 1 : walk_dir;

            cbm_gbuf_upsert_node(p->gbuf, "Folder", dir_base, folder_qn, walk_dir, 0, 0, "{}");

            /* CONTAINS_FOLDER edge: parent -> this dir */
            char *pdir = strdup(walk_dir);
            char *ps = strrchr(pdir, '/');
            if (ps)
                *ps = '\0';
            else {
                free(pdir);
                pdir = strdup("");
            }

            const char *pqn;
            char *pqn_heap = NULL;
            if (pdir[0] == '\0') {
                pqn = p->project_name;
            } else {
                pqn_heap = cbm_pipeline_fqn_folder(p->project_name, pdir);
                pqn = pqn_heap;
            }

            const cbm_gbuf_node_t *fn = cbm_gbuf_find_by_qn(p->gbuf, folder_qn);
            const cbm_gbuf_node_t *pn = cbm_gbuf_find_by_qn(p->gbuf, pqn);
            if (fn && pn) {
                cbm_gbuf_insert_edge(p->gbuf, pn->id, fn->id, "CONTAINS_FOLDER", "{}");
            }

            free(folder_qn);
            free(pqn_heap);

            /* Move up one level */
            char *up = strrchr(walk_dir, '/');
            if (up)
                *up = '\0';
            else
                walk_dir[0] = '\0';
            free(pdir);
        }

        /* Now create the CONTAINS_FILE edge */
        const cbm_gbuf_node_t *fnode = cbm_gbuf_find_by_qn(p->gbuf, file_qn);
        const cbm_gbuf_node_t *pnode = cbm_gbuf_find_by_qn(p->gbuf, parent_qn);
        if (fnode && pnode) {
            cbm_gbuf_insert_edge(p->gbuf, pnode->id, fnode->id, "CONTAINS_FILE", "{}");
        }

        free(file_qn);
        free(dir);
        free(walk_dir);
        free(parent_qn_heap);
    }

    /* Free seen_dirs keys */
    cbm_ht_foreach(seen_dirs, free_seen_dir_key, NULL);
    cbm_ht_free(seen_dirs);

    cbm_log_info("pass.done", "pass", "structure", "nodes", itoa_buf(cbm_gbuf_node_count(p->gbuf)),
                 "edges", itoa_buf(cbm_gbuf_edge_count(p->gbuf)));
    return 0;
}

/* ── Pass 2: Definitions ─────────────────────────────────────────── */

/* Implemented in pass_definitions.c via cbm_pipeline_pass_definitions() */

/* ── Pipeline run ────────────────────────────────────────────────── */

int cbm_pipeline_run(cbm_pipeline_t *p) {
    if (!p)
        return -1;

    struct timespec t0;
    clock_gettime(CLOCK_MONOTONIC, &t0);

    /* Phase 1: Discover files */
    cbm_discover_opts_t opts = {
        .mode = p->mode,
        .ignore_file = NULL,
        .max_file_size = 0,
    };
    cbm_file_info_t *files = NULL;
    int file_count = 0;
    int rc = cbm_discover(p->repo_path, &opts, &files, &file_count);
    if (rc != 0) {
        cbm_log_error("pipeline.err", "phase", "discover", "rc", itoa_buf(rc));
        return -1;
    }
    cbm_log_info("pipeline.discover", "files", itoa_buf(file_count), "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t0)));

    if (check_cancel(p)) {
        cbm_discover_free(files, file_count);
        return -1;
    }

    /* Phase 2: Create graph buffer and registry */
    p->gbuf = cbm_gbuf_new(p->project_name, p->repo_path);
    p->registry = cbm_registry_new();

    /* Phase 3: Run passes */
    struct timespec t;

    /* Build shared context for pass functions */
    cbm_pipeline_ctx_t ctx = {
        .project_name = p->project_name,
        .repo_path = p->repo_path,
        .gbuf = p->gbuf,
        .registry = p->registry,
        .cancelled = &p->cancelled,
    };

    clock_gettime(CLOCK_MONOTONIC, &t);
    rc = pass_structure(p, files, file_count);
    if (rc != 0) // cppcheck-suppress knownConditionTrueFalse
        goto cleanup;
    cbm_log_info("pass.timing", "pass", "structure", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
    if (check_cancel(p)) {
        rc = -1;
        goto cleanup;
    }

    /* Decide: parallel or sequential pipeline */
    int worker_count = cbm_default_worker_count(true);
    bool use_parallel = (worker_count > 1 && file_count > 50);

    if (use_parallel) {
        cbm_log_info("pipeline.mode", "mode", "parallel", "workers", itoa_buf(worker_count),
                     "files", itoa_buf(file_count));

        /* Shared atomic ID source — workers allocate globally unique IDs */
        _Atomic int64_t shared_ids;
        int64_t gbuf_next = cbm_gbuf_next_id(p->gbuf);
        atomic_init(&shared_ids, gbuf_next);

        /* Allocate result cache: one CBMFileResult* per file */
        CBMFileResult **result_cache = calloc(file_count, sizeof(CBMFileResult *));
        if (!result_cache) {
            cbm_log_error("pipeline.err", "phase", "cache_alloc");
            rc = -1;
            goto cleanup;
        }

        /* Phase 3A: Parallel extract + definition nodes */
        clock_gettime(CLOCK_MONOTONIC, &t);
        rc = cbm_parallel_extract(&ctx, files, file_count, result_cache, &shared_ids, worker_count);
        cbm_log_info("pass.timing", "pass", "parallel_extract", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));
        if (rc != 0) {
            free(result_cache);
            goto cleanup;
        }
        if (check_cancel(p)) {
            free(result_cache);
            rc = -1;
            goto cleanup;
        }

        /* Sync gbuf ID counter after merge */
        cbm_gbuf_set_next_id(p->gbuf, atomic_load(&shared_ids));

        /* Phase 3B: Serial registry build + DEFINES/IMPORTS edges */
        clock_gettime(CLOCK_MONOTONIC, &t);
        rc = cbm_build_registry_from_cache(&ctx, files, file_count, result_cache);
        cbm_log_info("pass.timing", "pass", "registry_build", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));
        if (rc != 0) {
            for (int i = 0; i < file_count; i++)
                if (result_cache[i])
                    cbm_free_result(result_cache[i]);
            free(result_cache);
            goto cleanup;
        }
        if (check_cancel(p)) {
            for (int i = 0; i < file_count; i++)
                if (result_cache[i])
                    cbm_free_result(result_cache[i]);
            free(result_cache);
            rc = -1;
            goto cleanup;
        }

        /* Phase 4: Parallel resolution (calls + usages + semantic, fused) */
        clock_gettime(CLOCK_MONOTONIC, &t);
        rc = cbm_parallel_resolve(&ctx, files, file_count, result_cache, &shared_ids, worker_count);
        cbm_log_info("pass.timing", "pass", "parallel_resolve", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));

        /* Sync gbuf ID counter after resolve merge */
        cbm_gbuf_set_next_id(p->gbuf, atomic_load(&shared_ids));

        /* Free cached extraction results */
        for (int i = 0; i < file_count; i++)
            if (result_cache[i])
                cbm_free_result(result_cache[i]);
        free(result_cache);

        if (rc != 0)
            goto cleanup;
        if (check_cancel(p)) {
            rc = -1;
            goto cleanup;
        }
    } else {
        cbm_log_info("pipeline.mode", "mode", "sequential", "files", itoa_buf(file_count));

        /* Sequential fallback: original 4-pass chain */
        clock_gettime(CLOCK_MONOTONIC, &t);
        rc = cbm_pipeline_pass_definitions(&ctx, files, file_count);
        if (rc != 0)
            goto cleanup;
        cbm_log_info("pass.timing", "pass", "definitions", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));
        if (check_cancel(p)) {
            rc = -1;
            goto cleanup;
        }

        clock_gettime(CLOCK_MONOTONIC, &t);
        rc = cbm_pipeline_pass_calls(&ctx, files, file_count);
        if (rc != 0)
            goto cleanup;
        cbm_log_info("pass.timing", "pass", "calls", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
        if (check_cancel(p)) {
            rc = -1;
            goto cleanup;
        }

        clock_gettime(CLOCK_MONOTONIC, &t);
        rc = cbm_pipeline_pass_usages(&ctx, files, file_count);
        if (rc != 0)
            goto cleanup;
        cbm_log_info("pass.timing", "pass", "usages", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
        if (check_cancel(p)) {
            rc = -1;
            goto cleanup;
        }

        clock_gettime(CLOCK_MONOTONIC, &t);
        rc = cbm_pipeline_pass_semantic(&ctx, files, file_count);
        if (rc != 0)
            goto cleanup;
        cbm_log_info("pass.timing", "pass", "semantic", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
        if (check_cancel(p)) {
            rc = -1;
            goto cleanup;
        }
    }

    /* Post-extraction passes (shared by both parallel and sequential) */
    clock_gettime(CLOCK_MONOTONIC, &t);
    rc = cbm_pipeline_pass_tests(&ctx, files, file_count);
    if (rc != 0)
        goto cleanup;
    cbm_log_info("pass.timing", "pass", "tests", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
    if (check_cancel(p)) {
        rc = -1;
        goto cleanup;
    }

    clock_gettime(CLOCK_MONOTONIC, &t);
    rc = cbm_pipeline_pass_githistory(&ctx);
    if (rc != 0)
        goto cleanup;
    cbm_log_info("pass.timing", "pass", "githistory", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
    if (check_cancel(p)) {
        rc = -1;
        goto cleanup;
    }

    clock_gettime(CLOCK_MONOTONIC, &t);
    rc = cbm_pipeline_pass_httplinks(&ctx);
    if (rc != 0)
        goto cleanup;
    cbm_log_info("pass.timing", "pass", "httplinks", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
    if (check_cancel(p)) {
        rc = -1;
        goto cleanup;
    }

    /* Phase 4: Dump to SQLite */
    clock_gettime(CLOCK_MONOTONIC, &t);
    if (p->db_path) {
        p->store = cbm_store_open_path(p->db_path);
    } else {
        p->store = cbm_store_open(p->project_name);
    }
    if (!p->store) {
        cbm_log_error("pipeline.err", "phase", "store_open");
        rc = -1;
        goto cleanup;
    }

    rc = cbm_gbuf_flush_to_store(p->gbuf, p->store);
    if (rc != 0) {
        cbm_log_error("pipeline.err", "phase", "flush");
        goto cleanup;
    }
    cbm_store_checkpoint(p->store);
    cbm_log_info("pass.timing", "pass", "dump", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));

    /* Post-flush passes (operate on store, not graph buffer) */
    if (!check_cancel(p)) {
        clock_gettime(CLOCK_MONOTONIC, &t);
        cbm_pipeline_pass_decorator_tags(p->store, p->project_name);
        cbm_log_info("pass.timing", "pass", "decorator_tags", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));
    }

    if (!check_cancel(p)) {
        clock_gettime(CLOCK_MONOTONIC, &t);
        cbm_pipeline_pass_configlink(p->store, p->project_name, p->repo_path);
        cbm_log_info("pass.timing", "pass", "configlink", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));
    }

    cbm_log_info("pipeline.done", "nodes", itoa_buf(cbm_gbuf_node_count(p->gbuf)), "edges",
                 itoa_buf(cbm_gbuf_edge_count(p->gbuf)), "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t0)));

cleanup:
    cbm_discover_free(files, file_count);
    cbm_gbuf_free(p->gbuf);
    p->gbuf = NULL;
    cbm_registry_free(p->registry);
    p->registry = NULL;
    if (p->store) {
        cbm_store_close(p->store);
        p->store = NULL;
    }
    return rc;
}

/*
 * pipeline_incremental.c — Disk-based incremental re-indexing.
 *
 * Operates on the existing SQLite DB directly (not RAM-first graph buffer).
 * Compares file mtime+size against stored hashes to classify changed/unchanged.
 * Deletes changed files' nodes (edges cascade via ON DELETE CASCADE),
 * re-parses only changed files through passes into a temp graph buffer,
 * then merges new nodes/edges into the disk DB. Persists updated hashes.
 *
 * Called from pipeline.c when a DB with stored hashes already exists.
 */
#include "foundation/constants.h"

enum { INCR_RING_BUF = 4, INCR_RING_MASK = 3, INCR_TS_BUF = 24, INCR_WAL_BUF = 1040 };
#include "pipeline/pipeline.h"
#include <stdio.h>
#include <time.h>
#include "pipeline/pipeline_internal.h"
#include "store/store.h"
#include "graph_buffer/graph_buffer.h"
#include "discover/discover.h"
#include "foundation/log.h"
#include "foundation/hash_table.h"
#include "foundation/compat.h"
#include "foundation/compat_fs.h"
#include "foundation/platform.h"

#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <stdatomic.h>
#include <stdint.h>

/* ── Constants ───────────────────────────────────────────────────── */

#define CTX_MS_PER_SEC 1000.0
#define CTX_NS_PER_MS 1000000.0
#define CTX_NS_PER_SEC 1000000000LL

/* ── Timing helper (same as pipeline.c) ──────────────────────────── */

static double elapsed_ms(struct timespec start) {
    struct timespec now;
    ctx_clock_gettime(CLOCK_MONOTONIC, &now);
    double s = (double)(now.tv_sec - start.tv_sec);
    double ns = (double)(now.tv_nsec - start.tv_nsec);
    return (s * CTX_MS_PER_SEC) + (ns / CTX_NS_PER_MS);
}

/* itoa into static buffer — matches pipeline.c helper */
static const char *itoa_buf(int v) {
    static _Thread_local char buf[INCR_RING_BUF][INCR_TS_BUF];
    static _Thread_local int idx = 0;
    idx = (idx + SKIP_ONE) & INCR_RING_MASK;
    snprintf(buf[idx], sizeof(buf[idx]), "%d", v);
    return buf[idx];
}

/* ── Platform-portable mtime_ns ──────────────────────────────────── */

static int64_t stat_mtime_ns(const struct stat *st) {
#ifdef __APPLE__
    return ((int64_t)st->st_mtimespec.tv_sec * CTX_NS_PER_SEC) + (int64_t)st->st_mtimespec.tv_nsec;
#elif defined(_WIN32)
    return (int64_t)st->st_mtime * CTX_NS_PER_SEC;
#else
    return ((int64_t)st->st_mtim.tv_sec * CTX_NS_PER_SEC) + (int64_t)st->st_mtim.tv_nsec;
#endif
}

/* ── File classification ─────────────────────────────────────────── */

/* Classify discovered files against stored hashes using mtime+size.
 * Returns a boolean array: changed[i] = true if files[i] needs re-parsing.
 * Caller must free the returned array. */
static bool *classify_files(ctx_file_info_t *files, int file_count, ctx_file_hash_t *stored,
                            int stored_count, int *out_changed, int *out_unchanged) {
    bool *changed = calloc((size_t)file_count, sizeof(bool));
    if (!changed) {
        return NULL;
    }

    int n_changed = 0;
    int n_unchanged = 0;

    /* Build lookup: rel_path -> stored hash */
    CtxHashTable *ht =
        ctx_ht_create(stored_count > 0 ? (size_t)stored_count * PAIR_LEN : CTX_SZ_64);
    for (int i = 0; i < stored_count; i++) {
        ctx_ht_set(ht, stored[i].rel_path, &stored[i]);
    }

    for (int i = 0; i < file_count; i++) {
        ctx_file_hash_t *h = ctx_ht_get(ht, files[i].rel_path);
        if (!h) {
            /* New file */
            changed[i] = true;
            n_changed++;
            continue;
        }

        struct stat st;
        if (stat(files[i].path, &st) != 0) {
            changed[i] = true;
            n_changed++;
            continue;
        }

        if (stat_mtime_ns(&st) != h->mtime_ns || st.st_size != h->size) {
            changed[i] = true;
            n_changed++;
        } else {
            n_unchanged++;
        }
    }

    ctx_ht_free(ht);
    *out_changed = n_changed;
    *out_unchanged = n_unchanged;
    return changed;
}

/* Find stored files that no longer exist on disk. Returns count. */
static int find_deleted_files(ctx_file_info_t *files, int file_count, ctx_file_hash_t *stored,
                              int stored_count, char ***out_deleted) {
    CtxHashTable *current = ctx_ht_create((size_t)file_count * PAIR_LEN);
    for (int i = 0; i < file_count; i++) {
        ctx_ht_set(current, files[i].rel_path, &files[i]);
    }

    int count = 0;
    int cap = CTX_SZ_64;
    char **deleted = malloc((size_t)cap * sizeof(char *));

    for (int i = 0; i < stored_count; i++) {
        if (!ctx_ht_get(current, stored[i].rel_path)) {
            if (count >= cap) {
                cap *= PAIR_LEN;
                char **tmp = realloc(deleted, (size_t)cap * sizeof(char *));
                if (!tmp) {
                    break;
                }
                deleted = tmp;
            }
            deleted[count++] = strdup(stored[i].rel_path);
        }
    }

    ctx_ht_free(current);
    *out_deleted = deleted;
    return count;
}

/* ── Persist file hashes ─────────────────────────────────────────── */

static void persist_hashes(ctx_store_t *store, const char *project, ctx_file_info_t *files,
                           int file_count) {
    for (int i = 0; i < file_count; i++) {
        struct stat st;
        if (stat(files[i].path, &st) != 0) {
            continue;
        }
        ctx_store_upsert_file_hash(store, project, files[i].rel_path, "", stat_mtime_ns(&st),
                                   st.st_size);
    }
}

/* ── Registry seed visitor ────────────────────────────────────────── */

/* Callback for ctx_gbuf_foreach_node: add each node to the registry
 * so the resolver can find cross-file symbols during incremental. */
static void registry_visitor(const ctx_gbuf_node_t *node, void *userdata) {
    ctx_registry_t *r = (ctx_registry_t *)userdata;
    ctx_registry_add(r, node->name, node->qualified_name, node->label);
}

/* Run parallel or sequential extract+resolve for changed files. */
static void run_extract_resolve(ctx_pipeline_ctx_t *ctx, ctx_file_info_t *changed_files, int ci) {
    struct timespec t;

#define MIN_FILES_FOR_PARALLEL_INCR 50
    int worker_count = ctx_default_worker_count(true);
    bool use_parallel = (worker_count > SKIP_ONE && ci > MIN_FILES_FOR_PARALLEL_INCR);

    if (use_parallel) {
        ctx_log_info("incremental.mode", "mode", "parallel", "workers", itoa_buf(worker_count),
                     "changed", itoa_buf(ci));

        _Atomic int64_t shared_ids;
        atomic_init(&shared_ids, ctx_gbuf_next_id(ctx->gbuf));

        CtxFileResult **cache = (CtxFileResult **)calloc(ci, sizeof(CtxFileResult *));
        if (cache) {
            ctx_clock_gettime(CLOCK_MONOTONIC, &t);
            ctx_parallel_extract(ctx, changed_files, ci, cache, &shared_ids, worker_count);
            ctx_gbuf_set_next_id(ctx->gbuf, atomic_load(&shared_ids));
            ctx_log_info("pass.timing", "pass", "incr_extract", "elapsed_ms",
                         itoa_buf((int)elapsed_ms(t)));

            ctx_clock_gettime(CLOCK_MONOTONIC, &t);
            ctx_build_registry_from_cache(ctx, changed_files, ci, cache);
            ctx_log_info("pass.timing", "pass", "incr_registry", "elapsed_ms",
                         itoa_buf((int)elapsed_ms(t)));

            ctx_clock_gettime(CLOCK_MONOTONIC, &t);
            ctx_parallel_resolve(ctx, changed_files, ci, cache, &shared_ids, worker_count);
            ctx_gbuf_set_next_id(ctx->gbuf, atomic_load(&shared_ids));
            ctx_log_info("pass.timing", "pass", "incr_resolve", "elapsed_ms",
                         itoa_buf((int)elapsed_ms(t)));

            for (int j = 0; j < ci; j++) {
                if (cache[j]) {
                    ctx_free_result(cache[j]);
                }
            }
            free(cache);
        }
    } else {
        ctx_log_info("incremental.mode", "mode", "sequential", "changed", itoa_buf(ci));
        ctx_pipeline_pass_definitions(ctx, changed_files, ci);
        ctx_pipeline_pass_calls(ctx, changed_files, ci);
        ctx_pipeline_pass_usages(ctx, changed_files, ci);
        ctx_pipeline_pass_semantic(ctx, changed_files, ci);
    }
}

/* Run post-extraction passes (tests, decorator tags, configlink). */
static void run_postpasses(ctx_pipeline_ctx_t *ctx, ctx_file_info_t *changed_files, int ci,
                           const char *project) {
    struct timespec t;

    ctx_clock_gettime(CLOCK_MONOTONIC, &t);
    ctx_pipeline_pass_tests(ctx, changed_files, ci);
    ctx_log_info("pass.timing", "pass", "incr_tests", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));

    ctx_clock_gettime(CLOCK_MONOTONIC, &t);
    ctx_pipeline_pass_decorator_tags(ctx->gbuf, project);
    ctx_log_info("pass.timing", "pass", "incr_decorator_tags", "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t)));

    ctx_clock_gettime(CLOCK_MONOTONIC, &t);
    ctx_pipeline_pass_configlink(ctx);
    ctx_log_info("pass.timing", "pass", "incr_configlink", "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t)));

    /* SIMILAR_TO + SEMANTICALLY_RELATED edges only in moderate/full modes */
    if (ctx->mode <= CTX_MODE_MODERATE) {
        ctx_clock_gettime(CLOCK_MONOTONIC, &t);
        ctx_pipeline_pass_similarity(ctx);
        ctx_log_info("pass.timing", "pass", "incr_similarity", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));

        ctx_clock_gettime(CLOCK_MONOTONIC, &t);
        ctx_pipeline_pass_semantic_edges(ctx);
        ctx_log_info("pass.timing", "pass", "incr_semantic_edges", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));
    }
}
/* Delete old DB and dump merged graph + hashes to disk. */
static void dump_and_persist(ctx_gbuf_t *gbuf, const char *db_path, const char *project,
                             ctx_file_info_t *files, int file_count) {
    struct timespec t;
    ctx_clock_gettime(CLOCK_MONOTONIC, &t);

    ctx_unlink(db_path);
    char wal[INCR_WAL_BUF];
    char shm[INCR_WAL_BUF];
    snprintf(wal, sizeof(wal), "%s-wal", db_path);
    snprintf(shm, sizeof(shm), "%s-shm", db_path);
    ctx_unlink(wal);
    ctx_unlink(shm);

    int dump_rc = ctx_gbuf_dump_to_sqlite(gbuf, db_path);
    ctx_log_info("incremental.dump", "rc", itoa_buf(dump_rc), "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t)));

    ctx_store_t *hash_store = ctx_store_open_path(db_path);
    if (hash_store) {
        persist_hashes(hash_store, project, files, file_count);

        /* FTS5 rebuild after incremental dump.  The btree dump path bypasses
         * any triggers that could have kept nodes_fts synchronized, so we
         * rebuild from the nodes table here.  See the full-dump path in
         * pipeline.c for the matching logic. */
        ctx_store_exec(hash_store, "INSERT INTO ctx_nodes_fts(ctx_nodes_fts) VALUES('delete-all');");
        if (ctx_store_exec(hash_store,
                           "INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) "
                           "SELECT CAST(SUBSTR(id, 5) AS INTEGER), ctx_camel_split(name), "
                           "qualified_name, kind, file_path "
                           "FROM nodes WHERE project IS NOT NULL;") != CTX_STORE_OK) {
            ctx_store_exec(hash_store,
                           "INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) "
                           "SELECT CAST(SUBSTR(id, 5) AS INTEGER), name, qualified_name, kind, "
                           "file_path FROM nodes WHERE project IS NOT NULL;");
        }

        ctx_store_close(hash_store);
    }
}

/* ── Incremental pipeline entry point ────────────────────────────── */

int ctx_pipeline_run_incremental(ctx_pipeline_t *p, const char *db_path, ctx_file_info_t *files,
                                 int file_count) {
    struct timespec t0;
    ctx_clock_gettime(CLOCK_MONOTONIC, &t0);

    const char *project = ctx_pipeline_project_name(p);

    /* Open existing disk DB */
    ctx_store_t *store = ctx_store_open_path(db_path);
    if (!store) {
        ctx_log_error("incremental.err", "msg", "open_db_failed", "path", db_path);
        return CTX_NOT_FOUND;
    }

    /* Load stored file hashes */
    ctx_file_hash_t *stored = NULL;
    int stored_count = 0;
    ctx_store_get_file_hashes(store, project, &stored, &stored_count);

    /* Classify files */
    int n_changed = 0;
    int n_unchanged = 0;
    bool *is_changed =
        classify_files(files, file_count, stored, stored_count, &n_changed, &n_unchanged);

    /* Find deleted files */
    char **deleted = NULL;
    int deleted_count = find_deleted_files(files, file_count, stored, stored_count, &deleted);

    ctx_log_info("incremental.classify", "changed", itoa_buf(n_changed), "unchanged",
                 itoa_buf(n_unchanged), "deleted", itoa_buf(deleted_count));

    /* Fast path: nothing changed → skip */
    if (n_changed == 0 && deleted_count == 0) {
        ctx_log_info("incremental.noop", "reason", "no_changes");
        free(is_changed);
        free(deleted);
        ctx_store_free_file_hashes(stored, stored_count);
        ctx_store_close(store);
        return 0;
    }

    ctx_store_free_file_hashes(stored, stored_count);

    /* Build list of changed files */
    ctx_file_info_t *changed_files =
        (n_changed > 0) ? malloc((size_t)n_changed * sizeof(ctx_file_info_t)) : NULL;
    int ci = 0;
    for (int i = 0; i < file_count; i++) {
        if (is_changed[i]) {
            changed_files[ci++] = files[i];
        }
    }
    free(is_changed);

    ctx_log_info("incremental.reparse", "files", itoa_buf(ci));

    struct timespec t;

    /* Step 1: Load existing graph into RAM */
    ctx_clock_gettime(CLOCK_MONOTONIC, &t);
    ctx_gbuf_t *existing = ctx_gbuf_new(project, ctx_pipeline_repo_path(p));
    int load_rc = ctx_gbuf_load_from_db(existing, db_path, project);
    ctx_log_info("incremental.load_db", "rc", itoa_buf(load_rc), "nodes",
                 itoa_buf(ctx_gbuf_node_count(existing)), "edges",
                 itoa_buf(ctx_gbuf_edge_count(existing)), "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t)));

    if (load_rc != 0) {
        ctx_log_error("incremental.err", "msg", "load_db_failed");
        ctx_gbuf_free(existing);
        free(changed_files);
        for (int i = 0; i < deleted_count; i++) {
            free(deleted[i]);
        }
        free(deleted);
        ctx_store_close(store);
        return CTX_NOT_FOUND;
    }

    ctx_store_close(store);

    /* Step 2: Purge stale nodes */
    ctx_clock_gettime(CLOCK_MONOTONIC, &t);
    for (int i = 0; i < ci; i++) {
        ctx_gbuf_delete_by_file(existing, changed_files[i].rel_path);
    }
    for (int i = 0; i < deleted_count; i++) {
        ctx_gbuf_delete_by_file(existing, deleted[i]);
        free(deleted[i]);
    }
    free(deleted);
    ctx_log_info("incremental.purge", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));

    /* Step 3-5: Registry + extract + resolve */
    ctx_registry_t *registry = ctx_registry_new();
    ctx_clock_gettime(CLOCK_MONOTONIC, &t);
    ctx_gbuf_foreach_node(existing, registry_visitor, registry);
    ctx_log_info("incremental.registry_seed", "symbols", itoa_buf(ctx_registry_size(registry)),
                 "elapsed_ms", itoa_buf((int)elapsed_ms(t)));

    ctx_pipeline_ctx_t ctx = {
        .project_name = project,
        .repo_path = ctx_pipeline_repo_path(p),
        .gbuf = existing,
        .registry = registry,
        .cancelled = ctx_pipeline_cancelled_ptr(p),
        .mode = ctx_pipeline_get_mode(p),
    };

    for (int i = 0; i < ci; i++) {
        char *file_qn = ctx_pipeline_fqn_compute(project, changed_files[i].rel_path, "__file__");
        if (file_qn) {
            ctx_gbuf_upsert_node(existing, "File", changed_files[i].rel_path, file_qn,
                                 changed_files[i].rel_path, 0, 0, "{}");
            free(file_qn);
        }
    }

    run_extract_resolve(&ctx, changed_files, ci);
    ctx_pipeline_pass_k8s(&ctx, changed_files, ci);
    run_postpasses(&ctx, changed_files, ci, project);

    free(changed_files);
    ctx_registry_free(registry);

    /* Step 7: Dump to disk */
    dump_and_persist(existing, db_path, project, files, file_count);
    ctx_gbuf_free(existing);

    ctx_log_info("incremental.done", "elapsed_ms", itoa_buf((int)elapsed_ms(t0)));
    return 0;
}

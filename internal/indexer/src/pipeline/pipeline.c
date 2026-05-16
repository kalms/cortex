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
#include "foundation/constants.h"

enum { CTX_DIR_PERMS = 0755, PL_RING = 4, PL_RING_MASK = 3, PL_SEQ_PASSES = 5, PL_WAL_BUF = 1040 };
#define PL_NSEC_PER_SEC 1000000000LL
#include "pipeline/pipeline.h"
#include "pipeline/pipeline_internal.h"
#include "pipeline/worker_pool.h"
#include "graph_buffer/graph_buffer.h"
#include "store/store.h"
#include "discover/discover.h"
#include "discover/userconfig.h"
#include "foundation/platform.h"
#include "foundation/compat_fs.h"
#include "foundation/log.h"
#include "foundation/hash_table.h"
#include "foundation/compat.h"
#include "foundation/compat_thread.h"
#include "foundation/profile.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>
#include <sys/stat.h>
#include <time.h>

static inline void *intptr_to_ptr(intptr_t v) {
    void *p;
    memcpy(&p, &v, sizeof(p));
    return p;
}

/* Default max file size (KB) for discover filter. Files above this are skipped.
 * The main offenders are huge generated artifacts (large protobuf headers,
 * minified vendor JS, lockfiles, etc.) that bloat memory with no useful defs.
 * Override at runtime via CTX_MAX_FILE_SIZE_KB; set to 0 for "no limit". */
#define PIPELINE_DEFAULT_MAX_FILE_KB 2048

/* Resolve max file size in bytes from env or use the default.
 * Empty/unparseable → default. "0" → 0 (no limit, preserves prior behavior). */
static size_t resolve_max_file_size(void) {
    char buf[CTX_SZ_32];
    const char *val = ctx_safe_getenv("CTX_MAX_FILE_SIZE_KB", buf, sizeof(buf), NULL);
    long long max_kb = PIPELINE_DEFAULT_MAX_FILE_KB;
    const char *source = "default";
    if (val && val[0]) {
        char *end = NULL;
        long long parsed = strtoll(val, &end, CTX_DECIMAL_BASE);
        if (end && end != val && parsed >= 0) {
            max_kb = parsed;
            source = "env";
        }
    }
    size_t max_bytes = (size_t)max_kb * CTX_SZ_1K;
    char kb_str[CTX_SZ_32];
    snprintf(kb_str, sizeof(kb_str), "%lld", max_kb);
    ctx_log_info("pipeline.max_file_size", "max_kb", kb_str, "source", source);
    return max_bytes;
}

/* ── Global index lock ─────────────────────────────────────────── */
/* Prevents concurrent pipeline runs on the same DB file.
 * Atomic spinlock: 0 = free, 1 = locked. */
static atomic_int g_pipeline_busy = 0;

bool ctx_pipeline_try_lock(void) {
    return atomic_exchange(&g_pipeline_busy, 1) == 0;
}

#define LOCK_SPIN_NS 100000000 /* 100ms between lock retries */

void ctx_pipeline_lock(void) {
    while (atomic_exchange(&g_pipeline_busy, 1) != 0) {
        struct timespec ts = {0, LOCK_SPIN_NS};
        ctx_nanosleep(&ts, NULL);
    }
}

void ctx_pipeline_unlock(void) {
    atomic_store(&g_pipeline_busy, 0);
}

/* ── Internal state ──────────────────────────────────────────────── */

struct ctx_pipeline {
    char *repo_path;
    char *db_path;
    char *project_name;
    ctx_index_mode_t mode;
    atomic_int cancelled;

    /* Indexing state (set during run) */
    ctx_gbuf_t *gbuf;
    ctx_registry_t *registry;

    /* User-defined extension overrides (loaded once per run) */
    ctx_userconfig_t *userconfig;

    /* Error reporting: phase name at which the last run failed,
     * or NULL if no run started or last run succeeded. Owned by
     * the pipeline; freed in ctx_pipeline_free. */
    char *last_error_phase;
};

/* ── Timing helper ──────────────────────────────────────────────── */

static double elapsed_ms(struct timespec start) {
    struct timespec now;
    ctx_clock_gettime(CLOCK_MONOTONIC, &now);
    return ((double)(now.tv_sec - start.tv_sec) * CTX_MS_PER_SEC) +
           ((double)(now.tv_nsec - start.tv_nsec) / CTX_US_PER_SEC_F);
}

/* Format int to string for logging. Thread-safe via TLS rotating buffers. */
static const char *itoa_buf(int val) {
    static CTX_TLS char bufs[PL_RING][CTX_SZ_32];
    static CTX_TLS int idx = 0;
    int i = idx;
    idx = (idx + SKIP_ONE) & PL_RING_MASK;
    snprintf(bufs[i], sizeof(bufs[i]), "%d", val);
    return bufs[i];
}

/* Record the phase at which the pipeline failed. Pass NULL to clear.
 * Frees any prior value. Safe to call with p == NULL (no-op). */
static void set_error_phase(ctx_pipeline_t *p, const char *phase) {
    if (!p) {
        return;
    }
    free(p->last_error_phase);
    p->last_error_phase = phase ? strdup(phase) : NULL;
}

/* ── Lifecycle ──────────────────────────────────────────────────── */

ctx_pipeline_t *ctx_pipeline_new(const char *repo_path, const char *db_path,
                                 ctx_index_mode_t mode) {
    if (!repo_path) {
        return NULL;
    }

    ctx_pipeline_t *p = calloc(CTX_ALLOC_ONE, sizeof(ctx_pipeline_t));
    if (!p) {
        return NULL;
    }

    p->repo_path = strdup(repo_path);
    p->db_path = db_path ? strdup(db_path) : NULL;
    p->project_name = ctx_project_name_from_path(repo_path);
    p->mode = mode;
    atomic_init(&p->cancelled, 0);

    return p;
}

void ctx_pipeline_free(ctx_pipeline_t *p) {
    if (!p) {
        return;
    }
    free(p->repo_path);
    free(p->db_path);
    free(p->project_name);
    free(p->last_error_phase);
    /* gbuf, store, registry freed during/after run */
    /* Defensively free userconfig in case run() was never called or panicked */
    if (p->userconfig) {
        ctx_set_user_lang_config(NULL);
        ctx_userconfig_free(p->userconfig);
        p->userconfig = NULL;
    }
    free(p);
}

void ctx_pipeline_cancel(ctx_pipeline_t *p) {
    if (p) {
        atomic_store(&p->cancelled, 1);
    }
}

const char *ctx_pipeline_project_name(const ctx_pipeline_t *p) {
    return p ? p->project_name : NULL;
}

const char *ctx_pipeline_repo_path(const ctx_pipeline_t *p) {
    return p ? p->repo_path : NULL;
}

atomic_int *ctx_pipeline_cancelled_ptr(ctx_pipeline_t *p) {
    return p ? &p->cancelled : NULL;
}

int ctx_pipeline_get_mode(const ctx_pipeline_t *p) {
    return p ? (int)p->mode : 0;
}

/* Resolve the DB path for this pipeline. Caller must free(). */
static char *resolve_db_path(const ctx_pipeline_t *p) {
    char *path = malloc(CTX_SZ_1K);
    if (!path) {
        return NULL;
    }
    if (p->db_path) {
        snprintf(path, 1024, "%s", p->db_path);
    } else {
        ctx_resolve_db_path(p->project_name, path, 1024);
    }
    return path;
}

static int check_cancel(const ctx_pipeline_t *p) {
    return atomic_load(&p->cancelled) ? CTX_NOT_FOUND : 0;
}

/* ── Hash table cleanup callback ─────────────────────────────────── */

static void free_seen_dir_key(const char *key, void *val, void *ud) {
    (void)val;
    (void)ud;
    free((void *)key);
}

/* ── Pass 1: Structure ──────────────────────────────────────────── */

/* Create Project, Folder/Package, and File nodes in the graph buffer. */
/* Walk directory chain upward, creating Folder nodes and CONTAINS_FOLDER edges. */
static void create_folder_chain(ctx_pipeline_t *p, const char *dir, CtxHashTable *seen_dirs) {
    char *walk = strdup(dir);
    while (walk[0] != '\0' && !ctx_ht_get(seen_dirs, walk)) {
        ctx_ht_set(seen_dirs, strdup(walk), intptr_to_ptr(SKIP_ONE));
        char *folder_qn = ctx_pipeline_fqn_folder(p->project_name, walk);
        const char *dir_base = strrchr(walk, '/');
        dir_base = dir_base ? dir_base + SKIP_ONE : walk;
        ctx_gbuf_upsert_node(p->gbuf, "Folder", dir_base, folder_qn, walk, 0, 0, "{}");

        char *pdir = strdup(walk);
        char *ps = strrchr(pdir, '/');
        if (ps) {
            *ps = '\0';
        } else {
            free(pdir);
            pdir = strdup("");
        }
        const char *pqn;
        char *pqn_heap = NULL;
        if (pdir[0] == '\0') {
            pqn = p->project_name;
        } else {
            pqn_heap = ctx_pipeline_fqn_folder(p->project_name, pdir);
            pqn = pqn_heap;
        }
        const ctx_gbuf_node_t *fn = ctx_gbuf_find_by_qn(p->gbuf, folder_qn);
        const ctx_gbuf_node_t *pn = ctx_gbuf_find_by_qn(p->gbuf, pqn);
        if (fn && pn) {
            ctx_gbuf_insert_edge(p->gbuf, pn->id, fn->id, "CONTAINS_FOLDER", "{}");
        }
        free(folder_qn);
        free(pqn_heap);
        char *up = strrchr(walk, '/');
        if (up) {
            *up = '\0';
        } else {
            walk[0] = '\0';
        }
        free(pdir);
    }
    free(walk);
}

static int pass_structure(ctx_pipeline_t *p, const ctx_file_info_t *files, int file_count) {
    ctx_log_info("pass.start", "pass", "structure", "files", itoa_buf(file_count));

    /* Project node */
    ctx_gbuf_upsert_node(p->gbuf, "Project", p->project_name, p->project_name, NULL, 0, 0, "{}");

    /* Collect unique directories and create Folder/Package nodes */
    CtxHashTable *seen_dirs = ctx_ht_create(CTX_SZ_256);

    for (int i = 0; i < file_count; i++) {
        const char *rel = files[i].rel_path;
        if (!rel) {
            continue;
        }

        /* Create File node */
        char *file_qn = ctx_pipeline_fqn_compute(p->project_name, rel, "__file__");
        /* Extract basename */
        const char *slash = strrchr(rel, '/');
        const char *basename = slash ? slash + SKIP_ONE : rel;

        char props[CTX_SZ_256];
        const char *ext = strrchr(basename, '.');
        snprintf(props, sizeof(props), "{\"extension\":\"%s\"}", ext ? ext : "");

        const char *qualified_name = file_qn;
        const char *file_path = rel;
        ctx_gbuf_upsert_node(p->gbuf, "File", basename, qualified_name, file_path, 0, 0, props);

        /* CONTAINS_FILE edge: parent dir -> file */
        char *dir = strdup(rel);
        char *last_slash = strrchr(dir, '/');
        if (last_slash) {
            {
                *last_slash = '\0';
            }
        } else {
            free(dir);
            dir = strdup("");
        }

        const char *parent_qn;
        char *parent_qn_heap = NULL;
        if (dir[0] == '\0') {
            parent_qn = p->project_name;
        } else {
            parent_qn_heap = ctx_pipeline_fqn_folder(p->project_name, dir);
            parent_qn = parent_qn_heap;
        }

        /* Walk up directory chain, creating Folder nodes */
        create_folder_chain(p, dir, seen_dirs);

        /* Now create the CONTAINS_FILE edge */
        const ctx_gbuf_node_t *fnode = ctx_gbuf_find_by_qn(p->gbuf, file_qn);
        const ctx_gbuf_node_t *pnode = ctx_gbuf_find_by_qn(p->gbuf, parent_qn);
        if (fnode && pnode) {
            ctx_gbuf_insert_edge(p->gbuf, pnode->id, fnode->id, "CONTAINS_FILE", "{}");
        }

        free(file_qn);
        free(dir);
        free(parent_qn_heap);
    }

    /* Free seen_dirs keys */
    ctx_ht_foreach(seen_dirs, free_seen_dir_key, NULL);
    ctx_ht_free(seen_dirs);

    ctx_log_info("pass.done", "pass", "structure", "nodes", itoa_buf(ctx_gbuf_node_count(p->gbuf)),
                 "edges", itoa_buf(ctx_gbuf_edge_count(p->gbuf)));
    return 0;
}

/* ── Pass 2: Definitions ─────────────────────────────────────────── */

/* Implemented in pass_definitions.c via ctx_pipeline_pass_definitions() */

/* ── Githistory compute thread (for fused post-pass parallelism) ─── */

typedef struct {
    const char *repo_path;
    ctx_githistory_result_t *result;
} gh_compute_arg_t;

static void *gh_compute_thread_fn(void *arg) {
    gh_compute_arg_t *a = arg;
    ctx_pipeline_githistory_compute(a->repo_path, a->result);
    return NULL;
}

/* Extract Route nodes from URL strings found in config files (YAML, HCL, TOML).
 * These are infrastructure-defined endpoints (Cloud Scheduler, Terraform). */
/* Process infra bindings: topic→URL pairs from IaC configs.
 * Creates Route nodes for endpoints and HANDLES edges linking
 * topic Routes to endpoint Routes (bridging the gap). */
/* Process one infra binding: create Route node + INFRA_MAPS edge. */
static int process_one_infra_binding(ctx_gbuf_t *gbuf, const CtxInfraBinding *ib,
                                     const char *rel_path) {
    char url_route_qn[CTX_ROUTE_QN_SIZE];
    snprintf(url_route_qn, sizeof(url_route_qn), "__route__infra__%s", ib->target_url);
    int64_t url_route_id = ctx_gbuf_upsert_node(gbuf, "Route", ib->target_url, url_route_qn,
                                                rel_path, 0, 0, "{\"source\":\"infra\"}");
    char topic_route_qn[CTX_ROUTE_QN_SIZE];
    snprintf(topic_route_qn, sizeof(topic_route_qn), "__route__%s__%s",
             ib->broker ? ib->broker : "async", ib->source_name);
    const ctx_gbuf_node_t *topic_route = ctx_gbuf_find_by_qn(gbuf, topic_route_qn);
    if (!topic_route) {
        return 0;
    }
    char props[CTX_SZ_512];
    snprintf(props, sizeof(props), "{\"broker\":\"%s\",\"topic\":\"%s\",\"endpoint\":\"%s\"}",
             ib->broker ? ib->broker : "async", ib->source_name, ib->target_url);
    ctx_gbuf_insert_edge(gbuf, topic_route->id, url_route_id, "INFRA_MAPS", props);
    return SKIP_ONE;
}

static void ctx_pipeline_process_infra_bindings(ctx_gbuf_t *gbuf, const ctx_file_info_t *files,
                                                CtxFileResult **result_cache, int file_count) {
    int bindings = 0;
    for (int i = 0; i < file_count; i++) {
        if (!result_cache[i]) {
            continue;
        }
        for (int bi = 0; bi < result_cache[i]->infra_bindings.count; bi++) {
            const CtxInfraBinding *ib = &result_cache[i]->infra_bindings.items[bi];
            if (ib->source_name && ib->target_url) {
                bindings += process_one_infra_binding(gbuf, ib, files[i].rel_path);
            }
        }
    }
    if (bindings > 0) {
        char buf[CTX_SZ_16];
        snprintf(buf, sizeof(buf), "%d", bindings);
        ctx_log_info("pass.infra_bindings", "linked", buf);
    }
}

static bool is_infra_file(const char *fp) {
    return fp != NULL &&
           (strstr(fp, ".yaml") != NULL || strstr(fp, ".yml") != NULL ||
            strstr(fp, ".tf") != NULL || strstr(fp, ".hcl") != NULL || strstr(fp, ".toml") != NULL);
}

/* Try to create an infra Route node from one string_ref. */
static void try_upsert_infra_route(ctx_gbuf_t *gbuf, const CtxStringRef *sr, const char *fp) {
    if (sr->kind != CTX_STRREF_URL || !sr->value || !strstr(sr->value, "://")) {
        return;
    }
    char route_qn[CTX_ROUTE_QN_SIZE];
    snprintf(route_qn, sizeof(route_qn), "__route__infra__%s", sr->value);
    char route_props[CTX_SZ_512];
    if (sr->key_path) {
        snprintf(route_props, sizeof(route_props), "{\"source\":\"infra\",\"key_path\":\"%s\"}",
                 sr->key_path);
    } else {
        snprintf(route_props, sizeof(route_props), "{\"source\":\"infra\"}");
    }
    ctx_gbuf_upsert_node(gbuf, "Route", sr->value, route_qn, fp, 0, 0, route_props);
}

static void ctx_pipeline_extract_infra_routes(ctx_gbuf_t *gbuf, const ctx_file_info_t *files,
                                              CtxFileResult **result_cache, int file_count) {
    for (int i = 0; i < file_count; i++) {
        if (!result_cache[i] || !is_infra_file(files[i].rel_path)) {
            continue;
        }
        for (int si = 0; si < result_cache[i]->string_refs.count; si++) {
            try_upsert_infra_route(gbuf, &result_cache[i]->string_refs.items[si],
                                   files[i].rel_path);
        }
    }
}

/* Run decorator_tags, configlink, and route matching passes. */
typedef void (*predump_pass_fn)(ctx_pipeline_ctx_t *);
static void predump_deco(ctx_pipeline_ctx_t *ctx) {
    ctx_pipeline_pass_decorator_tags(ctx->gbuf, ctx->project_name);
}
static void predump_route(ctx_pipeline_ctx_t *ctx) {
    ctx_pipeline_create_route_nodes(ctx->gbuf);
}
static void predump_sim(ctx_pipeline_ctx_t *ctx) {
    ctx_pipeline_pass_similarity(ctx);
}
static void predump_sem(ctx_pipeline_ctx_t *ctx) {
    ctx_pipeline_pass_semantic_edges(ctx);
}
static void predump_cfg(ctx_pipeline_ctx_t *ctx) {
    ctx_pipeline_pass_configlink(ctx);
}

static void run_predump_passes(ctx_pipeline_t *p, ctx_pipeline_ctx_t *ctx) {
    static const struct {
        predump_pass_fn fn;
        const char *name;
        bool moderate_only; /* true = skip in fast mode */
    } passes[] = {
        {predump_deco, "decorator_tags", false}, {predump_cfg, "configlink", false},
        {predump_route, "route_match", false},   {predump_sim, "similarity", true},
        {predump_sem, "semantic_edges", true},
    };
    enum { PREDUMP_PASS_COUNT = 5 };
    struct timespec t;
    for (int i = 0; i < PREDUMP_PASS_COUNT && !check_cancel(p); i++) {
        if (passes[i].moderate_only && p->mode > CTX_MODE_MODERATE) {
            continue;
        }
        ctx_clock_gettime(CLOCK_MONOTONIC, &t);
        passes[i].fn(ctx);
        ctx_log_info("pass.timing", "pass", passes[i].name, "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t)));
    }
}

/* Run the sequential pipeline path: definitions, k8s, calls, usages, semantic. */
static int run_sequential_pipeline(ctx_pipeline_t *p, ctx_pipeline_ctx_t *ctx,
                                   const ctx_file_info_t *files, int file_count,
                                   struct timespec *t) {
    ctx_log_info("pipeline.mode", "mode", "sequential", "files", itoa_buf(file_count));
    CtxFileResult **seq_cache = (CtxFileResult **)calloc(file_count, sizeof(CtxFileResult *));
    if (seq_cache) {
        ctx->result_cache = seq_cache;
    }
    typedef int (*seq_pass_fn)(ctx_pipeline_ctx_t *, const ctx_file_info_t *, int);
    static const struct {
        seq_pass_fn fn;
        const char *name;
        bool ignore_err;
    } seq_passes[] = {
        {ctx_pipeline_pass_definitions, "definitions", false},
        {ctx_pipeline_pass_k8s, "k8s", true},
        {ctx_pipeline_pass_calls, "calls", false},
        {ctx_pipeline_pass_usages, "usages", false},
        {ctx_pipeline_pass_semantic, "semantic", false},
    };
    int rc = 0;
    for (int si = 0; si < PL_SEQ_PASSES && rc == 0; si++) {
        ctx_clock_gettime(CLOCK_MONOTONIC, t);
        int pr = seq_passes[si].fn(ctx, files, file_count);
        if (pr != 0 && !seq_passes[si].ignore_err) {
            rc = pr;
        }
        ctx_log_info("pass.timing", "pass", seq_passes[si].name, "elapsed_ms",
                     itoa_buf((int)elapsed_ms(*t)));
        if (check_cancel(p)) {
            rc = CTX_NOT_FOUND;
        }
    }
    if (seq_cache) {
        for (int i = 0; i < file_count; i++) {
            if (seq_cache[i]) {
                ctx_free_result(seq_cache[i]);
            }
        }
        free(seq_cache);
        ctx->result_cache = NULL;
    }
    return rc;
}

/* Run the parallel pipeline path: extract, registry, resolve, infra, k8s. */
static int run_parallel_pipeline(ctx_pipeline_t *p, ctx_pipeline_ctx_t *ctx,
                                 const ctx_file_info_t *files, int file_count, int worker_count,
                                 struct timespec *t) {
    ctx_log_info("pipeline.mode", "mode", "parallel", "workers", itoa_buf(worker_count), "files",
                 itoa_buf(file_count));
    _Atomic int64_t shared_ids;
    atomic_init(&shared_ids, ctx_gbuf_next_id(p->gbuf));
    CtxFileResult **cache = (CtxFileResult **)calloc(file_count, sizeof(CtxFileResult *));
    if (!cache) {
        set_error_phase(p, "cache_alloc");
        ctx_log_error("pipeline.err", "phase", "cache_alloc");
        return CTX_NOT_FOUND;
    }
    ctx_clock_gettime(CLOCK_MONOTONIC, t);
    int rc = ctx_parallel_extract(ctx, files, file_count, cache, &shared_ids, worker_count);
    ctx_log_info("pass.timing", "pass", "parallel_extract", "elapsed_ms",
                 itoa_buf((int)elapsed_ms(*t)));
    if (rc != 0 || check_cancel(p)) {
        free(cache);
        return rc != 0 ? rc : CTX_NOT_FOUND;
    }
    ctx_gbuf_set_next_id(p->gbuf, atomic_load(&shared_ids));
    ctx_clock_gettime(CLOCK_MONOTONIC, t);
    rc = ctx_build_registry_from_cache(ctx, files, file_count, cache);
    ctx_log_info("pass.timing", "pass", "registry_build", "elapsed_ms",
                 itoa_buf((int)elapsed_ms(*t)));
    if (rc != 0 || check_cancel(p)) {
        for (int i = 0; i < file_count; i++) {
            if (cache[i]) {
                ctx_free_result(cache[i]);
            }
        }
        free(cache);
        return rc != 0 ? rc : CTX_NOT_FOUND;
    }
    ctx_clock_gettime(CLOCK_MONOTONIC, t);
    rc = ctx_parallel_resolve(ctx, files, file_count, cache, &shared_ids, worker_count);
    ctx_log_info("pass.timing", "pass", "parallel_resolve", "elapsed_ms",
                 itoa_buf((int)elapsed_ms(*t)));
    ctx_gbuf_set_next_id(p->gbuf, atomic_load(&shared_ids));
    ctx_pipeline_extract_infra_routes(p->gbuf, files, cache, file_count);
    ctx_pipeline_process_infra_bindings(p->gbuf, files, cache, file_count);
    for (int i = 0; i < file_count; i++) {
        if (cache[i]) {
            ctx_free_result(cache[i]);
        }
    }
    free(cache);
    if (rc != 0) {
        return rc;
    }
    ctx_clock_gettime(CLOCK_MONOTONIC, t);
    ctx_pipeline_pass_k8s(ctx, files, file_count);
    ctx_log_info("pass.timing", "pass", "k8s", "elapsed_ms", itoa_buf((int)elapsed_ms(*t)));
    return check_cancel(p) ? CTX_NOT_FOUND : 0;
}

/* Try incremental pipeline or delete old DB for reindex.
 * Returns >= 0 if incremental was used (the return code), or -1 to proceed with full. */
static int try_incremental_or_delete_db(ctx_pipeline_t *p, ctx_file_info_t *files, int file_count) {
    char *db_path = resolve_db_path(p);
    if (!db_path) {
        return CTX_NOT_FOUND;
    }
    struct stat db_st;
    if (stat(db_path, &db_st) != 0) {
        free(db_path);
        return CTX_NOT_FOUND;
    }
    ctx_store_t *check_store = ctx_store_open_path(db_path);
    if (check_store && ctx_store_check_integrity(check_store)) {
        ctx_file_hash_t *hashes = NULL;
        int hash_count = 0;
        ctx_store_get_file_hashes(check_store, p->project_name, &hashes, &hash_count);
        ctx_store_free_file_hashes(hashes, hash_count);
        ctx_store_close(check_store);
        if (hash_count > 0 && file_count <= hash_count + (hash_count / PAIR_LEN)) {
            ctx_log_info("pipeline.route", "path", "incremental", "stored_hashes",
                         itoa_buf(hash_count));
            int rc = ctx_pipeline_run_incremental(p, db_path, files, file_count);
            free(db_path);
            return rc;
        }
        if (hash_count > 0) {
            ctx_log_info("pipeline.route", "path", "mode_change_reindex", "stored_hashes",
                         itoa_buf(hash_count), "discovered", itoa_buf(file_count));
        }
    } else if (check_store) {
        ctx_store_close(check_store);
    }
    ctx_log_info("pipeline.route", "path", "reindex", "action", "deleting old db");
    ctx_unlink(db_path);
    char wal[PL_WAL_BUF];
    char shm[PL_WAL_BUF];
    snprintf(wal, sizeof(wal), "%s-wal", db_path);
    snprintf(shm, sizeof(shm), "%s-shm", db_path);
    ctx_unlink(wal);
    ctx_unlink(shm);
    free(db_path);
    return CTX_NOT_FOUND;
}

/* Get platform-specific mtime in nanoseconds. */
static int64_t stat_mtime_ns(const struct stat *fst) {
#ifdef __APPLE__
    return ((int64_t)fst->st_mtimespec.tv_sec * PL_NSEC_PER_SEC) +
           (int64_t)fst->st_mtimespec.tv_nsec;
#elif defined(_WIN32)
    return (int64_t)fst->st_mtime * 1000000000LL;
#else
    return ((int64_t)fst->st_mtim.tv_sec * PL_NSEC_PER_SEC) + (int64_t)fst->st_mtim.tv_nsec;
#endif
}

/* Dump graph to SQLite and persist file hashes for incremental indexing. */
static int dump_and_persist_hashes(ctx_pipeline_t *p, const ctx_file_info_t *files, int file_count,
                                   struct timespec *t) {
    ctx_clock_gettime(CLOCK_MONOTONIC, t);
    char db_path[CTX_SZ_1K];
    if (p->db_path) {
        snprintf(db_path, sizeof(db_path), "%s", p->db_path);
    } else {
        ctx_resolve_db_path(p->project_name, db_path, sizeof(db_path));
    }
    char db_dir[CTX_SZ_1K];
    snprintf(db_dir, sizeof(db_dir), "%s", db_path);
    char *last_slash = strrchr(db_dir, '/');
    if (last_slash) {
        *last_slash = '\0';
        ctx_mkdir_p(db_dir, CTX_DIR_PERMS);
    }
    int rc = ctx_gbuf_dump_to_sqlite(p->gbuf, db_path);
    if (rc != 0) {
        set_error_phase(p, "dump");
        ctx_log_error("pipeline.err", "phase", "dump");
        return rc;
    }
    ctx_log_info("pass.timing", "pass", "dump", "elapsed_ms", itoa_buf((int)elapsed_ms(*t)));
    ctx_store_t *hash_store = ctx_store_open_path(db_path);
    if (hash_store) {
        ctx_store_delete_file_hashes(hash_store, p->project_name);
        for (int i = 0; i < file_count; i++) {
            struct stat fst;
            if (stat(files[i].path, &fst) == 0) {
                ctx_store_upsert_file_hash(hash_store, p->project_name, files[i].rel_path, "",
                                           stat_mtime_ns(&fst), fst.st_size);
            }
        }

        /* FTS5 backfill: populate nodes_fts with camelCase-split names.
         * Contentless FTS5 requires the special 'delete-all' command instead of
         * DELETE FROM to wipe prior rows (there's no underlying content table).
         * Falls back to plain names if ctx_camel_split is unavailable (which
         * shouldn't happen because we always register it, but we stay defensive). */
        ctx_store_exec(hash_store, "INSERT INTO ctx_nodes_fts(ctx_nodes_fts) VALUES('delete-all');");
        if (ctx_store_exec(hash_store,
                           "INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) "
                           "SELECT rowid, ctx_camel_split(name), "
                           "qualified_name, kind, file_path "
                           "FROM nodes WHERE project IS NOT NULL;") != CTX_STORE_OK) {
            ctx_store_exec(hash_store,
                           "INSERT INTO ctx_nodes_fts(rowid, name, qualified_name, kind, file_path) "
                           "SELECT rowid, name, qualified_name, kind, "
                           "file_path FROM nodes WHERE project IS NOT NULL;");
        }

        ctx_store_close(hash_store);
        ctx_log_info("pass.timing", "pass", "persist_hashes", "files", itoa_buf(file_count));
    }
    return 0;
}

/* Run githistory pass. */
static int run_githistory(ctx_pipeline_t *p, ctx_pipeline_ctx_t *ctx) {
    struct timespec t_gh;
    ctx_clock_gettime(CLOCK_MONOTONIC, &t_gh);

    ctx_githistory_result_t gh_result = {0};
    ctx_thread_t gh_thread;
    bool gh_threaded = false;
    gh_compute_arg_t gh_arg = {.repo_path = ctx->repo_path, .result = &gh_result};

    if (p->mode != CTX_MODE_FAST) {
        if (ctx_default_worker_count(true) > SKIP_ONE) {
            if (ctx_thread_create(&gh_thread, 0, gh_compute_thread_fn, &gh_arg) == 0) {
                gh_threaded = true;
            }
        }
        if (!gh_threaded) {
            ctx_pipeline_githistory_compute(ctx->repo_path, &gh_result);
            ctx_log_info("pass.timing", "pass", "githistory_compute", "elapsed_ms",
                         itoa_buf((int)elapsed_ms(t_gh)));
        }
    } else {
        ctx_log_info("pass.skip", "pass", "githistory", "reason", "fast_mode");
    }

    if (gh_threaded) {
        ctx_thread_join(&gh_thread);
        ctx_log_info("pass.timing", "pass", "githistory_compute", "elapsed_ms",
                     itoa_buf((int)elapsed_ms(t_gh)));
    }

    int gh_edges = 0;
    if (gh_result.count > 0) {
        gh_edges = ctx_pipeline_githistory_apply(ctx, &gh_result);
    }
    ctx_log_info("pass.done", "pass", "githistory", "commits", itoa_buf(gh_result.commit_count),
                 "edges", itoa_buf(gh_edges));
    free(gh_result.couplings);
    return 0;
}

/* ── Pipeline run ────────────────────────────────────────────────── */

/* Run tests + git history. Returns 0 on success. */
static int run_tests_and_history(ctx_pipeline_t *p, ctx_pipeline_ctx_t *ctx,
                                 const ctx_file_info_t *files, int file_count) {
    struct timespec t;
    ctx_clock_gettime(CLOCK_MONOTONIC, &t);
    CTX_PROF_START(t_tests);
    int rc = ctx_pipeline_pass_tests(ctx, files, file_count);
    CTX_PROF_END_N("pipeline", "pass_tests", t_tests, file_count);
    ctx_log_info("pass.timing", "pass", "tests", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
    if (rc == 0 && !check_cancel(p)) {
        CTX_PROF_START(t_gh);
        rc = run_githistory(p, ctx);
        CTX_PROF_END("pipeline", "pass_githistory", t_gh);
    }
    if (check_cancel(p)) {
        return CTX_NOT_FOUND;
    }
    return rc;
}

/* Run tests, git history, predump passes, and dump+persist. */
static int run_post_extraction(ctx_pipeline_t *p, ctx_pipeline_ctx_t *ctx,
                               const ctx_file_info_t *files, int file_count) {
    int rc = run_tests_and_history(p, ctx, files, file_count);
    if (rc != 0) {
        return rc;
    }

    CTX_PROF_START(t_predump);
    run_predump_passes(p, ctx);
    CTX_PROF_END("pipeline", "3_predump_passes_total", t_predump);

    if (!check_cancel(p)) {
        struct timespec t;
        CTX_PROF_START(t_dump);
        rc = dump_and_persist_hashes(p, files, file_count, &t);
        CTX_PROF_END("pipeline", "4_dump_and_persist", t_dump);
    }
    return rc;
}

#define MIN_FILES_FOR_PARALLEL 50

/* Run structure + extraction passes (parallel or sequential). */
static int run_extraction_phase(ctx_pipeline_t *p, ctx_pipeline_ctx_t *ctx,
                                const ctx_file_info_t *files, int file_count) {
    struct timespec t;
    ctx_clock_gettime(CLOCK_MONOTONIC, &t);
    CTX_PROF_START(t_struct);
    pass_structure(p, files, file_count);
    CTX_PROF_END_N("pipeline", "pass_structure", t_struct, file_count);
    ctx_log_info("pass.timing", "pass", "structure", "elapsed_ms", itoa_buf((int)elapsed_ms(t)));
    if (check_cancel(p)) {
        return CTX_NOT_FOUND;
    }

    int worker_count = ctx_default_worker_count(true);
    CTX_PROF_START(t_extract_total);
    int rc = (worker_count > SKIP_ONE && file_count > MIN_FILES_FOR_PARALLEL)
                 ? run_parallel_pipeline(p, ctx, files, file_count, worker_count, &t)
                 : run_sequential_pipeline(p, ctx, files, file_count, &t);
    CTX_PROF_END_N("pipeline", "2_extraction_total", t_extract_total, file_count);
    if (check_cancel(p)) {
        return CTX_NOT_FOUND;
    }
    return rc;
}

int ctx_pipeline_run(ctx_pipeline_t *p) {
    if (!p) {
        return CTX_NOT_FOUND;
    }

    /* Reset prior error state so we report only this run's failure (if any). */
    set_error_phase(p, NULL);

    CTX_PROF_START(t_pipeline_total);
    struct timespec t0;
    ctx_clock_gettime(CLOCK_MONOTONIC, &t0);

    /* Load user-defined extension overrides (fail-open: NULL on error) */
    CTX_PROF_START(t_userconfig);
    p->userconfig = ctx_userconfig_load(p->repo_path);
    ctx_set_user_lang_config(p->userconfig);
    CTX_PROF_END("pipeline", "0_userconfig_load", t_userconfig);

    /* Phase 1: Discover files */
    CTX_PROF_START(t_discover);
    ctx_discover_opts_t opts = {
        .mode = p->mode,
        .ignore_file = NULL,
        .max_file_size = resolve_max_file_size(),
    };
    ctx_file_info_t *files = NULL;
    int file_count = 0;
    int rc = ctx_discover(p->repo_path, &opts, &files, &file_count);
    if (rc != 0) {
        set_error_phase(p, "discover");
        ctx_log_error("pipeline.err", "phase", "discover", "rc", itoa_buf(rc));
    }
    CTX_PROF_END_N("pipeline", "1_discover", t_discover, file_count);
    ctx_log_info("pipeline.discover", "files", itoa_buf(file_count), "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t0)));
    if (rc != 0 || check_cancel(p)) {
        rc = CTX_NOT_FOUND;
        goto cleanup;
    }

    /* Check for existing DB → try incremental or delete for reindex */
    rc = try_incremental_or_delete_db(p, files, file_count);
    if (rc >= 0) {
        ctx_discover_free(files, file_count);
        return rc;
    }
    ctx_log_info("pipeline.route", "path", "full");

    /* Phase 2: Create graph buffer and registry */
    p->gbuf = ctx_gbuf_new(p->project_name, p->repo_path);
    p->registry = ctx_registry_new();

    /* Build shared context for pass functions */
    ctx_pipeline_ctx_t ctx = {
        .project_name = p->project_name,
        .repo_path = p->repo_path,
        .gbuf = p->gbuf,
        .registry = p->registry,
        .cancelled = &p->cancelled,
        .mode = (int)p->mode,
    };

    rc = run_extraction_phase(p, &ctx, files, file_count);
    if (rc != 0) {
        set_error_phase(p, "extraction");
        goto cleanup;
    }

    rc = run_post_extraction(p, &ctx, files, file_count);
    if (rc != 0) {
        set_error_phase(p, "post");
        goto cleanup;
    }

    ctx_log_info("pipeline.done", "nodes", itoa_buf(ctx_gbuf_node_count(p->gbuf)), "edges",
                 itoa_buf(ctx_gbuf_edge_count(p->gbuf)), "elapsed_ms",
                 itoa_buf((int)elapsed_ms(t0)));
    CTX_PROF_END("pipeline", "TOTAL", t_pipeline_total);

cleanup:
    ctx_discover_free(files, file_count);
    ctx_gbuf_free(p->gbuf);
    p->gbuf = NULL;
    ctx_registry_free(p->registry);
    p->registry = NULL;
    /* Clear and free user extension config */
    ctx_set_user_lang_config(NULL);
    ctx_userconfig_free(p->userconfig);
    p->userconfig = NULL;
    return rc;
}

const char *ctx_pipeline_last_error_phase(const ctx_pipeline_t *p) {
    return p ? p->last_error_phase : NULL;
}

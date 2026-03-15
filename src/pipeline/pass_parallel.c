// NOLINTBEGIN(cert-err33-c) — best-effort logging and snprintf truncation
// NOLINTBEGIN(readability-magic-numbers) — buffer sizes, scoring weights, and capacity constants
/*
 * pass_parallel.c — Three-phase parallel pipeline.
 *
 * Phase 3A: Parallel extract + create definition nodes (per-worker gbufs)
 * Phase 3B: Serial registry build + edge creation from cached results
 * Phase 4:  Parallel call/usage/semantic resolution (per-worker edge bufs)
 *
 * Each file is read and parsed ONCE (Phase 3A). The CBMFileResult is cached
 * and reused for resolution (Phase 4), eliminating 3x redundant I/O + parsing.
 *
 * Depends on: worker_pool, graph_buffer (shared IDs + merge), extraction (cbm.h)
 */
#include "pipeline/pipeline.h"
#include "pipeline/pipeline_internal.h"
#include "pipeline/worker_pool.h"
#include "graph_buffer/graph_buffer.h"
// NOLINTNEXTLINE(misc-include-cleaner) — platform.h included for interface contract
#include "foundation/platform.h"
#include "foundation/log.h"
#include "cbm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

/* ── Helpers (duplicated from pass files — kept static for isolation) ── */

static char *read_file(const char *path, int *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        return NULL;
    }
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (size <= 0 || size > (long)100 * 1024 * 1024) {
        fclose(f);
        return NULL;
    }
    char *buf = malloc(size + 1);
    if (!buf) {
        fclose(f);
        return NULL;
    }
    size_t nread = fread(buf, 1, size, f);
    fclose(f);
    // NOLINTNEXTLINE(clang-analyzer-security.ArrayBound)
    buf[nread] = '\0';
    *out_len = (int)nread;
    return buf;
}

static const char *itoa_log(int val) {
    static _Thread_local char bufs[4][32];
    static _Thread_local int idx = 0;
    int i = idx;
    idx = (idx + 1) & 3;
    snprintf(bufs[i], sizeof(bufs[i]), "%d", val);
    return bufs[i];
}

/* Append a JSON-escaped string value to buf at position *pos. */
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
static void append_json_string(char *buf, size_t bufsize, size_t *pos, const char *key,
                               const char *val) {
    if (!val || !val[0]) {
        return;
    }
    if (*pos >= bufsize - 10) {
        return;
    }
    size_t p = *pos;
    int w = snprintf(buf + p, bufsize - p, ",\"%s\":\"", key);
    if (w <= 0 || (size_t)w >= bufsize - p) {
        return;
    }
    p += (size_t)w;
    for (const char *s = val; *s && p < bufsize - 3; s++) {
        switch (*s) {
        case '"':
            buf[p++] = '\\';
            if (p < bufsize - 2) {
                buf[p++] = '"';
            }
            break;
        case '\\':
            buf[p++] = '\\';
            if (p < bufsize - 2) {
                buf[p++] = '\\';
            }
            break;
        case '\n':
            buf[p++] = '\\';
            if (p < bufsize - 2) {
                buf[p++] = 'n';
            }
            break;
        case '\r':
            buf[p++] = '\\';
            if (p < bufsize - 2) {
                buf[p++] = 'r';
            }
            break;
        case '\t':
            buf[p++] = '\\';
            if (p < bufsize - 2) {
                buf[p++] = 't';
            }
            break;
        default:
            buf[p++] = *s;
            break;
        }
    }
    if (p < bufsize - 1) {
        buf[p++] = '"';
    }
    buf[p] = '\0';
    *pos = p;
}

static void build_def_props(char *buf, size_t bufsize, const CBMDefinition *def) {
    int n = snprintf(buf, bufsize,
                     "{\"complexity\":%d,\"lines\":%d,\"is_exported\":%s,"
                     "\"is_test\":%s,\"is_entry_point\":%s",
                     def->complexity, def->lines, def->is_exported ? "true" : "false",
                     def->is_test ? "true" : "false", def->is_entry_point ? "true" : "false");
    if (n <= 0 || (size_t)n >= bufsize) {
        buf[0] = '\0';
        return;
    }
    size_t pos = (size_t)n;
    append_json_string(buf, bufsize, &pos, "docstring", def->docstring);
    append_json_string(buf, bufsize, &pos, "signature", def->signature);
    if (def->decorators && def->decorators[0] && pos < bufsize - 2) {
        const char *prefix = ",\"decorators\":[";
        size_t plen = strlen(prefix);
        if (pos + plen < bufsize) {
            memcpy(buf + pos, prefix, plen);
            pos += plen;
        }
        for (int i = 0; def->decorators[i]; i++) {
            if (i > 0 && pos < bufsize - 1) {
                buf[pos++] = ',';
            }
            if (pos < bufsize - 1) {
                buf[pos++] = '"';
            }
            for (const char *s = def->decorators[i]; *s && pos < bufsize - 2; s++) {
                if (*s == '"' || *s == '\\') {
                    buf[pos++] = '\\';
                    if (pos >= bufsize - 2) {
                        break;
                    }
                }
                buf[pos++] = *s;
            }
            if (pos < bufsize - 1) {
                buf[pos++] = '"';
            }
        }
        if (pos < bufsize - 1) {
            buf[pos++] = ']';
        }
        buf[pos] = '\0';
    }
    if (pos < bufsize - 1) {
        buf[pos] = '}';
        buf[pos + 1] = '\0';
    }
}

/* Build import map from graph buffer IMPORTS edges (read-only access to gbuf). */
static int build_import_map(const cbm_gbuf_t *gbuf, const char *project_name, const char *rel_path,
                            // NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
                            const char ***out_keys, const char ***out_vals, int *out_count) {
    *out_keys = NULL;
    *out_vals = NULL;
    *out_count = 0;

    char *file_qn = cbm_pipeline_fqn_compute(project_name, rel_path, "__file__");
    const cbm_gbuf_node_t *file_node = cbm_gbuf_find_by_qn(gbuf, file_qn);
    free(file_qn);
    if (!file_node) {
        return 0;
    }

    const cbm_gbuf_edge_t **edges = NULL;
    int edge_count = 0;
    int rc =
        cbm_gbuf_find_edges_by_source_type(gbuf, file_node->id, "IMPORTS", &edges, &edge_count);
    if (rc != 0 || edge_count == 0) {
        return 0;
    }

    // NOLINTNEXTLINE(bugprone-multi-level-implicit-pointer-conversion)
    const char **keys = calloc(edge_count, sizeof(const char *));
    // NOLINTNEXTLINE(bugprone-multi-level-implicit-pointer-conversion)
    const char **vals = calloc(edge_count, sizeof(const char *));
    int count = 0;

    for (int i = 0; i < edge_count; i++) {
        const cbm_gbuf_edge_t *e = edges[i];
        const cbm_gbuf_node_t *target = cbm_gbuf_find_by_id(gbuf, e->target_id);
        if (!target || !e->properties_json) {
            continue;
        }
        const char *start = strstr(e->properties_json, "\"local_name\":\"");
        if (start) {
            start += strlen("\"local_name\":\"");
            const char *end = strchr(start, '"');
            if (end && end > start) {
                // NOLINTNEXTLINE(misc-include-cleaner) — strndup provided by standard header
                keys[count] = strndup(start, end - start);
                vals[count] = target->qualified_name;
                count++;
            }
        }
    }

    *out_keys = keys;
    *out_vals = vals;
    *out_count = count;
    return 0;
}

static void free_import_map(const char **keys, const char **vals, int count) {
    if (keys) {
        for (int i = 0; i < count; i++) {
            free((void *)keys[i]);
        }
        free((void *)keys);
    }
    if (vals) {
        free((void *)vals);
    }
}

static bool is_checked_exception(const char *name) {
    if (!name) {
        return false;
    }
    if (strstr(name, "Error") || strstr(name, "Panic") || strstr(name, "error") ||
        strstr(name, "panic")) {
        return false;
    }
    return true;
}

static const char *resolve_as_class(const cbm_registry_t *reg, const char *name,
                                    const char *module_qn, const char **imp_keys,
                                    const char **imp_vals, int imp_count) {
    cbm_resolution_t res =
        cbm_registry_resolve(reg, name, module_qn, imp_keys, imp_vals, imp_count);
    if (!res.qualified_name || res.qualified_name[0] == '\0') {
        return NULL;
    }
    const char *label = cbm_registry_label_of(reg, res.qualified_name);
    if (!label) {
        return NULL;
    }
    if (strcmp(label, "Class") != 0 && strcmp(label, "Interface") != 0 &&
        strcmp(label, "Type") != 0 && strcmp(label, "Enum") != 0) {
        return NULL;
    }
    return res.qualified_name;
}

static void extract_decorator_func(const char *dec, char *out, size_t outsz) {
    out[0] = '\0';
    if (!dec) {
        return;
    }
    const char *start = dec;
    if (*start == '@') {
        start++;
    }
    const char *paren = strchr(start, '(');
    size_t len = paren ? (size_t)(paren - start) : strlen(start);
    if (len == 0 || len >= outsz) {
        return;
    }
    memcpy(out, start, len);
    out[len] = '\0';
}

/* ── File sort for tail-latency reduction ────────────────────────── */

typedef struct {
    int idx;
    // NOLINTNEXTLINE(misc-include-cleaner) — int64_t provided by standard header
    int64_t size;
} file_sort_entry_t;

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
static int compare_by_size_desc(const void *a, const void *b) {
    const file_sort_entry_t *fa = a;
    const file_sort_entry_t *fb = b;
    if (fb->size > fa->size) {
        return 1;
    }
    if (fb->size < fa->size) {
        return -1;
    }
    return 0;
}

/* ── Phase 3A: Parallel Extract ──────────────────────────────────── */

#define CBM_CACHE_LINE 128

typedef struct __attribute__((aligned(CBM_CACHE_LINE))) {
    cbm_gbuf_t *local_gbuf;
    int nodes_created;
    int errors;
    char _pad[CBM_CACHE_LINE - sizeof(cbm_gbuf_t *) - (2 * sizeof(int))];
} extract_worker_state_t;

typedef struct {
    // NOLINTNEXTLINE(misc-include-cleaner) — cbm_file_info_t provided by standard header
    const cbm_file_info_t *files;
    file_sort_entry_t *sorted;
    int file_count;
    const char *project_name;
    const char *repo_path;

    extract_worker_state_t *workers;
    int max_workers;
    _Atomic int next_worker_id;

    CBMFileResult **result_cache;
    _Atomic int64_t *shared_ids;
    _Atomic int *cancelled;
    _Atomic int next_file_idx;
} extract_ctx_t;

static void extract_worker(int worker_id, void *ctx_ptr) {
    extract_ctx_t *ec = ctx_ptr;
    extract_worker_state_t *ws = &ec->workers[worker_id];

    /* Lazy gbuf creation */
    if (!ws->local_gbuf) {
        ws->local_gbuf = cbm_gbuf_new_shared_ids(ec->project_name, ec->repo_path, ec->shared_ids);
    }

    /* Pull files from shared atomic counter */
    while (1) {
        int sort_pos = atomic_fetch_add_explicit(&ec->next_file_idx, 1, memory_order_relaxed);
        if (sort_pos >= ec->file_count) {
            break;
        }
        if (atomic_load_explicit(ec->cancelled, memory_order_relaxed)) {
            break;
        }

        int file_idx = ec->sorted[sort_pos].idx;
        const cbm_file_info_t *fi = &ec->files[file_idx];

        /* Read + extract */
        int source_len = 0;
        char *source = read_file(fi->path, &source_len);
        if (!source) {
            ws->errors++;
            continue;
        }

        CBMFileResult *result = cbm_extract_file(source, source_len, fi->language, ec->project_name,
                                                 fi->rel_path, 5000000, NULL, NULL);
        free(source);

        if (!result) {
            ws->errors++;
            continue;
        }

        /* Create definition nodes in local gbuf */
        for (int d = 0; d < result->defs.count; d++) {
            CBMDefinition *def = &result->defs.items[d];
            if (!def->qualified_name || !def->name) {
                continue;
            }

            char props[2048];
            build_def_props(props, sizeof(props), def);

            cbm_gbuf_upsert_node(ws->local_gbuf, def->label ? def->label : "Function", def->name,
                                 def->qualified_name,
                                 def->file_path ? def->file_path : fi->rel_path,
                                 (int)def->start_line, (int)def->end_line, props);
            ws->nodes_created++;
        }

        /* Cache result for Phase 3B and Phase 4 */
        ec->result_cache[file_idx] = result;
    }
}

int cbm_parallel_extract(cbm_pipeline_ctx_t *ctx, cbm_file_info_t *files, int file_count,
                         CBMFileResult **result_cache, _Atomic int64_t *shared_ids,
                         int worker_count) {
    if (file_count == 0) {
        return 0;
    }

    cbm_log_info("parallel.extract.start", "files", itoa_log(file_count), "workers",
                 itoa_log(worker_count));

    /* Ensure extraction library is initialized */
    cbm_init();

    /* Sort files by descending size for tail-latency reduction */
    file_sort_entry_t *sorted = malloc(file_count * sizeof(file_sort_entry_t));
    for (int i = 0; i < file_count; i++) {
        sorted[i].idx = i;
        sorted[i].size = files[i].size;
    }
    qsort(sorted, file_count, sizeof(file_sort_entry_t), compare_by_size_desc);

    /* Allocate per-worker state (cache-line aligned via posix_memalign) */
    extract_worker_state_t *workers = NULL;
    // NOLINTNEXTLINE(misc-include-cleaner) — posix_memalign provided by standard header
    if (posix_memalign((void **)&workers, CBM_CACHE_LINE,
                       (size_t)worker_count * sizeof(extract_worker_state_t)) != 0) {
        free(sorted);
        return -1;
    }
    memset(workers, 0, (size_t)worker_count * sizeof(extract_worker_state_t));

    extract_ctx_t ec = {
        .files = files,
        .sorted = sorted,
        .file_count = file_count,
        .project_name = ctx->project_name,
        .repo_path = ctx->repo_path,
        .workers = workers,
        .max_workers = worker_count,
        .result_cache = result_cache,
        .shared_ids = shared_ids,
        .cancelled = ctx->cancelled,
    };
    atomic_init(&ec.next_worker_id, 0);
    atomic_init(&ec.next_file_idx, 0);

    /* Dispatch workers */
    cbm_parallel_for_opts_t opts = {.max_workers = worker_count, .force_pthreads = false};
    cbm_parallel_for(worker_count, extract_worker, &ec, opts);

    /* Merge all local gbufs into main gbuf */
    int total_nodes = 0;
    int total_errors = 0;
    for (int i = 0; i < worker_count; i++) {
        if (workers[i].local_gbuf) {
            cbm_gbuf_merge(ctx->gbuf, workers[i].local_gbuf);
            total_nodes += workers[i].nodes_created;
            total_errors += workers[i].errors;
            cbm_gbuf_free(workers[i].local_gbuf);
        }
    }

    free(workers);
    free(sorted);

    if (atomic_load(ctx->cancelled)) {
        return -1;
    }

    cbm_log_info("parallel.extract.done", "nodes", itoa_log(total_nodes), "errors",
                 itoa_log(total_errors));
    return 0;
}

/* ── Phase 3B: Serial Registry Build ─────────────────────────────── */

int cbm_build_registry_from_cache(cbm_pipeline_ctx_t *ctx, const cbm_file_info_t *files,
                                  int file_count, CBMFileResult **result_cache) {
    cbm_log_info("parallel.registry.start", "files", itoa_log(file_count));

    int reg_entries = 0;
    int defines_edges = 0;
    int imports_edges = 0;

    for (int i = 0; i < file_count; i++) {
        if (cbm_pipeline_check_cancel(ctx)) {
            return -1;
        }

        CBMFileResult *result = result_cache[i];
        if (!result) {
            continue;
        }

        const char *rel = files[i].rel_path;

        /* Register callable symbols */
        for (int d = 0; d < result->defs.count; d++) {
            CBMDefinition *def = &result->defs.items[d];
            if (!def->name || !def->qualified_name || !def->label) {
                continue;
            }

            if (strcmp(def->label, "Function") == 0 || strcmp(def->label, "Method") == 0 ||
                strcmp(def->label, "Class") == 0) {
                cbm_registry_add(ctx->registry, def->name, def->qualified_name, def->label);
                reg_entries++;
            }

            /* DEFINES edge: File → Definition */
            char *file_qn = cbm_pipeline_fqn_compute(ctx->project_name, rel, "__file__");
            const cbm_gbuf_node_t *file_node = cbm_gbuf_find_by_qn(ctx->gbuf, file_qn);
            const cbm_gbuf_node_t *def_node = cbm_gbuf_find_by_qn(ctx->gbuf, def->qualified_name);
            if (file_node && def_node) {
                cbm_gbuf_insert_edge(ctx->gbuf, file_node->id, def_node->id, "DEFINES", "{}");
                defines_edges++;
            }
            free(file_qn);

            /* DEFINES_METHOD edge: Class → Method */
            if (def->parent_class && strcmp(def->label, "Method") == 0) {
                const cbm_gbuf_node_t *parent = cbm_gbuf_find_by_qn(ctx->gbuf, def->parent_class);
                if (parent && def_node) {
                    cbm_gbuf_insert_edge(ctx->gbuf, parent->id, def_node->id, "DEFINES_METHOD",
                                         "{}");
                }
            }
        }

        /* IMPORTS edges */
        for (int j = 0; j < result->imports.count; j++) {
            CBMImport *imp = &result->imports.items[j];
            if (!imp->module_path) {
                continue;
            }

            char *target_qn = cbm_pipeline_fqn_module(ctx->project_name, imp->module_path);
            const cbm_gbuf_node_t *target = cbm_gbuf_find_by_qn(ctx->gbuf, target_qn);

            char *file_qn = cbm_pipeline_fqn_compute(ctx->project_name, rel, "__file__");
            const cbm_gbuf_node_t *source_node = cbm_gbuf_find_by_qn(ctx->gbuf, file_qn);

            if (source_node && target) {
                char imp_props[256];
                snprintf(imp_props, sizeof(imp_props), "{\"local_name\":\"%s\"}",
                         imp->local_name ? imp->local_name : "");
                cbm_gbuf_insert_edge(ctx->gbuf, source_node->id, target->id, "IMPORTS", imp_props);
                imports_edges++;
            }
            free(target_qn);
            free(file_qn);
        }
    }

    cbm_log_info("parallel.registry.done", "entries", itoa_log(reg_entries), "defines",
                 itoa_log(defines_edges), "imports", itoa_log(imports_edges));
    return 0;
}

/* ── Phase 4: Parallel Resolution ────────────────────────────────── */

typedef struct __attribute__((aligned(CBM_CACHE_LINE))) {
    cbm_gbuf_t *local_edge_buf;
    int calls_resolved;
    int usages_resolved;
    int semantic_resolved;
    int errors;
    char _pad[CBM_CACHE_LINE - sizeof(cbm_gbuf_t *) - (4 * sizeof(int))];
} resolve_worker_state_t;

typedef struct {
    const cbm_file_info_t *files;
    int file_count;
    const char *project_name;
    const char *repo_path;

    resolve_worker_state_t *workers;
    int max_workers;

    CBMFileResult **result_cache;
    const cbm_gbuf_t *main_gbuf;    /* READ-ONLY during Phase 4 */
    const cbm_registry_t *registry; /* READ-ONLY during Phase 4 */
    _Atomic int64_t *shared_ids;
    _Atomic int *cancelled;
    _Atomic int next_file_idx;
} resolve_ctx_t;

static void resolve_worker(int worker_id, void *ctx_ptr) {
    resolve_ctx_t *rc = ctx_ptr;
    resolve_worker_state_t *ws = &rc->workers[worker_id];

    if (!ws->local_edge_buf) {
        ws->local_edge_buf =
            cbm_gbuf_new_shared_ids(rc->project_name, rc->repo_path, rc->shared_ids);
    }

    while (1) {
        int file_idx = atomic_fetch_add_explicit(&rc->next_file_idx, 1, memory_order_relaxed);
        if (file_idx >= rc->file_count) {
            break;
        }
        if (atomic_load_explicit(rc->cancelled, memory_order_relaxed)) {
            break;
        }

        CBMFileResult *result = rc->result_cache[file_idx];
        if (!result) {
            continue;
        }

        /* Skip files with nothing to resolve */
        if (result->calls.count == 0 && result->usages.count == 0 && result->throws.count == 0 &&
            result->rw.count == 0 && result->defs.count == 0 && result->impl_traits.count == 0) {
            continue;
        }

        const char *rel = rc->files[file_idx].rel_path;

        /* Build import map (read-only access to main_gbuf) */
        const char **imp_keys = NULL;
        const char **imp_vals = NULL;
        int imp_count = 0;
        build_import_map(rc->main_gbuf, rc->project_name, rel, &imp_keys, &imp_vals, &imp_count);

        char *module_qn = cbm_pipeline_fqn_module(rc->project_name, rel);

        /* ── CALLS resolution ──────────────────────────────────── */
        for (int c = 0; c < result->calls.count; c++) {
            CBMCall *call = &result->calls.items[c];
            if (!call->callee_name) {
                continue;
            }

            const cbm_gbuf_node_t *source_node = NULL;
            if (call->enclosing_func_qn) {
                source_node = cbm_gbuf_find_by_qn(rc->main_gbuf, call->enclosing_func_qn);
            }
            if (!source_node) {
                char *file_qn = cbm_pipeline_fqn_compute(rc->project_name, rel, "__file__");
                source_node = cbm_gbuf_find_by_qn(rc->main_gbuf, file_qn);
                free(file_qn);
            }
            if (!source_node) {
                continue;
            }

            cbm_resolution_t res = cbm_registry_resolve(rc->registry, call->callee_name, module_qn,
                                                        imp_keys, imp_vals, imp_count);
            if (!res.qualified_name || res.qualified_name[0] == '\0') {
                continue;
            }

            const cbm_gbuf_node_t *target_node =
                cbm_gbuf_find_by_qn(rc->main_gbuf, res.qualified_name);
            if (!target_node || source_node->id == target_node->id) {
                continue;
            }

            char props[256];
            snprintf(props, sizeof(props),
                     "{\"confidence\":%.2f,\"strategy\":\"%s\",\"candidates\":%d}", res.confidence,
                     res.strategy ? res.strategy : "unknown", res.candidate_count);
            cbm_gbuf_insert_edge(ws->local_edge_buf, source_node->id, target_node->id, "CALLS",
                                 props);
            ws->calls_resolved++;
        }

        /* ── USAGE resolution ──────────────────────────────────── */
        for (int u = 0; u < result->usages.count; u++) {
            CBMUsage *usage = &result->usages.items[u];
            if (!usage->ref_name) {
                continue;
            }

            const cbm_gbuf_node_t *src = NULL;
            if (usage->enclosing_func_qn) {
                src = cbm_gbuf_find_by_qn(rc->main_gbuf, usage->enclosing_func_qn);
            }
            if (!src) {
                char *file_qn = cbm_pipeline_fqn_compute(rc->project_name, rel, "__file__");
                src = cbm_gbuf_find_by_qn(rc->main_gbuf, file_qn);
                free(file_qn);
            }
            if (!src) {
                continue;
            }

            cbm_resolution_t res = cbm_registry_resolve(rc->registry, usage->ref_name, module_qn,
                                                        imp_keys, imp_vals, imp_count);
            if (!res.qualified_name || res.qualified_name[0] == '\0') {
                continue;
            }

            const cbm_gbuf_node_t *tgt = cbm_gbuf_find_by_qn(rc->main_gbuf, res.qualified_name);
            if (!tgt || src->id == tgt->id) {
                continue;
            }

            cbm_gbuf_insert_edge(ws->local_edge_buf, src->id, tgt->id, "USAGE", "{}");
            ws->usages_resolved++;
        }

        /* ── THROWS / RAISES ───────────────────────────────────── */
        for (int t = 0; t < result->throws.count; t++) {
            CBMThrow *thr = &result->throws.items[t];
            if (!thr->exception_name || !thr->enclosing_func_qn) {
                continue;
            }

            const cbm_gbuf_node_t *src = cbm_gbuf_find_by_qn(rc->main_gbuf, thr->enclosing_func_qn);
            if (!src) {
                continue;
            }

            // NOLINTNEXTLINE(readability-implicit-bool-conversion)
            const char *edge_type = is_checked_exception(thr->exception_name) ? "THROWS" : "RAISES";
            cbm_resolution_t res = cbm_registry_resolve(rc->registry, thr->exception_name,
                                                        module_qn, imp_keys, imp_vals, imp_count);
            if (!res.qualified_name || res.qualified_name[0] == '\0') {
                continue;
            }

            const cbm_gbuf_node_t *tgt = cbm_gbuf_find_by_qn(rc->main_gbuf, res.qualified_name);
            if (!tgt || src->id == tgt->id) {
                continue;
            }

            cbm_gbuf_insert_edge(ws->local_edge_buf, src->id, tgt->id, edge_type, "{}");
        }

        /* ── READS / WRITES ────────────────────────────────────── */
        for (int r = 0; r < result->rw.count; r++) {
            CBMReadWrite *rw = &result->rw.items[r];
            if (!rw->var_name) {
                continue;
            }

            const cbm_gbuf_node_t *src = NULL;
            if (rw->enclosing_func_qn) {
                src = cbm_gbuf_find_by_qn(rc->main_gbuf, rw->enclosing_func_qn);
            }
            if (!src) {
                char *file_qn = cbm_pipeline_fqn_compute(rc->project_name, rel, "__file__");
                src = cbm_gbuf_find_by_qn(rc->main_gbuf, file_qn);
                free(file_qn);
            }
            if (!src) {
                continue;
            }

            cbm_resolution_t res = cbm_registry_resolve(rc->registry, rw->var_name, module_qn,
                                                        imp_keys, imp_vals, imp_count);
            if (!res.qualified_name || res.qualified_name[0] == '\0') {
                continue;
            }

            const cbm_gbuf_node_t *tgt = cbm_gbuf_find_by_qn(rc->main_gbuf, res.qualified_name);
            if (!tgt || src->id == tgt->id) {
                continue;
            }

            // NOLINTNEXTLINE(readability-implicit-bool-conversion)
            const char *etype = rw->is_write ? "WRITES" : "READS";
            cbm_gbuf_insert_edge(ws->local_edge_buf, src->id, tgt->id, etype, "{}");
        }

        /* ── INHERITS + DECORATES ──────────────────────────────── */
        for (int d = 0; d < result->defs.count; d++) {
            CBMDefinition *def = &result->defs.items[d];
            if (!def->qualified_name) {
                continue;
            }

            const cbm_gbuf_node_t *node = cbm_gbuf_find_by_qn(rc->main_gbuf, def->qualified_name);
            if (!node) {
                continue;
            }

            /* INHERITS */
            if (def->base_classes) {
                for (int b = 0; def->base_classes[b]; b++) {
                    const char *base_qn =
                        resolve_as_class(rc->registry, def->base_classes[b], module_qn, imp_keys,
                                         imp_vals, imp_count);
                    if (!base_qn) {
                        continue;
                    }
                    const cbm_gbuf_node_t *base_node = cbm_gbuf_find_by_qn(rc->main_gbuf, base_qn);
                    if (!base_node || node->id == base_node->id) {
                        continue;
                    }
                    cbm_gbuf_insert_edge(ws->local_edge_buf, node->id, base_node->id, "INHERITS",
                                         "{}");
                    ws->semantic_resolved++;
                }
            }

            /* DECORATES */
            if (def->decorators) {
                for (int dc = 0; def->decorators[dc]; dc++) {
                    char func_name[256];
                    extract_decorator_func(def->decorators[dc], func_name, sizeof(func_name));
                    if (func_name[0] == '\0') {
                        continue;
                    }

                    cbm_resolution_t res = cbm_registry_resolve(rc->registry, func_name, module_qn,
                                                                imp_keys, imp_vals, imp_count);
                    if (!res.qualified_name || res.qualified_name[0] == '\0') {
                        continue;
                    }

                    const cbm_gbuf_node_t *dec_node =
                        cbm_gbuf_find_by_qn(rc->main_gbuf, res.qualified_name);
                    if (!dec_node || node->id == dec_node->id) {
                        continue;
                    }

                    char dprops[256];
                    snprintf(dprops, sizeof(dprops), "{\"decorator\":\"%s\"}", def->decorators[dc]);
                    cbm_gbuf_insert_edge(ws->local_edge_buf, node->id, dec_node->id, "DECORATES",
                                         dprops);
                    ws->semantic_resolved++;
                }
            }
        }

        /* ── IMPLEMENTS (Rust impl) ────────────────────────────── */
        for (int t = 0; t < result->impl_traits.count; t++) {
            CBMImplTrait *it = &result->impl_traits.items[t];
            if (!it->trait_name || !it->struct_name) {
                continue;
            }

            const char *trait_qn = resolve_as_class(rc->registry, it->trait_name, module_qn,
                                                    imp_keys, imp_vals, imp_count);
            if (!trait_qn) {
                continue;
            }
            const char *struct_qn = resolve_as_class(rc->registry, it->struct_name, module_qn,
                                                     imp_keys, imp_vals, imp_count);
            if (!struct_qn) {
                continue;
            }

            const cbm_gbuf_node_t *trait_node = cbm_gbuf_find_by_qn(rc->main_gbuf, trait_qn);
            const cbm_gbuf_node_t *struct_node = cbm_gbuf_find_by_qn(rc->main_gbuf, struct_qn);
            if (!trait_node || !struct_node || trait_node->id == struct_node->id) {
                continue;
            }

            cbm_gbuf_insert_edge(ws->local_edge_buf, struct_node->id, trait_node->id, "IMPLEMENTS",
                                 "{}");
            ws->semantic_resolved++;
        }

        free(module_qn);
        free_import_map(imp_keys, imp_vals, imp_count);
    }
}

int cbm_parallel_resolve(cbm_pipeline_ctx_t *ctx, const cbm_file_info_t *files, int file_count,
                         CBMFileResult **result_cache, _Atomic int64_t *shared_ids,
                         int worker_count) {
    if (file_count == 0) {
        return 0;
    }

    cbm_log_info("parallel.resolve.start", "files", itoa_log(file_count), "workers",
                 itoa_log(worker_count));

    resolve_worker_state_t *workers = NULL;
    if (posix_memalign((void **)&workers, CBM_CACHE_LINE,
                       (size_t)worker_count * sizeof(resolve_worker_state_t)) != 0) {
        return -1;
    }
    memset(workers, 0, (size_t)worker_count * sizeof(resolve_worker_state_t));

    resolve_ctx_t rc = {
        .files = files,
        .file_count = file_count,
        .project_name = ctx->project_name,
        .repo_path = ctx->repo_path,
        .workers = workers,
        .max_workers = worker_count,
        .result_cache = result_cache,
        .main_gbuf = ctx->gbuf,
        .registry = ctx->registry,
        .shared_ids = shared_ids,
        .cancelled = ctx->cancelled,
    };
    atomic_init(&rc.next_file_idx, 0);

    cbm_parallel_for_opts_t opts = {.max_workers = worker_count, .force_pthreads = false};
    cbm_parallel_for(worker_count, resolve_worker, &rc, opts);

    /* Merge all local edge bufs into main gbuf */
    int total_calls = 0;
    int total_usages = 0;
    int total_semantic = 0;
    for (int i = 0; i < worker_count; i++) {
        if (workers[i].local_edge_buf) {
            cbm_gbuf_merge(ctx->gbuf, workers[i].local_edge_buf);
            total_calls += workers[i].calls_resolved;
            total_usages += workers[i].usages_resolved;
            total_semantic += workers[i].semantic_resolved;
            cbm_gbuf_free(workers[i].local_edge_buf);
        }
    }

    free(workers);

    /* Go-style implicit interface satisfaction (needs full graph, serial) */
    int go_impl = cbm_pipeline_implements_go(ctx);

    if (atomic_load(ctx->cancelled)) {
        return -1;
    }

    cbm_log_info("parallel.resolve.done", "calls", itoa_log(total_calls), "usages",
                 itoa_log(total_usages), "semantic", itoa_log(total_semantic + go_impl));
    return 0;
}

// NOLINTEND(readability-magic-numbers)
// NOLINTEND(cert-err33-c)

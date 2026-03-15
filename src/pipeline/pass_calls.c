/*
 * pass_calls.c — Resolve function/method calls into CALLS edges.
 *
 * For each discovered file:
 *   1. Re-extract calls (cbm_extract_file)
 *   2. Build per-file import map from IMPORTS edges in graph buffer
 *   3. Resolve each call via registry (import_map → same_module → unique → suffix)
 *   4. Create CALLS edges in graph buffer with confidence/strategy properties
 *
 * Depends on: pass_definitions having populated the registry and graph buffer
 */
#include "pipeline/pipeline.h"
#include "pipeline/pipeline_internal.h"
#include "graph_buffer/graph_buffer.h"
#include "foundation/log.h"
#include "cbm.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Read entire file into heap-allocated buffer. Caller must free(). */
static char *read_file(const char *path, int *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f)
        return NULL;

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

    buf[nread] = '\0';
    *out_len = (int)nread;
    return buf;
}

/* Format int for logging. Thread-safe via TLS. */
static const char *itoa_log(int val) {
    static _Thread_local char bufs[4][32];
    static _Thread_local int idx = 0;
    int i = idx;
    idx = (idx + 1) & 3;
    snprintf(bufs[i], sizeof(bufs[i]), "%d", val);
    return bufs[i];
}

/* Build per-file import map from the graph buffer's IMPORTS edges.
 * Returns parallel arrays of (local_name, module_qn) pairs. Caller frees. */
static int build_import_map(cbm_pipeline_ctx_t *ctx, const char *rel_path, const char ***out_keys,
                            const char ***out_vals, int *out_count) {
    *out_keys = NULL;
    *out_vals = NULL;
    *out_count = 0;

    /* Find the file node */
    char *file_qn = cbm_pipeline_fqn_compute(ctx->project_name, rel_path, "__file__");
    const cbm_gbuf_node_t *file_node = cbm_gbuf_find_by_qn(ctx->gbuf, file_qn);
    free(file_qn);
    if (!file_node)
        return 0;

    /* Get IMPORTS edges from this file */
    const cbm_gbuf_edge_t **edges = NULL;
    int edge_count = 0;
    int rc = cbm_gbuf_find_edges_by_source_type(ctx->gbuf, file_node->id, "IMPORTS", &edges,
                                                &edge_count);
    if (rc != 0 || edge_count == 0)
        return 0;

    /* Allocate parallel key/val arrays */
    const char **keys = calloc(edge_count, sizeof(const char *));
    const char **vals = calloc(edge_count, sizeof(const char *));
    int count = 0;

    for (int i = 0; i < edge_count; i++) {
        const cbm_gbuf_edge_t *e = edges[i];
        const cbm_gbuf_node_t *target = cbm_gbuf_find_by_id(ctx->gbuf, e->target_id);
        if (!target)
            continue;

        /* Extract local_name from edge properties JSON.
         * Format: {"local_name":"X"} — simple extraction since we control the format. */
        if (e->properties_json) {
            const char *start = strstr(e->properties_json, "\"local_name\":\"");
            if (start) {
                start += strlen("\"local_name\":\"");
                const char *end = strchr(start, '"');
                if (end && end > start) {
                    /* Use local_name as key, target QN as value */
                    char *key = strndup(start, end - start);
                    keys[count] = key;
                    vals[count] = target->qualified_name; /* borrowed from gbuf */
                    count++;
                }
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

int cbm_pipeline_pass_calls(cbm_pipeline_ctx_t *ctx, const cbm_file_info_t *files, int file_count) {
    cbm_log_info("pass.start", "pass", "calls", "files", itoa_log(file_count));

    int total_calls = 0;
    int resolved = 0;
    int unresolved = 0;
    int errors = 0;

    for (int i = 0; i < file_count; i++) {
        if (cbm_pipeline_check_cancel(ctx))
            return -1;

        const char *path = files[i].path;
        const char *rel = files[i].rel_path;
        CBMLanguage lang = files[i].language;

        /* Re-read + extract to get call data */
        int source_len = 0;
        char *source = read_file(path, &source_len);
        if (!source) {
            errors++;
            continue;
        }

        CBMFileResult *result =
            cbm_extract_file(source, source_len, lang, ctx->project_name, rel, 5000000, NULL, NULL);
        free(source);

        if (!result) {
            errors++;
            continue;
        }

        if (result->calls.count == 0) {
            cbm_free_result(result);
            continue;
        }

        /* Build import map for this file */
        const char **imp_keys = NULL;
        const char **imp_vals = NULL;
        int imp_count = 0;
        build_import_map(ctx, rel, &imp_keys, &imp_vals, &imp_count);

        /* Compute module QN for same-module resolution */
        char *module_qn = cbm_pipeline_fqn_module(ctx->project_name, rel);

        /* Resolve each call */
        for (int c = 0; c < result->calls.count; c++) {
            CBMCall *call = &result->calls.items[c];
            if (!call->callee_name)
                continue;

            total_calls++;

            /* Find enclosing function node (source of CALLS edge) */
            const cbm_gbuf_node_t *source_node = NULL;
            if (call->enclosing_func_qn) {
                source_node = cbm_gbuf_find_by_qn(ctx->gbuf, call->enclosing_func_qn);
            }
            if (!source_node) {
                /* Try module-level: file node as source */
                char *file_qn = cbm_pipeline_fqn_compute(ctx->project_name, rel, "__file__");
                source_node = cbm_gbuf_find_by_qn(ctx->gbuf, file_qn);
                free(file_qn);
            }
            if (!source_node) {
                unresolved++;
                continue;
            }

            /* Resolve callee through registry */
            cbm_resolution_t res = cbm_registry_resolve(ctx->registry, call->callee_name, module_qn,
                                                        imp_keys, imp_vals, imp_count);

            if (!res.qualified_name || res.qualified_name[0] == '\0') {
                unresolved++;
                continue;
            }

            /* Find target node in graph buffer */
            const cbm_gbuf_node_t *target_node = cbm_gbuf_find_by_qn(ctx->gbuf, res.qualified_name);
            if (!target_node) {
                unresolved++;
                continue;
            }

            /* Skip self-calls */
            if (source_node->id == target_node->id)
                continue;

            /* Create CALLS edge with confidence + strategy properties */
            char props[256];
            snprintf(props, sizeof(props),
                     "{\"confidence\":%.2f,\"strategy\":\"%s\",\"candidates\":%d}", res.confidence,
                     res.strategy ? res.strategy : "unknown", res.candidate_count);

            cbm_gbuf_insert_edge(ctx->gbuf, source_node->id, target_node->id, "CALLS", props);
            resolved++;
        }

        free(module_qn);
        free_import_map(imp_keys, imp_vals, imp_count);
        cbm_free_result(result);
    }

    cbm_log_info("pass.done", "pass", "calls", "total", itoa_log(total_calls), "resolved",
                 itoa_log(resolved), "unresolved", itoa_log(unresolved), "errors",
                 itoa_log(errors));
    return 0;
}

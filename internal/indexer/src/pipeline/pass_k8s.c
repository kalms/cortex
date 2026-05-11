/*
 * pass_k8s.c — Pipeline pass for Kubernetes manifest and Kustomize overlay processing.
 *
 * For each discovered YAML file:
 *   1. Check if it is a kustomize overlay (kustomization.yaml / kustomization.yml)
 *      → emit a Module node and IMPORTS edges for each resources/bases/patches entry
 *   2. Else if it is a generic k8s manifest (apiVersion: detected)
 *      → emit one Resource node per file (first document only — multi-document YAML is not yet
 * supported)
 *
 * Depends on: pass_infrascan.c (ctx_is_kustomize_file, ctx_is_k8s_manifest, ctx_infra_qn),
 *             extraction layer (cbm.h), graph_buffer, pipeline internals.
 */
#include "foundation/constants.h"
#include "pipeline/pipeline.h"
#include <stdint.h>
#include "pipeline/pipeline_internal.h"
#include "graph_buffer/graph_buffer.h"
#include "discover/discover.h"
#include "foundation/log.h"
#include "foundation/compat.h"
#include "extract.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>

/* ── Internal helpers ────────────────────────────────────────────── */

/* Read entire file into heap-allocated buffer. Returns NULL on error.
 * Caller must free(). Sets *out_len to byte count. */
static char *k8s_read_file(const char *path, int *out_len) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        return NULL;
    }

    (void)fseek(f, 0, SEEK_END);
    long size = ftell(f);
    (void)fseek(f, 0, SEEK_SET);

    if (size <= 0 || size > (long)CTX_PERCENT * CTX_SZ_1K * CTX_SZ_1K) {
        (void)fclose(f);
        return NULL;
    }

    char *buf = malloc(size + SKIP_ONE);
    if (!buf) {
        (void)fclose(f);
        return NULL;
    }

    size_t nread = fread(buf, SKIP_ONE, size, f);
    (void)fclose(f);
    if (nread > (size_t)size) {
        nread = (size_t)size;
    }
    buf[nread] = '\0';
    *out_len = (int)nread;
    return buf;
}

/* Format int to string for logging. Thread-safe via TLS. */
static const char *itoa_k8s(int val) {
    enum { RING_BUF_COUNT = 4, RING_BUF_MASK = 3 };
    static CTX_TLS char bufs[RING_BUF_COUNT][CTX_SZ_32];
    static CTX_TLS int idx = 0;
    int i = idx;
    idx = (idx + SKIP_ONE) & RING_BUF_MASK;
    snprintf(bufs[i], sizeof(bufs[i]), "%d", val);
    return bufs[i];
}

/* Extract the basename of a path (pointer into the string; no allocation). */
static const char *k8s_basename(const char *path) {
    const char *p = strrchr(path, '/');
    return p ? p + SKIP_ONE : path;
}

/* ── Kustomize handler ───────────────────────────────────────────── */

static void handle_kustomize(ctx_pipeline_ctx_t *ctx, const char *path, const char *rel_path,
                             CtxFileResult *result) {
    /* Emit Module node for this kustomize overlay file */
    char *mod_qn = ctx_infra_qn(ctx->project_name, rel_path, "kustomize", NULL);
    if (!mod_qn) {
        return;
    }

    int64_t mod_id = ctx_gbuf_upsert_node(ctx->gbuf, "Module", k8s_basename(rel_path), mod_qn,
                                          rel_path, SKIP_ONE, 0, "{\"source\":\"kustomize\"}");
    free(mod_qn);

    if (mod_id <= 0) {
        return;
    }

    /* If we have a cached extraction result, emit IMPORTS edges for
     * resources/bases/patches/components entries */
    int import_count = 0;
    CtxFileResult *res = result;
    bool allocated = false;

    if (!res) {
        /* Fall back to re-extraction */
        int src_len = 0;
        char *source = k8s_read_file(path, &src_len);
        if (source) {
            res = ctx_extract_file(source, src_len, CTX_LANG_KUSTOMIZE, ctx->project_name, rel_path,
                                   CTX_EXTRACT_BUDGET, NULL, NULL);
            free(source);
            allocated = true;
        }
    }

    if (res) {
        for (int j = 0; j < res->imports.count; j++) {
            CtxImport *imp = &res->imports.items[j];
            if (!imp->module_path) {
                continue;
            }

            /* Compute target file QN */
            char *target_qn =
                ctx_pipeline_fqn_compute(ctx->project_name, imp->module_path, "__file__");
            if (!target_qn) {
                continue;
            }

            const ctx_gbuf_node_t *target = ctx_gbuf_find_by_qn(ctx->gbuf, target_qn);
            free(target_qn);

            if (target) {
                ctx_gbuf_insert_edge(ctx->gbuf, mod_id, target->id, "IMPORTS",
                                     "{\"via\":\"kustomize\"}");
                import_count++;
            }
        }

        if (allocated) {
            ctx_free_result(res);
        }
    }

    ctx_log_info("pass.k8s.kustomize", "file", rel_path, "imports", itoa_k8s(import_count));
}

/* ── K8s manifest handler ────────────────────────────────────────── */

/* source/src_len are the already-read file bytes (caller retains ownership and
 * must free after this call returns). */
static void handle_k8s_manifest(ctx_pipeline_ctx_t *ctx, const char *path, const char *rel_path,
                                const char *source, int src_len) {
    (void)path; /* retained for symmetry; source is always provided now */
    int resource_count = 0;

    CtxFileResult *res = ctx_extract_file(source, src_len, CTX_LANG_K8S, ctx->project_name,
                                          rel_path, CTX_EXTRACT_BUDGET, NULL, NULL);
    if (!res) {
        return;
    }

    /* Compute file node QN for DEFINES edges */
    char *file_qn = ctx_pipeline_fqn_compute(ctx->project_name, rel_path, "__file__");
    const ctx_gbuf_node_t *file_node = file_qn ? ctx_gbuf_find_by_qn(ctx->gbuf, file_qn) : NULL;
    free(file_qn);

    for (int d = 0; d < res->defs.count; d++) {
        CtxDefinition *def = &res->defs.items[d];
        if (!def->label || strcmp(def->label, "Resource") != 0) {
            continue;
        }
        if (!def->name || !def->qualified_name) {
            continue;
        }

        int64_t node_id =
            ctx_gbuf_upsert_node(ctx->gbuf, "Resource", def->name, def->qualified_name, rel_path,
                                 (int)def->start_line, (int)def->end_line, "{\"source\":\"k8s\"}");

        /* DEFINES edge: File → Resource */
        if (file_node && node_id > 0) {
            ctx_gbuf_insert_edge(ctx->gbuf, file_node->id, node_id, "DEFINES", "{}");
        }

        resource_count++;
    }

    ctx_free_result(res);

    ctx_log_info("pass.k8s.manifest", "file", rel_path, "resources", itoa_k8s(resource_count));
}

/* ── Pass entry point ────────────────────────────────────────────── */

int ctx_pipeline_pass_k8s(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files, int file_count) {
    ctx_log_info("pass.start", "pass", "k8s", "files", itoa_k8s(file_count));

    ctx_init();

    int kustomize_count = 0;
    int manifest_count = 0;

    for (int i = 0; i < file_count; i++) {
        if (ctx_pipeline_check_cancel(ctx)) {
            return CTX_NOT_FOUND;
        }

        const char *path = files[i].path;
        const char *rel = files[i].rel_path;
        CtxLanguage lang = files[i].language;
        const char *base = k8s_basename(rel);

        CtxFileResult *cached =
            (ctx->result_cache && ctx->result_cache[i]) ? ctx->result_cache[i] : NULL;

        if (ctx_is_kustomize_file(base)) {
            handle_kustomize(ctx, path, rel, cached);
            kustomize_count++;
        } else if (lang == CTX_LANG_YAML || lang == CTX_LANG_K8S) {
            /* Read source once to classify (and reuse for uncached extraction). */
            int src_len = 0;
            char *source = k8s_read_file(path, &src_len);
            if (source) {
                if (ctx_is_k8s_manifest(base, source)) {
                    /* Always re-extract with CTX_LANG_K8S regardless of any cached
                     * result: cached results were produced during the parallel YAML
                     * pass and contain no "Resource" definitions.  Pass the already-
                     * read source buffer so handle_k8s_manifest does not re-read. */
                    (void)cached; /* cached YAML result intentionally discarded */
                    handle_k8s_manifest(ctx, path, rel, source, src_len);
                    manifest_count++;
                }
                free(source);
            }
        }
    }

    ctx_log_info("pass.done", "pass", "k8s", "kustomize", itoa_k8s(kustomize_count), "manifests",
                 itoa_k8s(manifest_count));
    return 0;
}

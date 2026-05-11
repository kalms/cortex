#include "foundation/constants.h"
/*
 * pipeline_internal.h — Internal pipeline state shared between pass files.
 *
 * NOT a public header. Only included by pipeline.c and pass_*.c files.
 * Exposes the pipeline context struct for direct field access by passes.
 */
#ifndef CTX_PIPELINE_INTERNAL_H
#define CTX_PIPELINE_INTERNAL_H

#include "pipeline/pipeline.h"
#include "graph_buffer/graph_buffer.h"
#include "discover/discover.h"
#include "foundation/hash_table.h"
#include "cbm.h"
#include <stdatomic.h>

/* ── Shared pipeline constants ─────────────────────────────────── */

/* Maximum byte budget for tree-sitter extraction per file */
#define CTX_EXTRACT_BUDGET 5000000

/* Route node QN buffer size (must fit __route__METHOD__/full/url/path) */
#define CTX_ROUTE_QN_SIZE 768

/* Time unit conversions */
#define CTX_NS_PER_SEC 1000000000LL
#define CTX_US_PER_SEC 1000000LL
#define CTX_MS_PER_SEC 1000.0
#define CTX_US_PER_SEC_F 1e6

/* ── Pipeline context (internal) ─────────────────────────────────── */

/* Shared context passed to each pass function.
 * Derived from ctx_pipeline_t fields during run. */
typedef struct {
    const char *project_name; /* borrowed from pipeline */
    const char *repo_path;    /* borrowed from pipeline */
    ctx_gbuf_t *gbuf;         /* owned by pipeline */
    ctx_registry_t *registry; /* owned by pipeline */
    atomic_int *cancelled;    /* pointer to pipeline's cancelled flag */
    int mode;                 /* ctx_index_mode_t (0=full, 1=moderate, 2=fast) */

    /* Extraction result cache (sequential pipeline optimization).
     * When non-NULL, pass_definitions stores results here instead of freeing,
     * and pass_calls/usages/semantic reuse cached results instead of re-extracting.
     * Indexed by file position in the files[] array. Owned by pipeline.c. */
    CtxFileResult **result_cache;
} ctx_pipeline_ctx_t;

/* Check cancellation. Returns non-zero if cancelled. */
static inline int ctx_pipeline_check_cancel(const ctx_pipeline_ctx_t *ctx) {
    return atomic_load(ctx->cancelled) ? CTX_NOT_FOUND : 0;
}

/* ── Testable helpers ────────────────────────────────────────────── */

/* Check if a file path is worth tracking for git history analysis. */
bool ctx_is_trackable_file(const char *path);

/* Check if a file path looks like a test file (language-agnostic). */
bool ctx_is_test_path(const char *path);

/* Check if a function name looks like a test function (language-agnostic). */
bool ctx_is_test_func_name(const char *name);

/* Coupling result from computeChangeCoupling */
typedef struct {
    char file_a[CTX_SZ_512];
    char file_b[CTX_SZ_512];
    int co_change_count;
    double coupling_score;
} ctx_change_coupling_t;

/* Commit data for coupling analysis */
typedef struct {
    char **files;
    int count;
} ctx_commit_files_t;

/* Compute change coupling from commit history.
 * Returns number of couplings written to out (up to max_out).
 * Caller owns out[]. */
int ctx_compute_change_coupling(const ctx_commit_files_t *commits, int commit_count,
                                ctx_change_coupling_t *out, int max_out);

/* Go-style implicit interface satisfaction on graph buffer.
 * Finds Interface nodes, matches method sets against Class nodes,
 * creates IMPLEMENTS + OVERRIDE edges. Returns edge count created. */
int ctx_pipeline_implements_go(ctx_pipeline_ctx_t *ctx);

/* ── Git diff helpers (pass_gitdiff.c) ───────────────────────────── */

typedef struct {
    char status[CTX_SZ_4]; /* M/A/D/R */ /* "M", "A", "D", "R" */
    char path[CTX_SZ_512];
    char old_path[CTX_SZ_512]; /* non-empty only for renames */
} ctx_changed_file_t;

typedef struct {
    char path[CTX_SZ_512];
    int start_line;
    int end_line;
} ctx_changed_hunk_t;

/* Parse git diff --name-status output. Returns count written to out. */
int ctx_parse_name_status(const char *output, ctx_changed_file_t *out, int max_out);

/* Parse git diff --unified=0 output. Returns count written to out. */
int ctx_parse_hunks(const char *output, ctx_changed_hunk_t *out, int max_out);

/* Parse "start,count" or "start" → (start, count). */
void ctx_parse_range(const char *s, int *out_start, int *out_count);

/* ── Config helpers (pass_configures.c) ──────────────────────────── */

/* Check if a string looks like an environment variable name
 * (uppercase + underscore + digits, at least 2 chars with uppercase). */
bool ctx_is_env_var_name(const char *s);

/* Normalize a config key: split camelCase/snake/dots, lowercase.
 * Writes normalized form to norm_out (underscore-joined).
 * Returns token count. tokens_out[] receives borrowed pointers into norm_out. */
int ctx_normalize_config_key(const char *key, char *norm_out, size_t norm_sz);

/* Check if a file path has a config file extension (.toml, .yaml, .env, etc.) */
bool ctx_has_config_extension(const char *path);

/* ── Enrichment helpers (pass_enrichment.c) ──────────────────────── */

/* Split camelCase string on lowercase→uppercase transitions.
 * Writes substrings to out[]. Returns count. Caller must free each out[i]. */
int ctx_split_camel_case(const char *s, char **out, int max_out);

/* Tokenize a decorator into lowercase words, filtering stopwords.
 * E.g. "@login_required" → ["login", "required"].
 * Writes words to out[]. Returns count. Caller must free each out[i]. */
int ctx_tokenize_decorator(const char *dec, char **out, int max_out);

/* ── Compile commands helpers (pass_compile_commands.c) ──────────── */

typedef struct {
    char **include_paths;
    int include_count;
    char **defines;
    int define_count;
    char standard[CTX_SZ_32];
} ctx_compile_flags_t;

/* Split a shell command string into arguments (handles quoting).
 * Writes args to out[]. Returns count. Caller must free each out[i]. */
int ctx_split_command(const char *cmd, char **out, int max_out);

/* Extract -I, -isystem, -D, -std= flags from compiler arguments.
 * Caller must free result with ctx_compile_flags_free(). */
ctx_compile_flags_t *ctx_extract_flags(const char **args, int argc, const char *directory);

/* Free a compile_flags_t allocated by ctx_extract_flags(). */
void ctx_compile_flags_free(ctx_compile_flags_t *f);

/* Parse compile_commands.json content. Returns map as parallel arrays.
 * out_paths[i] is the relative file path, out_flags[i] is its flags.
 * Returns count. Caller must free out_paths[i] and ctx_compile_flags_free(out_flags[i]). */
int ctx_parse_compile_commands(const char *json_data, const char *repo_path, char ***out_paths,
                               ctx_compile_flags_t ***out_flags);

/* ── Infrascan helpers (pass_infrascan.c) ─────────────────────────── */

/* File identification helpers */
bool ctx_is_dockerfile(const char *name);
bool ctx_is_compose_file(const char *name);
bool ctx_is_cloudbuild_file(const char *name);
bool ctx_is_env_file(const char *name);
bool ctx_is_shell_script(const char *name, const char *ext);
bool ctx_is_kustomize_file(const char *name);
bool ctx_is_k8s_manifest(const char *name, const char *content);

/* Secret detection */
bool ctx_is_secret_binding(const char *key, const char *value);
bool ctx_is_secret_value(const char *value);

/* Clean JSON array brackets from CMD/ENTRYPOINT values.
 * E.g. ["./app", "--flag"] → ./app --flag
 * Writes result to out (up to out_sz). */
void ctx_clean_json_brackets(const char *s, char *out, size_t out_sz);

/* Key-value pair for environment variables / config entries */
typedef struct {
    char key[CTX_SZ_128];
    char value[CTX_SZ_512];
} ctx_env_kv_t;

/* Dockerfile parsing result */
typedef struct {
    char base_image[CTX_SZ_256];
    char stage_images[CTX_SZ_16][CTX_SZ_256];
    char stage_names[CTX_SZ_16][CTX_SZ_128];
    int stage_count;
    char exposed_ports[CTX_SZ_16][CTX_SZ_32];
    int port_count;
    ctx_env_kv_t env_vars[CTX_SZ_64];
    int env_count;
    char build_args[CTX_SZ_32][CTX_SZ_128];
    int build_arg_count;
    char workdir[CTX_SZ_256];
    char cmd[CTX_SZ_512];
    char entrypoint[CTX_SZ_512];
    char healthcheck[CTX_SZ_512];
    char user[CTX_SZ_64];
} ctx_dockerfile_result_t;

/* Dotenv parsing result */
typedef struct {
    ctx_env_kv_t env_vars[CTX_SZ_64];
    int env_count;
} ctx_dotenv_result_t;

/* Shell script parsing result */
typedef struct {
    char shebang[CTX_SZ_256];
    ctx_env_kv_t env_vars[CTX_SZ_64];
    int env_count;
    char sources[CTX_SZ_16][CTX_SZ_256];
    int source_count;
    char docker_cmds[CTX_SZ_16][CTX_SZ_256];
    int docker_cmd_count;
} ctx_shell_result_t;

/* Terraform variable */
typedef struct {
    char name[CTX_SZ_128];
    char type[CTX_SZ_64];
    char default_val[CTX_SZ_256];
    char description[CTX_SZ_256];
} ctx_tf_variable_t;

/* Terraform resource / data source */
typedef struct {
    char type[CTX_SZ_128];
    char name[CTX_SZ_128];
} ctx_tf_resource_t;

/* Terraform module */
typedef struct {
    char tf_name[CTX_SZ_128];
    char source[CTX_SZ_256];
} ctx_tf_module_t;

/* Terraform parsing result */
typedef struct {
    ctx_tf_resource_t resources[CTX_SZ_32];
    int resource_count;
    ctx_tf_variable_t variables[CTX_SZ_32];
    int variable_count;
    char outputs[CTX_SZ_32][CTX_SZ_128];
    int output_count;
    char providers[CTX_SZ_16][CTX_SZ_128];
    int provider_count;
    ctx_tf_module_t modules[CTX_SZ_16];
    int module_count;
    ctx_tf_resource_t data_sources[CTX_SZ_16];
    int data_source_count;
    char backend[CTX_SZ_128];
    bool has_locals;
} ctx_terraform_result_t;

/* Parse a Dockerfile from source text. Returns 0 if parsed, -1 if empty/invalid. */
int ctx_parse_dockerfile_source(const char *source, ctx_dockerfile_result_t *out);

/* Parse a .env file from source text. Returns 0 if parsed, -1 if empty. */
int ctx_parse_dotenv_source(const char *source, ctx_dotenv_result_t *out);

/* Parse a shell script from source text. Returns 0 if parsed, -1 if empty. */
int ctx_parse_shell_source(const char *source, ctx_shell_result_t *out);

/* Parse a Terraform file from source text. Returns 0 if parsed, -1 if empty. */
int ctx_parse_terraform_source(const char *source, ctx_terraform_result_t *out);

/* Build an infrastructure QN. Caller must free the returned string. */
char *ctx_infra_qn(const char *project_name, const char *rel_path, const char *infra_type,
                   const char *service_name);

/* ── Parallel pipeline prototypes (pass_parallel.c) ─────────────── */

/* Phase 3A: Parallel extract + create definition nodes.
 * Each worker creates nodes in a per-worker gbuf, then merges into ctx->gbuf.
 * Caches CtxFileResult* in result_cache[file_idx] for reuse in Phase 3B/4.
 * shared_ids provides globally unique node/edge IDs across workers. */
int ctx_parallel_extract(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files, int file_count,
                         CtxFileResult **result_cache, _Atomic int64_t *shared_ids,
                         int worker_count);

/* Phase 3B: Serial registry build from cached extraction results.
 * Creates DEFINES, DEFINES_METHOD, and IMPORTS edges in ctx->gbuf.
 * Registers callable symbols (Function/Method/Class) in ctx->registry. */
int ctx_build_registry_from_cache(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files,
                                  int file_count, CtxFileResult **result_cache);

/* Phase 4: Parallel call/usage/semantic resolution.
 * Each worker resolves calls, usages, throws, rw, inherits, decorates,
 * and implements edges into per-worker edge bufs, then merges.
 * Runs Go-style implicit IMPLEMENTS as serial post-step. */
int ctx_parallel_resolve(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files, int file_count,
                         CtxFileResult **result_cache, _Atomic int64_t *shared_ids,
                         int worker_count);

/* Post-merge: create Route nodes for HTTP_CALLS/ASYNC_CALLS edges that
 * have url_path in properties but point to library functions instead of routes.
 * Re-targets these edges to Route nodes for cross-service traversal. */
void ctx_pipeline_create_route_nodes(ctx_gbuf_t *gb);

/* ── Pass function prototypes ────────────────────────────────────── */

int ctx_pipeline_pass_definitions(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files,
                                  int file_count);

int ctx_pipeline_pass_k8s(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files, int file_count);

int ctx_pipeline_pass_calls(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files, int file_count);

/* Sub-passes called from pass_calls: pattern-based edge extraction */
void ctx_pipeline_pass_fastapi_depends(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files,
                                       int file_count);

int ctx_pipeline_pass_usages(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files, int file_count);

int ctx_pipeline_pass_semantic(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files,
                               int file_count);

int ctx_pipeline_pass_tests(ctx_pipeline_ctx_t *ctx, const ctx_file_info_t *files, int file_count);

int ctx_pipeline_pass_githistory(ctx_pipeline_ctx_t *ctx);

/* Pre-computed git history result for fused post-pass parallelism. */
typedef struct {
    ctx_change_coupling_t *couplings;
    int count;
    int commit_count;
} ctx_githistory_result_t;

/* Compute change couplings without touching the graph buffer.
 * Can run on a separate thread while other passes use the gbuf. */
int ctx_pipeline_githistory_compute(const char *repo_path, ctx_githistory_result_t *result);

/* Apply pre-computed couplings to the graph buffer (main thread only). */
int ctx_pipeline_githistory_apply(ctx_pipeline_ctx_t *ctx, const ctx_githistory_result_t *result);

/* Pre-dump pass: decorator tags enrichment (operates on gbuf). */
int ctx_pipeline_pass_decorator_tags(ctx_gbuf_t *gbuf, const char *project);

/* Pre-dump pass: config ↔ code linking. */
int ctx_pipeline_pass_configlink(ctx_pipeline_ctx_t *ctx);

/* Pre-dump pass: SIMILAR_TO edges via MinHash fingerprinting. */
int ctx_pipeline_pass_similarity(ctx_pipeline_ctx_t *ctx);

/* Pre-dump pass: SEMANTICALLY_RELATED edges via algorithmic embeddings.
 * Opt-in: only runs when CTX_SEMANTIC_ENABLED=1. */
int ctx_pipeline_pass_semantic_edges(ctx_pipeline_ctx_t *ctx);

/* ── Env URL scanner (pass_envscan.c) ────────────────────────────── */

typedef struct {
    char key[CTX_SZ_128];
    char value[CTX_SZ_512];
    char file_path[CTX_SZ_256];
} ctx_env_binding_t;

/* Scan a project directory for environment variable assignments with URL values.
 * Walks the filesystem, scans Dockerfiles, shell scripts, .env, YAML, TOML,
 * Terraform, and .properties files. Filters out secrets.
 * Returns number of bindings written to out (up to max_out). */
int ctx_scan_project_env_urls(const char *root_path, ctx_env_binding_t *out, int max_out);

/* ── Incremental pipeline (pipeline_incremental.c) ───────────────── */

/* Run incremental re-index on an existing disk DB.
 * Classifies files by mtime+size, deletes changed nodes, re-parses changed
 * files, merges into disk DB. Returns 0 on success. */
int ctx_pipeline_run_incremental(ctx_pipeline_t *p, const char *db_path, ctx_file_info_t *files,
                                 int file_count);

/* Pipeline accessors for incremental use */
const char *ctx_pipeline_repo_path(const ctx_pipeline_t *p);
atomic_int *ctx_pipeline_cancelled_ptr(ctx_pipeline_t *p);

#endif /* CTX_PIPELINE_INTERNAL_H */

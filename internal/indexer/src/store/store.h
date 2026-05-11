/*
 * store.h — Opaque SQLite graph store for code knowledge graphs.
 *
 * All functions are prefixed ctx_store_*. The store handle is opaque —
 * callers never touch SQLite internals directly.
 *
 * Thread safety: a single store handle must not be used concurrently.
 * Use one store per thread or external synchronization.
 */
#ifndef CTX_STORE_H
#define CTX_STORE_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

/* ── Opaque handle ──────────────────────────────────────────────── */

typedef struct ctx_store ctx_store_t;

/* Phase-4 schema fold: nodes.id is TEXT 'ctx-<int>'.  These counters are
 * seeded from MAX(id) on store-open and increment for every inserted row.
 * Exposed here so graph_buffer.c can read them without reaching into the
 * opaque struct through a back-channel. */
int64_t ctx_store_next_node_id(const ctx_store_t *s);
int64_t ctx_store_next_edge_id(const ctx_store_t *s);

/* ── Result codes ───────────────────────────────────────────────── */

#define CTX_STORE_OK 0
#define CTX_STORE_ERR (-1)
#define CTX_STORE_NOT_FOUND (-2)

/* ── Data structures ────────────────────────────────────────────── */

typedef struct {
    int64_t id;
    const char *project;
    const char *label;          /* Function, Class, Method, Module, File, ... */
    const char *name;           /* short name */
    const char *qualified_name; /* full dotted path */
    const char *file_path;      /* relative file path */
    int start_line;
    int end_line;
    const char *properties_json; /* JSON string, NULL → "{}" */
} ctx_node_t;

typedef struct {
    int64_t id;
    const char *project;
    int64_t source_id;
    int64_t target_id;
    const char *type;            /* CALLS, HTTP_CALLS, IMPORTS, ... */
    const char *properties_json; /* JSON string, NULL → "{}" */
} ctx_edge_t;

typedef struct {
    const char *name;
    const char *indexed_at; /* ISO 8601 */
    const char *root_path;
} ctx_project_t;

typedef struct {
    const char *project;
    const char *rel_path;
    const char *sha256;
    int64_t mtime_ns;
    int64_t size;
} ctx_file_hash_t;

/* Find nodes overlapping a line range in a file (excludes Module/Package). */
int ctx_store_find_nodes_by_file_overlap(ctx_store_t *s, const char *project, const char *file_path,
                                         int start_line, int end_line, ctx_node_t **out,
                                         int *count);

/* Find nodes whose qualified_name ends with the given suffix (dot-boundary). */
int ctx_store_find_nodes_by_qn_suffix(ctx_store_t *s, const char *project, const char *suffix,
                                      ctx_node_t **out, int *count);

/* Get CALLS degree of a node (inbound and outbound). */
void ctx_store_node_degree(ctx_store_t *s, int64_t node_id, int *in_deg, int *out_deg);

/* Get distinct file paths for a project. Caller must free each out[i] and out itself.
 * Returns CTX_STORE_OK or CTX_STORE_ERR. */
int ctx_store_list_files(ctx_store_t *s, const char *project, char ***out, int *count);

/* Get caller/callee names for a node (CALLS/HTTP_CALLS/ASYNC_CALLS edges).
 * Returns 0 on success. Caller must free each out_callers[i]/out_callees[i]
 * and the arrays themselves. */
int ctx_store_node_neighbor_names(ctx_store_t *s, int64_t node_id, int limit, char ***out_callers,
                                  int *caller_count, char ***out_callees, int *callee_count);

/* Batch count in/out degree for multiple nodes.
 * edge_type: filter by edge type (e.g. "CALLS"), or NULL/"" for all types.
 * out_in[i] and out_out[i] receive the in/out degree for node_ids[i].
 * Returns CTX_STORE_OK or CTX_STORE_ERR. */
int ctx_store_batch_count_degrees(ctx_store_t *s, const int64_t *node_ids, int id_count,
                                  const char *edge_type, int *out_in, int *out_out);

/* Upsert file hashes in batch. */
int ctx_store_upsert_file_hash_batch(ctx_store_t *s, const ctx_file_hash_t *hashes, int count);

/* Find edges whose properties contain a url_path matching the keyword. */
int ctx_store_find_edges_by_url_path(ctx_store_t *s, const char *project, const char *keyword,
                                     ctx_edge_t **out, int *count);

/* Restore database from another store (backup API). */
int ctx_store_restore_from(ctx_store_t *dst, ctx_store_t *src);

/* ── Search ─────────────────────────────────────────────────────── */

typedef struct {
    const char *project;
    const char *label;        /* NULL = any label */
    const char *name_pattern; /* regex on name, NULL = any */
    const char *qn_pattern;   /* regex on qualified_name, NULL = any */
    const char *file_pattern; /* glob on file_path, NULL = any */
    const char *relationship; /* edge type filter, NULL = any */
    const char *direction;    /* "inbound" / "outbound" / "any", NULL = any */
    int min_degree;           /* -1 = no filter (default), 0+ = minimum */
    int max_degree;           /* -1 = no filter (default), 0+ = maximum */
    int limit;                /* 0 = default (10) */
    int offset;
    bool exclude_entry_points;
    bool include_connected;
    const char *sort_by; /* "relevance" / "name" / "degree", NULL = relevance */
    bool case_sensitive;
    const char **exclude_labels; /* NULL-terminated array, or NULL */
} ctx_search_params_t;

typedef struct {
    ctx_node_t node;
    int in_degree;
    int out_degree;
    /* connected_names: allocated array of strings, count in connected_count */
    const char **connected_names;
    int connected_count;
} ctx_search_result_t;

typedef struct {
    ctx_search_result_t *results;
    int count;
    int total; /* total before pagination */
} ctx_search_output_t;

/* ── Traversal ──────────────────────────────────────────────────── */

typedef struct {
    ctx_node_t node;
    int hop; /* BFS depth from root */
} ctx_node_hop_t;

typedef struct {
    const char *from_name;
    const char *to_name;
    const char *type;
    double confidence;
} ctx_edge_info_t;

typedef struct {
    ctx_node_t root;
    ctx_node_hop_t *visited;
    int visited_count;
    ctx_edge_info_t *edges;
    int edge_count;
} ctx_traverse_result_t;

/* ── Schema introspection ───────────────────────────────────────── */

typedef struct {
    const char *label;
    int count;
} ctx_label_count_t;

typedef struct {
    const char *type;
    int count;
} ctx_type_count_t;

typedef struct {
    ctx_label_count_t *node_labels;
    int node_label_count;
    ctx_type_count_t *edge_types;
    int edge_type_count;
    /* relationship patterns like "(Function)-[CALLS]->(Function) [123x]" */
    const char **rel_patterns;
    int rel_pattern_count;
    const char **sample_func_names;
    int sample_func_count;
    const char **sample_class_names;
    int sample_class_count;
    const char **sample_qns;
    int sample_qn_count;
} ctx_schema_info_t;

/* ── Lifecycle ──────────────────────────────────────────────────── */

/* Open an in-memory database (for testing). */
ctx_store_t *ctx_store_open_memory(void);

/* Open a file-backed database at the given path. Creates if needed. */
ctx_store_t *ctx_store_open_path(const char *db_path);

/* Open an existing file-backed database for querying only (no SQLITE_OPEN_CREATE).
 * Returns NULL if the file does not exist — never creates a new .db file. */
ctx_store_t *ctx_store_open_path_query(const char *db_path);

/* Check database integrity. Returns true if the DB passes basic sanity checks
 * (projects table has correct types, no corruption indicators).
 * Returns false if corruption is detected — caller should delete and re-index. */
bool ctx_store_check_integrity(ctx_store_t *s);

/* Open database for a named project in the default cache dir. */
ctx_store_t *ctx_store_open(const char *project);

/* Close the store and free all resources. NULL-safe. */
void ctx_store_close(ctx_store_t *s);

/* Get the underlying sqlite3 handle (for testing only). */
struct sqlite3 *ctx_store_get_db(ctx_store_t *s);

/* Get the last error message (static string, valid until next call). */
const char *ctx_store_error(ctx_store_t *s);

/* ── Transaction ────────────────────────────────────────────────── */

/* Begin a transaction. Returns CTX_STORE_OK on success. */
int ctx_store_begin(ctx_store_t *s);

/* Commit the current transaction. */
int ctx_store_commit(ctx_store_t *s);

/* Rollback the current transaction. */
int ctx_store_rollback(ctx_store_t *s);

/* ── Bulk write optimization ────────────────────────────────────── */

/* Tune pragmas for bulk write throughput (synchronous=OFF, large cache).
 * WAL journal mode is preserved throughout for crash safety. */
int ctx_store_begin_bulk(ctx_store_t *s);

/* Restore normal pragmas (synchronous=NORMAL, default cache) after bulk writes. */
int ctx_store_end_bulk(ctx_store_t *s);

/* Drop user indexes for faster bulk inserts. */
int ctx_store_drop_indexes(ctx_store_t *s);

/* Recreate user indexes after bulk inserts. */
int ctx_store_create_indexes(ctx_store_t *s);

/* ── WAL / Checkpoint ───────────────────────────────────────────── */

/* Force WAL checkpoint + PRAGMA optimize. */
int ctx_store_checkpoint(ctx_store_t *s);

/* ── Dump / Restore ─────────────────────────────────────────────── */

/* Dump in-memory database to a file. */
int ctx_store_dump_to_file(ctx_store_t *s, const char *dest_path);

/* ── Project CRUD ───────────────────────────────────────────────── */

int ctx_store_upsert_project(ctx_store_t *s, const char *name, const char *root_path);
int ctx_store_get_project(ctx_store_t *s, const char *name, ctx_project_t *out);
int ctx_store_list_projects(ctx_store_t *s, ctx_project_t **out, int *count);
int ctx_store_delete_project(ctx_store_t *s, const char *name);

/* ── Node CRUD ──────────────────────────────────────────────────── */

/* Upsert a single node. Returns node ID (>0) or CTX_STORE_ERR. */
int64_t ctx_store_upsert_node(ctx_store_t *s, const ctx_node_t *n);

/* Upsert nodes in batch. out_ids must have room for count entries. */
int ctx_store_upsert_node_batch(ctx_store_t *s, const ctx_node_t *nodes, int count,
                                int64_t *out_ids);

/* Find node by primary key. Returns CTX_STORE_OK or CTX_STORE_NOT_FOUND. */
int ctx_store_find_node_by_id(ctx_store_t *s, int64_t id, ctx_node_t *out);

/* Find node by project + qualified_name. */
int ctx_store_find_node_by_qn(ctx_store_t *s, const char *project, const char *qn, ctx_node_t *out);

/* Find node by qualified_name only (no project filter — QNs are globally unique). */
int ctx_store_find_node_by_qn_any(ctx_store_t *s, const char *qn, ctx_node_t *out);

/* Find nodes by name (exact match). Returns allocated array, caller frees. */
int ctx_store_find_nodes_by_name(ctx_store_t *s, const char *project, const char *name,
                                 ctx_node_t **out, int *count);

/* Find nodes by name across all projects. Returns allocated array, caller frees. */
int ctx_store_find_nodes_by_name_any(ctx_store_t *s, const char *name, ctx_node_t **out,
                                     int *count);

/* Find nodes by label. */
int ctx_store_find_nodes_by_label(ctx_store_t *s, const char *project, const char *label,
                                  ctx_node_t **out, int *count);

/* Find nodes by file path. */
int ctx_store_find_nodes_by_file(ctx_store_t *s, const char *project, const char *file_path,
                                 ctx_node_t **out, int *count);

/* Batch lookup: map qualified names → node IDs.
 * qns[i] is resolved; out_ids[i] receives the ID or 0 if not found.
 * Returns number of QNs actually found, or CTX_STORE_ERR. */
int ctx_store_find_node_ids_by_qns(ctx_store_t *s, const char *project, const char **qns,
                                   int qn_count, int64_t *out_ids);

/* Count nodes in project. Returns count or CTX_STORE_ERR. */
int ctx_store_count_nodes(ctx_store_t *s, const char *project);

/* Delete all nodes for a project (cascade deletes edges). */
int ctx_store_delete_nodes_by_project(ctx_store_t *s, const char *project);

/* Delete nodes by file path. */
int ctx_store_delete_nodes_by_file(ctx_store_t *s, const char *project, const char *file_path);

/* Delete nodes by label. */
int ctx_store_delete_nodes_by_label(ctx_store_t *s, const char *project, const char *label);

/* ── Edge CRUD ──────────────────────────────────────────────────── */

/* Insert or update edge. Returns edge ID (>0) or CTX_STORE_ERR. */
int64_t ctx_store_insert_edge(ctx_store_t *s, const ctx_edge_t *e);

/* Insert edges in batch. */
int ctx_store_insert_edge_batch(ctx_store_t *s, const ctx_edge_t *edges, int count);

/* Find edges by source node. */
int ctx_store_find_edges_by_source(ctx_store_t *s, int64_t source_id, ctx_edge_t **out, int *count);

/* Find edges by target node. */
int ctx_store_find_edges_by_target(ctx_store_t *s, int64_t target_id, ctx_edge_t **out, int *count);

/* Find edges by source + type. */
int ctx_store_find_edges_by_source_type(ctx_store_t *s, int64_t source_id, const char *type,
                                        ctx_edge_t **out, int *count);

/* Find edges by target + type. */
int ctx_store_find_edges_by_target_type(ctx_store_t *s, int64_t target_id, const char *type,
                                        ctx_edge_t **out, int *count);

/* Find all edges of a type in project. */
int ctx_store_find_edges_by_type(ctx_store_t *s, const char *project, const char *type,
                                 ctx_edge_t **out, int *count);

/* Count all edges in project. */
int ctx_store_count_edges(ctx_store_t *s, const char *project);

/* Count edges of given type. */
int ctx_store_count_edges_by_type(ctx_store_t *s, const char *project, const char *type);

/* Delete all edges for a project. */
int ctx_store_delete_edges_by_project(ctx_store_t *s, const char *project);

/* Delete edges by type. */
int ctx_store_delete_edges_by_type(ctx_store_t *s, const char *project, const char *type);

/* ── File hash CRUD ─────────────────────────────────────────────── */

int ctx_store_upsert_file_hash(ctx_store_t *s, const char *project, const char *rel_path,
                               const char *sha256, int64_t mtime_ns, int64_t size);

int ctx_store_get_file_hashes(ctx_store_t *s, const char *project, ctx_file_hash_t **out,
                              int *count);

int ctx_store_delete_file_hash(ctx_store_t *s, const char *project, const char *rel_path);

int ctx_store_delete_file_hashes(ctx_store_t *s, const char *project);

/* ── Search ─────────────────────────────────────────────────────── */

int ctx_store_search(ctx_store_t *s, const ctx_search_params_t *params, ctx_search_output_t *out);

/* Free a search output's allocated memory. */
void ctx_store_search_free(ctx_search_output_t *out);

/* ── Traversal ──────────────────────────────────────────────────── */

int ctx_store_bfs(ctx_store_t *s, int64_t start_id, const char *direction, const char **edge_types,
                  int edge_type_count, int max_depth, int max_results, ctx_traverse_result_t *out);

/* Free a traverse result's allocated memory. */
void ctx_store_traverse_free(ctx_traverse_result_t *out);

/* ── Impact analysis ────────────────────────────────────────────── */

typedef enum {
    CTX_RISK_CRITICAL = 0,
    CTX_RISK_HIGH = 1,
    CTX_RISK_MEDIUM = 2,
    CTX_RISK_LOW = 3,
} ctx_risk_level_t;

/* Map BFS hop depth to risk level. */
ctx_risk_level_t ctx_hop_to_risk(int hop);

/* String representation of risk level. */
const char *ctx_risk_label(ctx_risk_level_t level);

typedef struct {
    int critical;
    int high;
    int medium;
    int low;
    int total;
    bool has_cross_service;
} ctx_impact_summary_t;

/* Build impact summary from visited hops and edges. */
ctx_impact_summary_t ctx_build_impact_summary(const ctx_node_hop_t *hops, int hop_count,
                                              const ctx_edge_info_t *edges, int edge_count);

/* Deduplicate BFS hops, keeping minimum hop per node ID.
 * Returns allocated array and count via out params. Caller frees result. */
int ctx_deduplicate_hops(const ctx_node_hop_t *hops, int hop_count, ctx_node_hop_t **out,
                         int *out_count);

/* ── Schema ─────────────────────────────────────────────────────── */

int ctx_store_get_schema(ctx_store_t *s, const char *project, ctx_schema_info_t *out);

/* Free a schema info's allocated memory. */
void ctx_store_schema_free(ctx_schema_info_t *out);

/* ── Architecture ───────────────────────────────────────────────── */

typedef struct {
    const char *language;
    int file_count;
} ctx_language_count_t;

typedef struct {
    const char *name;
    int node_count;
    int fan_in;
    int fan_out;
} ctx_package_summary_t;

typedef struct {
    const char *name;
    const char *qualified_name;
    const char *file;
} ctx_entry_point_t;

typedef struct {
    const char *method;
    const char *path;
    const char *handler;
} ctx_route_info_t;

typedef struct {
    const char *name;
    const char *qualified_name;
    int fan_in;
} ctx_hotspot_t;

typedef struct {
    const char *from;
    const char *to;
    int call_count;
} ctx_cross_pkg_boundary_t;

typedef struct {
    const char *from;
    const char *to;
    const char *type;
    int count;
} ctx_service_link_t;

typedef struct {
    const char *name;
    const char *layer;
    const char *reason;
} ctx_package_layer_t;

typedef struct {
    int id;
    const char *label;
    int members;
    double cohesion;
    const char **top_nodes;
    int top_node_count;
    const char **packages;
    int package_count;
    const char **edge_types;
    int edge_type_count;
} ctx_cluster_info_t;

typedef struct {
    const char *path;
    const char *type; /* "dir" or "file" */
    int children;
} ctx_file_tree_entry_t;

typedef struct {
    /* Pointers first to minimize padding */
    ctx_language_count_t *languages;
    ctx_package_summary_t *packages;
    ctx_entry_point_t *entry_points;
    ctx_route_info_t *routes;
    ctx_hotspot_t *hotspots;
    ctx_cross_pkg_boundary_t *boundaries;
    ctx_service_link_t *services;
    ctx_package_layer_t *layers;
    ctx_cluster_info_t *clusters;
    ctx_file_tree_entry_t *file_tree;
    /* Counts after pointers */
    int language_count;
    int package_count;
    int entry_point_count;
    int route_count;
    int hotspot_count;
    int boundary_count;
    int service_count;
    int layer_count;
    int cluster_count;
    int file_tree_count;
} ctx_architecture_info_t;

int ctx_store_get_architecture(ctx_store_t *s, const char *project, const char **aspects,
                               int aspect_count, ctx_architecture_info_t *out);
void ctx_store_architecture_free(ctx_architecture_info_t *out);

/* ── ADR (Architecture Decision Record) ────────────────────────── */

#define CTX_ADR_MAX_LENGTH 8000

typedef struct {
    const char *project;
    const char *content;
    const char *created_at;
    const char *updated_at;
} ctx_adr_t;

int ctx_store_adr_store(ctx_store_t *s, const char *project, const char *content);
int ctx_store_adr_get(ctx_store_t *s, const char *project, ctx_adr_t *out);
int ctx_store_adr_delete(ctx_store_t *s, const char *project);
int ctx_store_adr_update_sections(ctx_store_t *s, const char *project, const char **keys,
                                  const char **values, int count, ctx_adr_t *out);
void ctx_store_adr_free(ctx_adr_t *adr);

/* ADR section parsing/rendering (pure functions, no store needed) */

enum { PROPS_MAX = 16 };

typedef struct {
    char *keys[PROPS_MAX];
    char *values[PROPS_MAX];
    int count;
} ctx_adr_sections_t;

ctx_adr_sections_t ctx_adr_parse_sections(const char *content);
char *ctx_adr_render(const ctx_adr_sections_t *sections);
int ctx_adr_validate_content(const char *content, char *errbuf, int errbuf_size);
int ctx_adr_validate_section_keys(const char **keys, int count, char *errbuf, int errbuf_size);
void ctx_adr_sections_free(ctx_adr_sections_t *s);

/* ── Search helpers (exposed for testing) ───────────────────────── */

/* Convert a glob pattern to SQL LIKE pattern. Caller must free result. */
char *ctx_glob_to_like(const char *pattern);

/* Extract literal substrings (>= 3 chars) from a regex pattern for LIKE pre-filtering.
 * Bails on alternation (|). Returns count of hints written to out[].
 * Each out[i] is malloc'd — caller must free each string. */
int ctx_extract_like_hints(const char *pattern, char **out, int max_out);

/* Prepend (?i) to a regex pattern if not already present.
 * Returns a static buffer — do NOT free. */
const char *ctx_ensure_case_insensitive(const char *pattern);

/* Strip leading (?i) from a regex pattern.
 * Returns a static buffer — do NOT free. */
const char *ctx_strip_case_flag(const char *pattern);

/* ── Architecture helpers (exposed for testing) ────────────────── */

const char *ctx_qn_to_package(const char *qn);
const char *ctx_qn_to_top_package(const char *qn);
bool ctx_is_test_file_path(const char *fp);
int ctx_store_find_architecture_docs(ctx_store_t *s, const char *project, char ***out, int *count);

/* ── Louvain algorithm ─────────────────────────────────────────── */

typedef struct {
    int64_t src;
    int64_t dst;
} ctx_louvain_edge_t;

typedef struct {
    int64_t node_id;
    int community;
} ctx_louvain_result_t;

int ctx_louvain(const int64_t *nodes, int node_count, const ctx_louvain_edge_t *edges,
                int edge_count, ctx_louvain_result_t **out, int *out_count);

/* ── Memory management helpers ──────────────────────────────────── */

/* Free heap-allocated strings in a stack-allocated node (does NOT free the node itself). */
void ctx_node_free_fields(ctx_node_t *n);

/* Free heap-allocated strings in a stack-allocated project (does NOT free the project itself). */
void ctx_project_free_fields(ctx_project_t *p);

/* Free an array of nodes returned by find_nodes_by_* functions. */
void ctx_store_free_nodes(ctx_node_t *nodes, int count);

/* Free an array of edges returned by find_edges_by_* functions. */
void ctx_store_free_edges(ctx_edge_t *edges, int count);

/* Free an array of projects. */
void ctx_store_free_projects(ctx_project_t *projects, int count);

/* Free an array of file hashes. */
void ctx_store_free_file_hashes(ctx_file_hash_t *hashes, int count);

/* ── Vector search ───────────────────────────────────────────────── */

/* Result from vector similarity search. */
typedef struct {
    int64_t node_id;
    char *name;
    char *qualified_name;
    char *file_path;
    char *label;
    double score;
} ctx_vector_result_t;

/* Search for nodes similar to the given query keywords using stored RI vectors.
 * Builds a merged query vector from the keywords, then does cosine scan via
 * the ctx_cosine_i8 SQL function joined with the nodes table.
 * Returns results sorted by score DESC. Caller must free with ctx_store_free_vector_results. */
int ctx_store_vector_search(ctx_store_t *s, const char *project, const char **keywords,
                            int keyword_count, int limit, ctx_vector_result_t **out,
                            int *out_count);

/* Free vector search results. */
void ctx_store_free_vector_results(ctx_vector_result_t *results, int count);

/* Count vectors for a project. */
int ctx_store_count_vectors(ctx_store_t *s, const char *project);

/* Execute an arbitrary SQL statement (pragmas, FTS5 maintenance, etc).
 * Returns CTX_STORE_OK on success. */
int ctx_store_exec(ctx_store_t *s, const char *sql);

#endif /* CTX_STORE_H */

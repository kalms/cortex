/*
 * handlers.c — Tool handlers for the cortex-indexer CLI.
 *
 * Implements the 14 graph analysis tools (search, trace, query, index, etc.)
 * dispatched by ctx_mcp_handle_tool. Used by main.c::run_cli.
 *
 * Uses yyjson for fast JSON parsing/building.
 */

#include "foundation/constants.h"

enum {
    MCP_FIELD_SIZE = 1040,
    MCP_HALF_SEC_US = 500000,
    MCP_MAX_ROWS = 100,
    MCP_MAX_DEPTH = 15,
    MCP_COL_2 = 2,
    MCP_COL_3 = 3,
    MCP_COL_4 = 4,
    MCP_COL_7 = 7,
    MCP_COL_10 = 10,
    MCP_COL_16 = 16,
    MCP_DB_EXT = 3,      /* strlen(".db") */
    MCP_MIN_DB_NAME = 4, /* min length for "x.db" */
    MCP_SEPARATOR = 2,   /* space for separator chars */
    MCP_DEFAULT_DEPTH = 3,
    MCP_DEFAULT_BFS_DEPTH = 2,
    MCP_DEFAULT_LIMIT = 10,
    MCP_BFS_LIMIT = 100,
    MCP_N_DEFAULTS_2 = 2,
    MCP_N_DEFAULTS_4 = 4,
    MCP_RETURN_2 = 2,
};

#define SLEN(s) (sizeof(s) - 1)
#include "handlers/handlers.h"
#include "store/store.h"
#include <sqlite3.h>
#include "cypher/cypher.h"
#include "pipeline/pipeline.h"
#include "foundation/mem.h"
#include "foundation/diagnostics.h"
#include "foundation/platform.h"
#include "foundation/compat.h"
#include "foundation/compat_fs.h"
#include "foundation/log.h"
#include "foundation/str_util.h"
#include "foundation/compat_regex.h"

#ifdef _WIN32
#include <process.h> /* _getpid */
#else
#include <unistd.h>
#endif
#include <yyjson/yyjson.h>
#include <stdint.h> // int64_t
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

/* ── Constants ────────────────────────────────────────────────── */

/* Default snippet fallback line count */
#define SNIPPET_DEFAULT_LINES 50

/* Directory permissions: rwxr-xr-x */
#define ADR_DIR_PERMS 0755

/* ── Helpers ────────────────────────────────────────────────────── */

static char *heap_strdup(const char *s) {
    if (!s) {
        return NULL;
    }
    size_t len = strlen(s);
    char *d = malloc(len + SKIP_ONE);
    if (d) {
        memcpy(d, s, len + SKIP_ONE);
    }
    return d;
}

/* Write yyjson_mut_doc to heap-allocated JSON string.
 * ALLOW_INVALID_UNICODE: some database strings may contain non-UTF-8 bytes
 * from older indexing runs — don't fail serialization over it. */
static char *yy_doc_to_str(yyjson_mut_doc *doc) {
    size_t len = 0;
    char *s = yyjson_mut_write(doc, YYJSON_WRITE_ALLOW_INVALID_UNICODE, &len);
    return s;
}

/* ══════════════════════════════════════════════════════════════════
 *  MCP PROTOCOL HELPERS
 * ══════════════════════════════════════════════════════════════════ */

char *ctx_mcp_text_result(const char *text, bool is_error) {
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    yyjson_mut_val *content = yyjson_mut_arr(doc);
    yyjson_mut_val *item = yyjson_mut_obj(doc);
    yyjson_mut_obj_add_str(doc, item, "type", "text");
    yyjson_mut_obj_add_str(doc, item, "text", text);
    yyjson_mut_arr_add_val(content, item);
    yyjson_mut_obj_add_val(doc, root, "content", content);

    if (is_error) {
        yyjson_mut_obj_add_bool(doc, root, "isError", true);
    }

    char *out = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    return out;
}

char *ctx_mcp_get_string_arg(const char *args_json, const char *key) {
    yyjson_doc *doc = yyjson_read(args_json, strlen(args_json), 0);
    if (!doc) {
        return NULL;
    }
    yyjson_val *root = yyjson_doc_get_root(doc);
    yyjson_val *val = yyjson_obj_get(root, key);
    char *result = NULL;
    if (val && yyjson_is_str(val)) {
        result = heap_strdup(yyjson_get_str(val));
    }
    yyjson_doc_free(doc);
    return result;
}

int ctx_mcp_get_int_arg(const char *args_json, const char *key, int default_val) {
    yyjson_doc *doc = yyjson_read(args_json, strlen(args_json), 0);
    if (!doc) {
        return default_val;
    }
    yyjson_val *root = yyjson_doc_get_root(doc);
    yyjson_val *val = yyjson_obj_get(root, key);
    int result = default_val;
    if (val && yyjson_is_int(val)) {
        result = yyjson_get_int(val);
    }
    yyjson_doc_free(doc);
    return result;
}

bool ctx_mcp_get_bool_arg(const char *args_json, const char *key) {
    yyjson_doc *doc = yyjson_read(args_json, strlen(args_json), 0);
    if (!doc) {
        return false;
    }
    yyjson_val *root = yyjson_doc_get_root(doc);
    yyjson_val *val = yyjson_obj_get(root, key);
    bool result = false;
    if (val && yyjson_is_bool(val)) {
        result = yyjson_get_bool(val);
    }
    yyjson_doc_free(doc);
    return result;
}

/* ══════════════════════════════════════════════════════════════════
 *  MCP SERVER
 * ══════════════════════════════════════════════════════════════════ */

struct ctx_mcp_server {
    ctx_store_t *store;    /* currently open project store (or NULL) */
    bool owns_store;       /* true if we opened the store */
    char *current_project; /* which project store is open for (heap) */
};

ctx_mcp_server_t *ctx_mcp_server_new(const char *store_path) {
    ctx_mcp_server_t *srv = calloc(CTX_ALLOC_ONE, sizeof(*srv));
    if (!srv) {
        return NULL;
    }

    /* If a store_path is given, open that project directly.
     * Otherwise, create an in-memory store for test/embedded use. */
    if (store_path) {
        srv->store = ctx_store_open(store_path);
        srv->current_project = heap_strdup(store_path);
    } else {
        srv->store = ctx_store_open_memory();
    }
    srv->owns_store = true;

    return srv;
}

void ctx_mcp_server_free(ctx_mcp_server_t *srv) {
    if (!srv) {
        return;
    }
    if (srv->owns_store && srv->store) {
        ctx_store_close(srv->store);
    }
    free(srv->current_project);
    free(srv);
}

/* ── Cache dir + project DB path helpers ───────────────────────── */

/* Returns the cache directory. Writes to buf, returns buf for convenience. */
static const char *cache_dir(char *buf, size_t bufsz) {
    const char *dir = ctx_resolve_cache_dir();
    if (!dir) {
        dir = ctx_tmpdir();
    }
    snprintf(buf, bufsz, "%s", dir);
    return buf;
}

/* Returns full .db path for an explicitly-named project: <cache_dir>/<project>.db.
 * Deliberately bypasses CORTEX_DB env override — that override exists for
 * embedders (Cortex Vue) to redirect the indexer's write path to a custom
 * file, but it must NOT hijack per-project query routing. Without this
 * separation, a tool call like `get_architecture(project="X")` issued from
 * an MCP server that has CORTEX_DB set ends up opening the env-named DB
 * (typically the bound project's local .cortex/db) and reports "project
 * not found" for X — even when X is fully indexed in the cache. Pipeline
 * writes still go through ctx_resolve_db_path so the env override holds
 * where it's wanted. */
static const char *project_db_path(const char *project, char *buf, size_t bufsz) {
    return ctx_cache_db_path(project, buf, bufsz);
}

/* ── Store resolution ──────────────────────────────────────────── */

/* Open the right project's .db file for query tools.
 * Caches the connection — reopens only when the project changes. */
static ctx_store_t *resolve_store(ctx_mcp_server_t *srv, const char *project) {
    if (!project) {
        return NULL; /* project is required — no implicit fallback */
    }

    /* Already open for this project? */
    if (srv->current_project && strcmp(srv->current_project, project) == 0 && srv->store) {
        return srv->store;
    }

    /* Close old store */
    if (srv->owns_store && srv->store) {
        ctx_store_close(srv->store);
        srv->store = NULL;
    }

    /* Open project's .db file — query-only open (no SQLITE_OPEN_CREATE) to
     * prevent ghost .db file creation for unknown/unindexed projects. */
    char path[CTX_SZ_1K];
    project_db_path(project, path, sizeof(path));
    srv->store = ctx_store_open_path_query(path);
    if (srv->store) {
        /* Check DB integrity — auto-clean corrupt databases */
        if (!ctx_store_check_integrity(srv->store)) {
            ctx_log_error("store.auto_clean", "project", project, "path", path, "action",
                          "deleting corrupt db — re-index required");
            ctx_store_close(srv->store);
            srv->store = NULL;
            /* Delete the corrupt DB + WAL/SHM files */
            ctx_unlink(path);
            char wal_path[MCP_FIELD_SIZE];
            char shm_path[MCP_FIELD_SIZE];
            snprintf(wal_path, sizeof(wal_path), "%s-wal", path);
            snprintf(shm_path, sizeof(shm_path), "%s-shm", path);
            ctx_unlink(wal_path);
            ctx_unlink(shm_path);
            return NULL;
        }

        /* Verify the project actually exists in this database.
         * A .db file may exist but be empty (e.g., after delete_project on
         * Linux where unlink defers actual removal). Opening an empty/deleted
         * store without closing it leaks the SQLite connection. */
        ctx_project_t proj_verify = {0};
        if (ctx_store_get_project(srv->store, project, &proj_verify) != CTX_STORE_OK) {
            ctx_store_close(srv->store);
            srv->store = NULL;
            return NULL;
        }
        ctx_project_free_fields(&proj_verify);
        srv->owns_store = true;
        free(srv->current_project);
        srv->current_project = heap_strdup(project);
    }

    return srv->store;
}

/* Scan cache dir for .db files, writing comma-separated quoted names into out.
 * Returns the number of projects found. */
static int collect_db_project_names(const char *dir_path, char *out, size_t out_sz) {
    int count = 0;
    int offset = 0;
    ctx_dir_t *d = ctx_opendir(dir_path);
    if (!d) {
        return 0;
    }
    ctx_dirent_t *entry;
    while ((entry = ctx_readdir(d)) != NULL) {
        const char *n = entry->name;
        size_t len = strlen(n);
        if (len < MCP_MIN_DB_NAME || strcmp(n + len - MCP_DB_EXT, ".db") != 0) {
            continue;
        }
        if (strncmp(n, "tmp-", SLEN("tmp-")) == 0 || strncmp(n, "_", SLEN("_")) == 0) {
            continue;
        }
        if (count > 0 && offset < (int)out_sz - MCP_SEPARATOR) {
            out[offset++] = ',';
        }
        int wrote = snprintf(out + offset, out_sz - (size_t)offset, "\"%.*s\"", (int)(len - 3), n);
        if (wrote > 0) {
            offset += wrote;
        }
        count++;
    }
    ctx_closedir(d);
    return count;
}

/* Build a helpful error listing available projects. Caller must free() result. */
static char *build_project_list_error(const char *reason) {
    char dir_path[CTX_SZ_1K];
    cache_dir(dir_path, sizeof(dir_path));

    char projects[CTX_SZ_4K] = "";
    int count = collect_db_project_names(dir_path, projects, sizeof(projects));

    enum { ERR_BUF_SZ = 5120 };
    char buf[ERR_BUF_SZ];
    if (count > 0) {
        snprintf(buf, sizeof(buf),
                 "{\"error\":\"%s\",\"hint\":\"Use list_projects to see all indexed projects, "
                 "then pass the project name.\",\"available_projects\":[%s],\"count\":%d}",
                 reason, projects, count);
    } else {
        snprintf(buf, sizeof(buf),
                 "{\"error\":\"%s\",\"hint\":\"No projects indexed yet. "
                 "Call index_repository first.\"}",
                 reason);
    }
    return heap_strdup(buf);
}

/* Bail with project list when no store is available. */
#define REQUIRE_STORE(store, project)                                                  \
    do {                                                                               \
        if (!(store)) {                                                                \
            char *_err = build_project_list_error("project not found or not indexed"); \
            char *_res = ctx_mcp_text_result(_err, true);                              \
            free(_err);                                                                \
            free(project);                                                             \
            return _res;                                                               \
        }                                                                              \
    } while (0)

/* ── Tool handler implementations ─────────────────────────────── */

/* Return true if filename is a valid project .db file (not temp/internal). */
static bool is_project_db_file(const char *name, size_t len) {
    if (len < MCP_MIN_DB_NAME || strcmp(name + len - MCP_DB_EXT, ".db") != 0) {
        return false;
    }
    if (strncmp(name, "tmp-", SLEN("tmp-")) == 0 || strncmp(name, "_", SLEN("_")) == 0 ||
        strncmp(name, ":memory:", SLEN(":memory:")) == 0) {
        return false;
    }
    return true;
}

/* Open a .db file briefly, collect node/edge counts and root_path,
 * then append a JSON entry to arr. */
static void build_project_json_entry(yyjson_mut_doc *doc, yyjson_mut_val *arr, const char *dir_path,
                                     const char *name, size_t name_len, const struct stat *st) {
    char project_name[CTX_SZ_1K];
    snprintf(project_name, sizeof(project_name), "%.*s", (int)(name_len - 3), name);

    char full_path[CTX_SZ_2K];
    snprintf(full_path, sizeof(full_path), "%s/%s", dir_path, name);

    ctx_store_t *pstore = ctx_store_open_path(full_path);
    int nodes = 0;
    int edges = 0;
    char root_path_buf[CTX_SZ_1K] = "";
    if (pstore) {
        nodes = ctx_store_count_nodes(pstore, project_name);
        edges = ctx_store_count_edges(pstore, project_name);
        ctx_project_t proj = {0};
        if (ctx_store_get_project(pstore, project_name, &proj) == CTX_STORE_OK) {
            if (proj.root_path) {
                snprintf(root_path_buf, sizeof(root_path_buf), "%s", proj.root_path);
            }
            free((void *)proj.name);
            free((void *)proj.indexed_at);
            free((void *)proj.root_path);
        }
        ctx_store_close(pstore);
    }

    yyjson_mut_val *p = yyjson_mut_obj(doc);
    yyjson_mut_obj_add_strcpy(doc, p, "name", project_name);
    yyjson_mut_obj_add_strcpy(doc, p, "root_path", root_path_buf);
    yyjson_mut_obj_add_int(doc, p, "nodes", nodes);
    yyjson_mut_obj_add_int(doc, p, "edges", edges);
    yyjson_mut_obj_add_int(doc, p, "size_bytes", (int64_t)st->st_size);
    yyjson_mut_arr_add_val(arr, p);
}

/* list_projects: scan cache directory for .db files.
 * Each project is a single .db file — no central registry needed. */
static char *handle_list_projects(ctx_mcp_server_t *srv, const char *args) {
    (void)srv;
    (void)args;

    char dir_path[CTX_SZ_1K];
    cache_dir(dir_path, sizeof(dir_path));

    ctx_dir_t *d = ctx_opendir(dir_path);

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_val *arr = yyjson_mut_arr(doc);

    if (d) {
        ctx_dirent_t *entry;
        while ((entry = ctx_readdir(d)) != NULL) {
            const char *name = entry->name;
            size_t len = strlen(name);
            if (!is_project_db_file(name, len)) {
                continue;
            }
            char full_path[CTX_SZ_2K];
            snprintf(full_path, sizeof(full_path), "%s/%s", dir_path, name);
            struct stat st;
            if (stat(full_path, &st) != 0) {
                continue;
            }
            build_project_json_entry(doc, arr, dir_path, name, len, &st);
        }
        ctx_closedir(d);
    }

    yyjson_mut_obj_add_val(doc, root, "projects", arr);

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* verify_project_indexed — returns a heap-allocated error JSON string when the
 * named project has not been indexed yet, or NULL when the project exists.
 * resolve_store uses ctx_store_open_path_query (no SQLITE_OPEN_CREATE), so
 * store is NULL for missing .db files (REQUIRE_STORE fires first). This
 * function catches the remaining case: a .db file exists but has no indexed
 * nodes (e.g., an empty or half-initialised project).
 * Callers that receive a non-NULL return value must free(project) themselves
 * before returning the error string. */
static char *verify_project_indexed(ctx_store_t *store, const char *project) {
    ctx_project_t proj_check = {0};
    if (ctx_store_get_project(store, project, &proj_check) != CTX_STORE_OK) {
        return ctx_mcp_text_result(
            "{\"error\":\"project not indexed — run index_repository first\"}", true);
    }
    ctx_project_free_fields(&proj_check);
    return NULL;
}

static char *handle_get_graph_schema(ctx_mcp_server_t *srv, const char *args) {
    char *project = ctx_mcp_get_string_arg(args, "project");
    ctx_store_t *store = resolve_store(srv, project);
    REQUIRE_STORE(store, project);

    char *not_indexed = verify_project_indexed(store, project);
    if (not_indexed) {
        free(project);
        return not_indexed;
    }

    ctx_schema_info_t schema = {0};
    ctx_store_get_schema(store, project, &schema);

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    yyjson_mut_val *labels = yyjson_mut_arr(doc);
    for (int i = 0; i < schema.node_label_count; i++) {
        yyjson_mut_val *lbl = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_str(doc, lbl, "label", schema.node_labels[i].label);
        yyjson_mut_obj_add_int(doc, lbl, "count", schema.node_labels[i].count);
        yyjson_mut_arr_add_val(labels, lbl);
    }
    yyjson_mut_obj_add_val(doc, root, "node_labels", labels);

    yyjson_mut_val *types = yyjson_mut_arr(doc);
    for (int i = 0; i < schema.edge_type_count; i++) {
        yyjson_mut_val *typ = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_str(doc, typ, "type", schema.edge_types[i].type);
        yyjson_mut_obj_add_int(doc, typ, "count", schema.edge_types[i].count);
        yyjson_mut_arr_add_val(types, typ);
    }
    yyjson_mut_obj_add_val(doc, root, "edge_types", types);

    /* Check ADR presence */
    ctx_project_t proj_info = {0};
    if (ctx_store_get_project(store, project, &proj_info) == 0 && proj_info.root_path) {
        char adr_path[CTX_SZ_4K];
        snprintf(adr_path, sizeof(adr_path), "%s/.codebase-memory/adr.md", proj_info.root_path);
        struct stat adr_st;
        bool adr_exists = (stat(adr_path, &adr_st) == 0);
        yyjson_mut_obj_add_bool(doc, root, "adr_present", adr_exists);
        if (!adr_exists) {
            yyjson_mut_obj_add_str(
                doc, root, "adr_hint",
                "No ADR found. Use manage_adr(mode='update') to persist architectural "
                "decisions across sessions. Run get_architecture(aspects=['all']) first.");
        }
        ctx_project_free_fields(&proj_info);
    }

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    ctx_store_schema_free(&schema);
    free(project);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* Validate edge type: uppercase letters + underscore only, max 64 chars. */
static bool validate_edge_type(const char *s) {
    if (!s || strlen(s) > CTX_SZ_64) {
        return false;
    }
    for (const char *c = s; *c; c++) {
        if (!(*c >= 'A' && *c <= 'Z') && *c != '_') {
            return false;
        }
    }
    return true;
}

/* Enrich search result with 1-hop connected node names. */
/* Add BFS results to a yyjson array (deduped by name). */
static void enrich_add_bfs(yyjson_mut_doc *doc, yyjson_mut_val *arr, ctx_traverse_result_t *tr) {
    for (int j = 0; j < tr->visited_count; j++) {
        if (tr->visited[j].node.name) {
            yyjson_mut_arr_add_strcpy(doc, arr, tr->visited[j].node.name);
        }
    }
}

/* Enrich search result with 1-hop connected node names (inbound + outbound). */
static void enrich_connected(yyjson_mut_doc *doc, yyjson_mut_val *item, ctx_store_t *store,
                             int64_t node_id, const char *relationship) {
    const char *et[] = {relationship ? relationship : "CALLS"};
    yyjson_mut_val *conn = yyjson_mut_arr(doc);

    /* BFS doesn't support "both" — run inbound + outbound separately. */
    ctx_traverse_result_t tr_in = {0};
    ctx_store_bfs(store, node_id, "inbound", et, SKIP_ONE, SKIP_ONE, MCP_DEFAULT_LIMIT, &tr_in);
    enrich_add_bfs(doc, conn, &tr_in);
    ctx_store_traverse_free(&tr_in);

    ctx_traverse_result_t tr_out = {0};
    ctx_store_bfs(store, node_id, "outbound", et, SKIP_ONE, SKIP_ONE, MCP_DEFAULT_LIMIT, &tr_out);
    enrich_add_bfs(doc, conn, &tr_out);
    ctx_store_traverse_free(&tr_out);

    if (yyjson_mut_arr_size(conn) > 0) {
        yyjson_mut_obj_add_val(doc, item, "connected_names", conn);
    }
}

/* Build an FTS5 MATCH expression from a free-form query string by splitting
 * on whitespace and joining the terms with OR.  Each token is also sanitized:
 * anything that isn't alnum or underscore is dropped, so the caller can't
 * inject FTS5 operators or double-quoted phrases.  Returns the number of
 * tokens emitted (0 if the query contained no usable terms). */
enum {
    BM25_MIN_BUF = 2, /* minimum buffer size: at least NUL + one char */
    BM25_SEP_RESERVE = 1,
    BM25_QUERY_BUF = 1024,
    BM25_DEFAULT_LIMIT = 100,
    BM25_COL_ID = 0,
    BM25_COL_LABEL = 1,
    BM25_COL_NAME = 2,
    BM25_COL_QN = 3,
    BM25_COL_FILE = 4,
    BM25_COL_START = 5,
    BM25_COL_END = 6,
    BM25_COL_RANK = 7,
    BM25_BIND_QUERY = 1,
    BM25_BIND_PROJECT = 2,
    BM25_BIND_LIMIT = 3,
    BM25_BIND_OFFSET = 4,
    BM25_SQL_AUTO_LEN = -1,
};

/* Module-local SQLITE_TRANSIENT wrapper to dodge performance-no-int-to-ptr.
 * See the matching helper in src/store/store.c for the same pattern. */
static sqlite3_destructor_type mcp_sqlite_transient(void) {
    static const volatile intptr_t raw = -1;
    sqlite3_destructor_type dtor = NULL;
    memcpy(&dtor, (const void *)&raw, sizeof(dtor));
    return dtor;
}
#define MCP_SQLITE_TRANSIENT (mcp_sqlite_transient())

static int bm25_build_match(const char *query, char *out, size_t out_size) {
    if (!query || !out || out_size < BM25_MIN_BUF) {
        return 0;
    }
    size_t pos = 0;
    int tokens = 0;
    const char *p = query;
    while (*p) {
        while (*p && !((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
                       (*p >= '0' && *p <= '9') || *p == '_')) {
            p++;
        }
        if (!*p) {
            break;
        }
        const char *tok_start = p;
        while (*p && ((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
                      (*p >= '0' && *p <= '9') || *p == '_')) {
            p++;
        }
        size_t tok_len = (size_t)(p - tok_start);
        if (tok_len == 0) {
            continue;
        }
        const char *sep = (tokens > 0) ? " OR " : "";
        size_t sep_len = strlen(sep);
        if (pos + sep_len + tok_len + BM25_SEP_RESERVE >= out_size) {
            break; /* out of room — stop cleanly, keep what we have */
        }
        memcpy(out + pos, sep, sep_len);
        pos += sep_len;
        memcpy(out + pos, tok_start, tok_len);
        pos += tok_len;
        tokens++;
    }
    out[pos] = '\0';
    return tokens;
}

/* Run the BM25 full-text search path and return the JSON result string.
 * Returns NULL if FTS5 is unavailable or the query produced no usable tokens,
 * in which case the caller falls back to the regex-based search path. */
static char *bm25_search(ctx_store_t *store, const char *project, const char *query, int limit,
                         int offset) {
    sqlite3 *db = ctx_store_get_db(store);
    if (!db) {
        return NULL;
    }
    char fts_query[BM25_QUERY_BUF];
    int tok_count = bm25_build_match(query, fts_query, sizeof(fts_query));
    if (tok_count == 0) {
        return NULL;
    }

    /* BM25 ranked query with structural label boosting.  bm25() returns a
     * NEGATIVE score (lower = more relevant), so we subtract the boost to
     * make high-value labels sort first.  File/Folder/Module/Variable are
     * excluded entirely — agents rarely want those as discovery results. */
    const char *sql =
        "SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.start_line, n.end_line, "
        "       (bm25(ctx_nodes_fts) "
        "        - CASE WHEN n.kind IN ('function','method') THEN 10.0 "
        "               WHEN n.kind = 'route' THEN 8.0 "
        "               WHEN n.kind IN ('class','interface','type','enum') THEN 5.0 "
        "               ELSE 0.0 END) AS rank "
        "FROM ctx_nodes_fts "
        "JOIN nodes n ON n.id = 'ctx-' || ctx_nodes_fts.rowid "
        "WHERE ctx_nodes_fts MATCH ?1 "
        "  AND n.project = ?2 "
        "  AND n.kind NOT IN ('file','folder','module','section','variable','project') "
        "ORDER BY rank "
        "LIMIT ?3 OFFSET ?4";

    sqlite3_stmt *stmt = NULL;
    if (sqlite3_prepare_v2(db, sql, BM25_SQL_AUTO_LEN, &stmt, NULL) != SQLITE_OK) {
        return NULL;
    }
    sqlite3_bind_text(stmt, BM25_BIND_QUERY, fts_query, BM25_SQL_AUTO_LEN, MCP_SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, BM25_BIND_PROJECT, project, BM25_SQL_AUTO_LEN, MCP_SQLITE_TRANSIENT);
    sqlite3_bind_int(stmt, BM25_BIND_LIMIT, limit > 0 ? limit : BM25_DEFAULT_LIMIT);
    sqlite3_bind_int(stmt, BM25_BIND_OFFSET, offset > 0 ? offset : 0);

    /* Count total hits (for pagination) in a separate cheap query. */
    int total = 0;
    {
        const char *count_sql =
            "SELECT COUNT(*) FROM ctx_nodes_fts JOIN nodes n ON n.id = 'ctx-' || ctx_nodes_fts.rowid "
            "WHERE ctx_nodes_fts MATCH ?1 AND n.project = ?2 "
            "  AND n.kind NOT IN ('file','folder','module','section','variable','project')";
        sqlite3_stmt *cs = NULL;
        if (sqlite3_prepare_v2(db, count_sql, BM25_SQL_AUTO_LEN, &cs, NULL) == SQLITE_OK) {
            sqlite3_bind_text(cs, BM25_BIND_QUERY, fts_query, BM25_SQL_AUTO_LEN,
                              MCP_SQLITE_TRANSIENT);
            sqlite3_bind_text(cs, BM25_BIND_PROJECT, project, BM25_SQL_AUTO_LEN,
                              MCP_SQLITE_TRANSIENT);
            if (sqlite3_step(cs) == SQLITE_ROW) {
                total = sqlite3_column_int(cs, 0);
            }
            sqlite3_finalize(cs);
        }
    }

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_obj_add_int(doc, root, "total", total);
    yyjson_mut_obj_add_str(doc, root, "search_mode", "bm25");

    yyjson_mut_val *results = yyjson_mut_arr(doc);
    int emitted = 0;
    while (sqlite3_step(stmt) == SQLITE_ROW) {
        yyjson_mut_val *item = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_strcpy(doc, item, "name",
                                  (const char *)sqlite3_column_text(stmt, BM25_COL_NAME));
        yyjson_mut_obj_add_strcpy(doc, item, "qualified_name",
                                  (const char *)sqlite3_column_text(stmt, BM25_COL_QN));
        yyjson_mut_obj_add_strcpy(doc, item, "label",
                                  (const char *)sqlite3_column_text(stmt, BM25_COL_LABEL));
        yyjson_mut_obj_add_strcpy(doc, item, "file_path",
                                  (const char *)sqlite3_column_text(stmt, BM25_COL_FILE));
        yyjson_mut_obj_add_int(doc, item, "start_line", sqlite3_column_int(stmt, BM25_COL_START));
        yyjson_mut_obj_add_int(doc, item, "end_line", sqlite3_column_int(stmt, BM25_COL_END));
        yyjson_mut_obj_add_real(doc, item, "rank", sqlite3_column_double(stmt, BM25_COL_RANK));
        yyjson_mut_arr_add_val(results, item);
        emitted++;
    }
    sqlite3_finalize(stmt);

    yyjson_mut_obj_add_val(doc, root, "results", results);
    yyjson_mut_obj_add_bool(doc, root, "has_more", total > offset + emitted);

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    return json;
}

/* Emit the ctx_store_search results as a JSON "results" array on the doc. */
static void emit_search_results(yyjson_mut_doc *doc, yyjson_mut_val *root,
                                const ctx_search_output_t *out, ctx_store_t *store,
                                const char *relationship, bool include_connected, int offset) {
    yyjson_mut_obj_add_int(doc, root, "total", out->total);
    yyjson_mut_val *results = yyjson_mut_arr(doc);
    for (int i = 0; i < out->count; i++) {
        ctx_search_result_t *sr = &out->results[i];
        yyjson_mut_val *item = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_str(doc, item, "name", sr->node.name ? sr->node.name : "");
        yyjson_mut_obj_add_str(doc, item, "qualified_name",
                               sr->node.qualified_name ? sr->node.qualified_name : "");
        yyjson_mut_obj_add_str(doc, item, "label", sr->node.label ? sr->node.label : "");
        yyjson_mut_obj_add_str(doc, item, "file_path",
                               sr->node.file_path ? sr->node.file_path : "");
        yyjson_mut_obj_add_int(doc, item, "in_degree", sr->in_degree);
        yyjson_mut_obj_add_int(doc, item, "out_degree", sr->out_degree);
        if (include_connected && sr->node.id > 0) {
            enrich_connected(doc, item, store, sr->node.id, relationship);
        }
        yyjson_mut_arr_add_val(results, item);
    }
    yyjson_mut_obj_add_val(doc, root, "results", results);
    yyjson_mut_obj_add_bool(doc, root, "has_more", out->total > offset + out->count);
}

/* Extract keyword strings from a yyjson array into `keywords`.  Returns the
 * number of strings copied (capped at `max_out`). */
static int extract_semantic_keywords(yyjson_val *sq_val, const char **keywords, int max_out) {
    int kw_count = (int)yyjson_arr_size(sq_val);
    if (kw_count > max_out) {
        kw_count = max_out;
    }
    size_t kw_idx = 0;
    size_t kw_max = 0;
    yyjson_val *kw_val;
    int ki = 0;
    yyjson_arr_foreach(sq_val, kw_idx, kw_max, kw_val) {
        if (ki < kw_count && yyjson_is_str(kw_val)) {
            keywords[ki++] = yyjson_get_str(kw_val);
        }
    }
    return ki;
}

/* Emit ctx_vector_result_t entries as a "semantic_results" array on the doc. */
static void emit_semantic_results(yyjson_mut_doc *doc, yyjson_mut_val *root,
                                  ctx_vector_result_t *vresults, int vcount) {
    yyjson_mut_val *sem_results = yyjson_mut_arr(doc);
    for (int v = 0; v < vcount; v++) {
        yyjson_mut_val *vitem = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_strcpy(doc, vitem, "name", vresults[v].name);
        yyjson_mut_obj_add_strcpy(doc, vitem, "qualified_name", vresults[v].qualified_name);
        yyjson_mut_obj_add_strcpy(doc, vitem, "label", vresults[v].label);
        yyjson_mut_obj_add_strcpy(doc, vitem, "file_path", vresults[v].file_path);
        yyjson_mut_obj_add_real(doc, vitem, "score", vresults[v].score);
        yyjson_mut_arr_add_val(sem_results, vitem);
    }
    yyjson_mut_obj_add_val(doc, root, "semantic_results", sem_results);
}

/* Append the semantic_query vector-search results onto the doc.  Returns
 * true if semantic_query was provided as a non-array (type error — caller
 * should surface to the user). */
static bool run_semantic_query(yyjson_mut_doc *doc, yyjson_mut_val *root, const char *args,
                               ctx_store_t *store, const char *project, int limit) {
    enum { MAX_KW_SEARCH = 32 };
    yyjson_doc *args_doc = yyjson_read(args, strlen(args), 0);
    yyjson_val *args_root = args_doc ? yyjson_doc_get_root(args_doc) : NULL;
    yyjson_val *sq_val = args_root ? yyjson_obj_get(args_root, "semantic_query") : NULL;
    bool type_error = false;
    if (sq_val && !yyjson_is_arr(sq_val)) {
        type_error = true;
    } else if (sq_val && yyjson_arr_size(sq_val) > 0) {
        const char *keywords[MAX_KW_SEARCH];
        int ki = extract_semantic_keywords(sq_val, keywords, MAX_KW_SEARCH);
        ctx_vector_result_t *vresults = NULL;
        int vcount = 0;
        int sem_limit = limit > 0 ? limit : CTX_SZ_16;
        if (ctx_store_vector_search(store, project, keywords, ki, sem_limit, &vresults, &vcount) ==
                CTX_STORE_OK &&
            vcount > 0) {
            emit_semantic_results(doc, root, vresults, vcount);
            ctx_store_free_vector_results(vresults, vcount);
        }
    }
    if (args_doc) {
        yyjson_doc_free(args_doc);
    }
    return type_error;
}

static char *handle_search_graph(ctx_mcp_server_t *srv, const char *args) {
    char *project = ctx_mcp_get_string_arg(args, "project");
    ctx_store_t *store = resolve_store(srv, project);
    REQUIRE_STORE(store, project);

    char *not_indexed = verify_project_indexed(store, project);
    if (not_indexed) {
        free(project);
        return not_indexed;
    }

    /* BM25 path: if `query` is set, run FTS5 full-text search with ranking
     * and return early.  The regex/vector path below is untouched for all
     * other callers.  If FTS5 is unavailable or the query is empty after
     * tokenization, fall through to the regex path. */
    char *query = ctx_mcp_get_string_arg(args, "query");
    if (query && query[0]) {
        int q_limit = ctx_mcp_get_int_arg(args, "limit", BM25_DEFAULT_LIMIT);
        int q_offset = ctx_mcp_get_int_arg(args, "offset", 0);
        char *bm25_json = bm25_search(store, project, query, q_limit, q_offset);
        if (bm25_json) {
            free(query);
            free(project);
            char *result = ctx_mcp_text_result(bm25_json, false);
            free(bm25_json);
            return result;
        }
    }
    free(query);

    char *label = ctx_mcp_get_string_arg(args, "label");
    char *name_pattern = ctx_mcp_get_string_arg(args, "name_pattern");
    char *qn_pattern = ctx_mcp_get_string_arg(args, "qn_pattern");
    char *file_pattern = ctx_mcp_get_string_arg(args, "file_pattern");
    char *relationship = ctx_mcp_get_string_arg(args, "relationship");
    bool exclude_entry_points = ctx_mcp_get_bool_arg(args, "exclude_entry_points");
    bool include_connected = ctx_mcp_get_bool_arg(args, "include_connected");
    int limit = ctx_mcp_get_int_arg(args, "limit", MCP_HALF_SEC_US);
    int offset = ctx_mcp_get_int_arg(args, "offset", 0);
    int min_degree = ctx_mcp_get_int_arg(args, "min_degree", CTX_NOT_FOUND);
    int max_degree = ctx_mcp_get_int_arg(args, "max_degree", CTX_NOT_FOUND);

    if (relationship && !validate_edge_type(relationship)) {
        free(project);
        free(label);
        free(name_pattern);
        free(qn_pattern);
        free(file_pattern);
        free(relationship);
        return ctx_mcp_text_result("relationship must be uppercase letters and underscores", true);
    }

    ctx_search_params_t params = {
        .project = project,
        .label = label,
        .name_pattern = name_pattern,
        .qn_pattern = qn_pattern,
        .file_pattern = file_pattern,
        .relationship = relationship,
        .exclude_entry_points = exclude_entry_points,
        .include_connected = include_connected,
        .limit = limit,
        .offset = offset,
        .min_degree = min_degree,
        .max_degree = max_degree,
    };

    ctx_search_output_t out = {0};
    ctx_store_search(store, &params, &out);

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    emit_search_results(doc, root, &out, store, relationship, include_connected, offset);
    bool sq_type_error = run_semantic_query(doc, root, args, store, project, limit);

    if (sq_type_error) {
        yyjson_mut_doc_free(doc);
        ctx_store_search_free(&out);
        free(project);
        free(label);
        free(name_pattern);
        free(qn_pattern);
        free(file_pattern);
        free(relationship);
        return ctx_mcp_text_result(
            "semantic_query must be an array of keyword strings, e.g. "
            "[\"send\",\"pubsub\",\"publish\"] — not a single string. Split your query "
            "into individual keywords; each is scored independently via per-keyword "
            "min-cosine.",
            true);
    }

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    ctx_store_search_free(&out);

    free(project);
    free(label);
    free(name_pattern);
    free(qn_pattern);
    free(file_pattern);
    free(relationship);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

static char *handle_query_graph(ctx_mcp_server_t *srv, const char *args) {
    char *query = ctx_mcp_get_string_arg(args, "query");
    char *project = ctx_mcp_get_string_arg(args, "project");
    ctx_store_t *store = resolve_store(srv, project);
    int max_rows = ctx_mcp_get_int_arg(args, "max_rows", 0);

    if (!query) {
        free(project);
        return ctx_mcp_text_result("query is required", true);
    }
    if (!store) {
        char *_err = build_project_list_error("project not found or not indexed");
        char *_res = ctx_mcp_text_result(_err, true);
        free(_err);
        free(project);
        free(query);
        return _res;
    }

    char *not_indexed = verify_project_indexed(store, project);
    if (not_indexed) {
        free(project);
        free(query);
        return not_indexed;
    }

    ctx_cypher_result_t result = {0};
    int rc = ctx_cypher_execute(store, query, project, max_rows, &result);

    if (rc < 0) {
        char *err_msg = result.error ? result.error : "query execution failed";
        char *resp = ctx_mcp_text_result(err_msg, true);
        ctx_cypher_result_free(&result);
        free(query);
        free(project);
        return resp;
    }

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    /* columns */
    yyjson_mut_val *cols = yyjson_mut_arr(doc);
    for (int i = 0; i < result.col_count; i++) {
        yyjson_mut_arr_add_str(doc, cols, result.columns[i]);
    }
    yyjson_mut_obj_add_val(doc, root, "columns", cols);

    /* rows */
    yyjson_mut_val *rows = yyjson_mut_arr(doc);
    for (int r = 0; r < result.row_count; r++) {
        yyjson_mut_val *row = yyjson_mut_arr(doc);
        for (int c = 0; c < result.col_count; c++) {
            yyjson_mut_arr_add_str(doc, row, result.rows[r][c]);
        }
        yyjson_mut_arr_add_val(rows, row);
    }
    yyjson_mut_obj_add_val(doc, root, "rows", rows);
    yyjson_mut_obj_add_int(doc, root, "total", result.row_count);

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    ctx_cypher_result_free(&result);
    free(query);
    free(project);

    char *res = ctx_mcp_text_result(json, false);
    free(json);
    return res;
}

static char *handle_index_status(ctx_mcp_server_t *srv, const char *args) {
    char *project = ctx_mcp_get_string_arg(args, "project");
    ctx_store_t *store = resolve_store(srv, project);
    REQUIRE_STORE(store, project);

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    if (project) {
        int nodes = ctx_store_count_nodes(store, project);
        int edges = ctx_store_count_edges(store, project);
        yyjson_mut_obj_add_str(doc, root, "project", project);
        yyjson_mut_obj_add_int(doc, root, "nodes", nodes);
        yyjson_mut_obj_add_int(doc, root, "edges", edges);
        yyjson_mut_obj_add_str(doc, root, "status", nodes > 0 ? "ready" : "empty");
    } else {
        yyjson_mut_obj_add_str(doc, root, "status", "no_project");
    }

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    free(project);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* delete_project: just erase the .db file (and WAL/SHM). */
static char *handle_delete_project(ctx_mcp_server_t *srv, const char *args) {
    char *name = ctx_mcp_get_string_arg(args, "project");
    if (!name) {
        return ctx_mcp_text_result("project is required", true);
    }

    /* Close store if it's the project being deleted */
    if (srv->current_project && strcmp(srv->current_project, name) == 0) {
        if (srv->owns_store && srv->store) {
            ctx_store_close(srv->store);
            srv->store = NULL;
        }
        free(srv->current_project);
        srv->current_project = NULL;
    }

    /* Wait for any in-progress pipeline to finish before deleting */
    ctx_pipeline_lock();

    /* Delete the .db file + WAL/SHM */
    char path[CTX_SZ_1K];
    project_db_path(name, path, sizeof(path));

    char wal[CTX_SZ_1K];
    char shm[CTX_SZ_1K];
    snprintf(wal, sizeof(wal), "%s-wal", path);
    snprintf(shm, sizeof(shm), "%s-shm", path);

    bool exists = (access(path, F_OK) == 0);
    const char *status = "not_found";
    if (exists) {
        (void)ctx_unlink(path);
        (void)ctx_unlink(wal);
        (void)ctx_unlink(shm);
        status = "deleted";
    }

    ctx_pipeline_unlock();
    ctx_mem_collect(); /* return freed pages to OS after closing database */

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);
    yyjson_mut_obj_add_str(doc, root, "project", name);
    yyjson_mut_obj_add_str(doc, root, "status", status);

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    free(name);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* Check if an aspect is requested (NULL aspects = all, or array contains "all" or the name). */
static bool aspect_wanted(yyjson_doc *aspects_doc, yyjson_val *aspects_arr, const char *name) {
    if (!aspects_arr) {
        return true; /* no filter = all */
    }
    yyjson_arr_iter iter;
    yyjson_arr_iter_init(aspects_arr, &iter);
    yyjson_val *val;
    while ((val = yyjson_arr_iter_next(&iter)) != NULL) {
        const char *s = yyjson_get_str(val);
        if (s && (strcmp(s, "all") == 0 || strcmp(s, name) == 0)) {
            return true;
        }
    }
    (void)aspects_doc;
    return false;
}

static char *handle_get_architecture(ctx_mcp_server_t *srv, const char *args) {
    char *project = ctx_mcp_get_string_arg(args, "project");
    ctx_store_t *store = resolve_store(srv, project);
    REQUIRE_STORE(store, project);

    char *not_indexed = verify_project_indexed(store, project);
    if (not_indexed) {
        free(project);
        return not_indexed;
    }

    /* Parse aspects array from args */
    yyjson_doc *aspects_doc = NULL;
    yyjson_val *aspects_arr = NULL;
    {
        yyjson_doc *args_doc = yyjson_read(args, strlen(args), 0);
        if (args_doc) {
            yyjson_val *aval = yyjson_obj_get(yyjson_doc_get_root(args_doc), "aspects");
            if (yyjson_is_arr(aval)) {
                aspects_doc = args_doc; /* keep alive */
                aspects_arr = aval;
            } else {
                yyjson_doc_free(args_doc);
            }
        }
    }

    ctx_schema_info_t schema = {0};
    ctx_store_get_schema(store, project, &schema);

    int node_count = ctx_store_count_nodes(store, project);
    int edge_count = ctx_store_count_edges(store, project);

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    if (project) {
        yyjson_mut_obj_add_str(doc, root, "project", project);
    }
    yyjson_mut_obj_add_int(doc, root, "total_nodes", node_count);
    yyjson_mut_obj_add_int(doc, root, "total_edges", edge_count);

    /* Node label summary */
    if (aspect_wanted(aspects_doc, aspects_arr, "structure")) {
        yyjson_mut_val *labels = yyjson_mut_arr(doc);
        for (int i = 0; i < schema.node_label_count; i++) {
            yyjson_mut_val *item = yyjson_mut_obj(doc);
            yyjson_mut_obj_add_str(doc, item, "label", schema.node_labels[i].label);
            yyjson_mut_obj_add_int(doc, item, "count", schema.node_labels[i].count);
            yyjson_mut_arr_add_val(labels, item);
        }
        yyjson_mut_obj_add_val(doc, root, "node_labels", labels);
    }

    /* Edge type summary */
    if (aspect_wanted(aspects_doc, aspects_arr, "dependencies")) {
        yyjson_mut_val *types = yyjson_mut_arr(doc);
        for (int i = 0; i < schema.edge_type_count; i++) {
            yyjson_mut_val *item = yyjson_mut_obj(doc);
            yyjson_mut_obj_add_str(doc, item, "type", schema.edge_types[i].type);
            yyjson_mut_obj_add_int(doc, item, "count", schema.edge_types[i].count);
            yyjson_mut_arr_add_val(types, item);
        }
        yyjson_mut_obj_add_val(doc, root, "edge_types", types);
    }

    /* Relationship patterns */
    if (aspect_wanted(aspects_doc, aspects_arr, "routes") && schema.rel_pattern_count > 0) {
        yyjson_mut_val *pats = yyjson_mut_arr(doc);
        for (int i = 0; i < schema.rel_pattern_count; i++) {
            yyjson_mut_arr_add_str(doc, pats, schema.rel_patterns[i]);
        }
        yyjson_mut_obj_add_val(doc, root, "relationship_patterns", pats);
    }

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    ctx_store_schema_free(&schema);
    if (aspects_doc) {
        yyjson_doc_free(aspects_doc);
    }
    free(project);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* Resolve edge types from args: explicit array > mode-based > default ("CALLS").
 * Writes types into out_types (max 16). Returns the parsed yyjson_doc if explicit
 * edge_types were found (caller must keep alive until types are consumed), or NULL. */
static yyjson_doc *resolve_trace_edge_types(const char *args, const char *mode,
                                            const char **out_types, int *out_count) {
    static const char *mode_calls[] = {"CALLS"};
    static const char *mode_data_flow[] = {"CALLS", "DATA_FLOWS"};
    static const char *mode_cross_svc[] = {"HTTP_CALLS", "ASYNC_CALLS", "DATA_FLOWS", "CALLS"};

    *out_count = 0;

    yyjson_doc *et_doc = yyjson_read(args, strlen(args), 0);
    if (et_doc) {
        yyjson_val *et_arr = yyjson_obj_get(yyjson_doc_get_root(et_doc), "edge_types");
        if (et_arr && yyjson_is_arr(et_arr)) {
            size_t idx2;
            size_t max2;
            yyjson_val *val2;
            yyjson_arr_foreach(et_arr, idx2, max2, val2) {
                if (yyjson_is_str(val2) && *out_count < MCP_COL_16) {
                    out_types[(*out_count)++] = yyjson_get_str(val2);
                }
            }
        }
    }

    if (*out_count > 0) {
        return et_doc; /* caller must keep alive — pointers reference doc memory */
    }

    yyjson_doc_free(et_doc); /* no explicit types found, free */

    const char **defaults = mode_calls;
    int n_defaults = SKIP_ONE;
    if (mode && strcmp(mode, "data_flow") == 0) {
        defaults = mode_data_flow;
        n_defaults = MCP_N_DEFAULTS_2;
    } else if (mode && strcmp(mode, "cross_service") == 0) {
        defaults = mode_cross_svc;
        n_defaults = MCP_N_DEFAULTS_4;
    }
    for (int i = 0; i < n_defaults; i++) {
        out_types[i] = defaults[i];
    }
    *out_count = n_defaults;
    return NULL;
}

/* Check if a file path looks like a test file. */
static bool is_test_file(const char *path) {
    if (!path) {
        return false;
    }
    return strstr(path, "/test") != NULL || strstr(path, "test_") != NULL ||
           strstr(path, "_test.") != NULL || strstr(path, "/tests/") != NULL ||
           strstr(path, "/spec/") != NULL || strstr(path, ".test.") != NULL;
}

/* Convert BFS traversal results into a yyjson_mut array. */
static yyjson_mut_val *bfs_to_json_array(yyjson_mut_doc *doc, ctx_traverse_result_t *tr,
                                         bool risk_labels, bool include_tests) {
    yyjson_mut_val *arr = yyjson_mut_arr(doc);
    for (int i = 0; i < tr->visited_count; i++) {
        const char *fp = tr->visited[i].node.file_path;
        bool test = is_test_file(fp);
        if (!include_tests && test) {
            continue;
        }
        yyjson_mut_val *item = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_str(doc, item, "name",
                               tr->visited[i].node.name ? tr->visited[i].node.name : "");
        yyjson_mut_obj_add_str(
            doc, item, "qualified_name",
            tr->visited[i].node.qualified_name ? tr->visited[i].node.qualified_name : "");
        yyjson_mut_obj_add_int(doc, item, "hop", tr->visited[i].hop);
        if (risk_labels) {
            yyjson_mut_obj_add_str(doc, item, "risk",
                                   ctx_risk_label(ctx_hop_to_risk(tr->visited[i].hop)));
        }
        if (test) {
            yyjson_mut_obj_add_bool(doc, item, "is_test", true);
        }
        yyjson_mut_arr_add_val(arr, item);
    }
    return arr;
}

static char *handle_trace_call_path(ctx_mcp_server_t *srv, const char *args) {
    char *func_name = ctx_mcp_get_string_arg(args, "function_name");
    char *project = ctx_mcp_get_string_arg(args, "project");
    ctx_store_t *store = resolve_store(srv, project);
    char *direction = ctx_mcp_get_string_arg(args, "direction");
    char *mode = ctx_mcp_get_string_arg(args, "mode");
    char *param_name = ctx_mcp_get_string_arg(args, "parameter_name");
    int depth = ctx_mcp_get_int_arg(args, "depth", MCP_DEFAULT_DEPTH);
    bool risk_labels = ctx_mcp_get_bool_arg(args, "risk_labels");
    bool include_tests = ctx_mcp_get_bool_arg(args, "include_tests");

    if (!func_name) {
        free(project);
        free(direction);
        free(mode);
        free(param_name);
        return ctx_mcp_text_result("function_name is required", true);
    }
    if (!store) {
        char *_err = build_project_list_error("project not found or not indexed");
        char *_res = ctx_mcp_text_result(_err, true);
        free(_err);
        free(func_name);
        free(project);
        free(direction);
        free(mode);
        free(param_name);
        return _res;
    }

    char *not_indexed = verify_project_indexed(store, project);
    if (not_indexed) {
        free(func_name);
        free(project);
        free(direction);
        free(mode);
        free(param_name);
        return not_indexed;
    }

    if (!direction) {
        direction = heap_strdup("both");
    }

    /* Find the node by name */
    ctx_node_t *nodes = NULL;
    int node_count = 0;
    ctx_store_find_nodes_by_name(store, project, func_name, &nodes, &node_count);

    if (node_count == 0) {
        free(func_name);
        free(project);
        free(direction);
        free(mode);
        free(param_name);
        ctx_store_free_nodes(nodes, 0);
        return ctx_mcp_text_result("{\"error\":\"function not found\"}", true);
    }

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    yyjson_mut_obj_add_str(doc, root, "function", func_name);
    yyjson_mut_obj_add_str(doc, root, "direction", direction);
    if (mode) {
        yyjson_mut_obj_add_str(doc, root, "mode", mode);
    }

    /* Edge types: explicit > mode-based > default */
    const char *edge_types[MCP_COL_16];
    int edge_type_count = 0;
    yyjson_doc *et_doc_keep = resolve_trace_edge_types(args, mode, edge_types, &edge_type_count);

    /* Run BFS for each requested direction.
     * IMPORTANT: yyjson_mut_obj_add_str borrows pointers — we must keep
     * traversal results alive until after yy_doc_to_str serialization. */
    bool do_outbound = strcmp(direction, "outbound") == 0 || strcmp(direction, "both") == 0;
    bool do_inbound = strcmp(direction, "inbound") == 0 || strcmp(direction, "both") == 0;

    ctx_traverse_result_t tr_out = {0};
    ctx_traverse_result_t tr_in = {0};

    if (do_outbound) {
        ctx_store_bfs(store, nodes[0].id, "outbound", edge_types, edge_type_count, depth,
                      MCP_BFS_LIMIT, &tr_out);
        yyjson_mut_obj_add_val(doc, root, "callees",
                               bfs_to_json_array(doc, &tr_out, risk_labels, include_tests));
    }

    if (do_inbound) {
        ctx_store_bfs(store, nodes[0].id, "inbound", edge_types, edge_type_count, depth,
                      MCP_BFS_LIMIT, &tr_in);
        yyjson_mut_obj_add_val(doc, root, "callers",
                               bfs_to_json_array(doc, &tr_in, risk_labels, include_tests));
    }

    /* Serialize BEFORE freeing traversal results (yyjson borrows strings) */
    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);

    /* Now safe to free traversal data */
    if (do_outbound) {
        ctx_store_traverse_free(&tr_out);
    }
    if (do_inbound) {
        ctx_store_traverse_free(&tr_in);
    }

    ctx_store_free_nodes(nodes, node_count);
    free(func_name);
    free(project);
    free(direction);
    free(mode);
    free(param_name);
    if (et_doc_keep) {
        yyjson_doc_free(et_doc_keep);
    }

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* ── Helper: free heap fields of a stack-allocated node ────────── */

static void free_node_contents(ctx_node_t *n) {
    free((void *)n->project);
    free((void *)n->label);
    free((void *)n->name);
    free((void *)n->qualified_name);
    free((void *)n->file_path);
    free((void *)n->properties_json);
    memset(n, 0, sizeof(*n));
}

/* ── Helper: read lines [start, end] from a file ─────────────── */

static char *read_file_lines(const char *path, int start, int end) {
    FILE *fp = fopen(path, "r");
    if (!fp) {
        return NULL;
    }

    size_t cap = CTX_SZ_4K;
    char *buf = malloc(cap);
    size_t len = 0;
    buf[0] = '\0';

    char line[CTX_SZ_2K];
    int lineno = 0;
    while (fgets(line, sizeof(line), fp)) {
        lineno++;
        if (lineno < start) {
            continue;
        }
        if (lineno > end) {
            break;
        }
        size_t ll = strlen(line);
        while (len + ll + SKIP_ONE > cap) {
            cap *= PAIR_LEN;
            buf = safe_realloc(buf, cap);
        }
        memcpy(buf + len, line, ll);
        len += ll;
        buf[len] = '\0';
    }

    (void)fclose(fp);
    if (len == 0) {
        free(buf);
        return NULL;
    }
    return buf;
}

/* ── Helper: get project root_path from store ─────────────────── */

static char *get_project_root(ctx_mcp_server_t *srv, const char *project) {
    if (!project) {
        return NULL;
    }
    ctx_store_t *store = resolve_store(srv, project);
    if (!store) {
        return NULL;
    }
    ctx_project_t proj = {0};
    if (ctx_store_get_project(store, project, &proj) != CTX_STORE_OK) {
        return NULL;
    }
    char *root = heap_strdup(proj.root_path);
    free((void *)proj.name);
    free((void *)proj.indexed_at);
    free((void *)proj.root_path);
    return root;
}

/* ── index_repository ─────────────────────────────────────────── */

static char *handle_index_repository(ctx_mcp_server_t *srv, const char *args) {
    char *repo_path = ctx_mcp_get_string_arg(args, "repo_path");
    char *mode_str = ctx_mcp_get_string_arg(args, "mode");
    ctx_normalize_path_sep(repo_path);

    if (!repo_path) {
        free(mode_str);
        return ctx_mcp_text_result("repo_path is required", true);
    }

    /* Early validation: repo_path must exist and be a directory. Build a
     * structured error envelope so callers (incl. survey scripts iterating
     * over many repos) can diagnose without parsing free-form messages. */
    struct stat repo_st;
    if (stat(repo_path, &repo_st) != 0 || !S_ISDIR(repo_st.st_mode)) {
        char *project_name = ctx_project_name_from_path(repo_path);
        yyjson_mut_doc *vdoc = yyjson_mut_doc_new(NULL);
        yyjson_mut_val *vroot = yyjson_mut_obj(vdoc);
        yyjson_mut_doc_set_root(vdoc, vroot);
        yyjson_mut_obj_add_str(vdoc, vroot, "project", project_name ? project_name : "");
        yyjson_mut_obj_add_str(vdoc, vroot, "status", "error");
        yyjson_mut_obj_add_str(vdoc, vroot, "error_phase", "validate");
        char msg[CTX_SZ_1K];
        snprintf(msg, sizeof(msg),
                 "repo_path does not exist or is not a directory: %s", repo_path);
        yyjson_mut_obj_add_strcpy(vdoc, vroot, "error", msg);
        char *vjson = yy_doc_to_str(vdoc);
        yyjson_mut_doc_free(vdoc);
        free(project_name);
        free(mode_str);
        free(repo_path);
        char *vresult = ctx_mcp_text_result(vjson, true);
        free(vjson);
        return vresult;
    }

    ctx_index_mode_t mode = CTX_MODE_FULL;
    if (mode_str && strcmp(mode_str, "fast") == 0) {
        mode = CTX_MODE_FAST;
    } else if (mode_str && strcmp(mode_str, "moderate") == 0) {
        mode = CTX_MODE_MODERATE;
    }
    free(mode_str);

    ctx_pipeline_t *p = ctx_pipeline_new(repo_path, NULL, mode);
    if (!p) {
        free(repo_path);
        return ctx_mcp_text_result("failed to create pipeline", true);
    }

    char *project_name = heap_strdup(ctx_pipeline_project_name(p));

    /* Close cached store — pipeline will delete + recreate the .db file */
    if (srv->owns_store && srv->store) {
        ctx_store_close(srv->store);
        srv->store = NULL;
    }
    free(srv->current_project);
    srv->current_project = NULL;

    /* Serialize pipeline runs to prevent concurrent writes */
    ctx_pipeline_lock();
    int rc = ctx_pipeline_run(p);
    ctx_pipeline_unlock();

    /* Snapshot the failure phase. The getter returns a string literal with
     * static storage duration, so it stays valid after ctx_pipeline_free —
     * no defensive copy needed. */
    const char *failure_phase = (rc != 0) ? ctx_pipeline_last_error_phase(p) : NULL;

    ctx_pipeline_free(p);
    ctx_mem_collect(); /* return mimalloc pages to OS after large indexing */

    /* Invalidate cached store so next query reopens the fresh database */
    if (srv->owns_store && srv->store) {
        ctx_store_close(srv->store);
        srv->store = NULL;
    }
    free(srv->current_project);
    srv->current_project = NULL;

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    yyjson_mut_obj_add_str(doc, root, "project", project_name);
    yyjson_mut_obj_add_str(doc, root, "status", rc == 0 ? "indexed" : "error");

    if (rc != 0) {
        const char *phase = failure_phase ? failure_phase : "unknown";
        yyjson_mut_obj_add_strcpy(doc, root, "error_phase", phase);
        char emsg[CTX_SZ_1K];
        snprintf(emsg, sizeof(emsg),
                 "indexing failed at phase '%s' (rc=%d). Check stderr for pipeline.err logs.",
                 phase, rc);
        yyjson_mut_obj_add_strcpy(doc, root, "error", emsg);
    }

    if (rc == 0) {
        ctx_store_t *store = resolve_store(srv, project_name);
        if (store) {
            int nodes = ctx_store_count_nodes(store, project_name);
            int edges = ctx_store_count_edges(store, project_name);
            yyjson_mut_obj_add_int(doc, root, "nodes", nodes);
            yyjson_mut_obj_add_int(doc, root, "edges", edges);

            /* Check ADR presence and suggest creation if missing */
            char adr_path[CTX_SZ_4K];
            snprintf(adr_path, sizeof(adr_path), "%s/.codebase-memory/adr.md", repo_path);
            struct stat adr_st;
            bool adr_exists = (stat(adr_path, &adr_st) == 0);
            yyjson_mut_obj_add_bool(doc, root, "adr_present", adr_exists);
            if (!adr_exists) {
                yyjson_mut_obj_add_str(
                    doc, root, "adr_hint",
                    "Project indexed. Consider creating an Architecture Decision Record: "
                    "explore the codebase with get_architecture(aspects=['all']), then use "
                    "manage_adr(mode='store') to persist architectural insights across sessions.");
            }
        }
    }

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    free(project_name);
    free(repo_path);
    /* failure_phase points to a static string literal owned by the pipeline
     * module — nothing to free. */

    char *result = ctx_mcp_text_result(json, rc != 0);
    free(json);
    return result;
}

/* ── get_code_snippet ─────────────────────────────────────────── */

/* Copy a node from an array into a heap-allocated standalone node. */
static void copy_node(const ctx_node_t *src, ctx_node_t *dst) {
    dst->id = src->id;
    dst->project = heap_strdup(src->project);
    dst->label = heap_strdup(src->label);
    dst->name = heap_strdup(src->name);
    dst->qualified_name = heap_strdup(src->qualified_name);
    dst->file_path = heap_strdup(src->file_path);
    dst->start_line = src->start_line;
    dst->end_line = src->end_line;
    dst->properties_json = src->properties_json ? heap_strdup(src->properties_json) : NULL;
}

/* Build a JSON suggestions response for ambiguous or fuzzy results. */
static char *snippet_suggestions(const char *input, ctx_node_t *nodes, int count) {
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    yyjson_mut_obj_add_str(doc, root, "status", "ambiguous");

    char msg[CTX_SZ_512];
    snprintf(msg, sizeof(msg),
             "%d matches for \"%s\". Pick a qualified_name from suggestions below, "
             "or use search_graph(name_pattern=\"...\") to narrow results.",
             count, input);
    yyjson_mut_obj_add_str(doc, root, "message", msg);

    yyjson_mut_val *arr = yyjson_mut_arr(doc);
    for (int i = 0; i < count; i++) {
        yyjson_mut_val *s = yyjson_mut_obj(doc);
        yyjson_mut_obj_add_str(doc, s, "qualified_name",
                               nodes[i].qualified_name ? nodes[i].qualified_name : "");
        yyjson_mut_obj_add_str(doc, s, "name", nodes[i].name ? nodes[i].name : "");
        yyjson_mut_obj_add_str(doc, s, "label", nodes[i].label ? nodes[i].label : "");
        yyjson_mut_obj_add_str(doc, s, "file_path", nodes[i].file_path ? nodes[i].file_path : "");
        yyjson_mut_arr_append(arr, s);
    }
    yyjson_mut_obj_add_val(doc, root, "suggestions", arr);

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* Enrich a mutable JSON object with key-value pairs from a node's properties_json.
 * Returns the parsed yyjson_doc (caller frees AFTER serialization — zero-copy). */
static yyjson_doc *enrich_node_properties(yyjson_mut_doc *doc, yyjson_mut_val *obj,
                                          const char *properties_json) {
    if (!properties_json || properties_json[0] == '\0') {
        return NULL;
    }
    yyjson_doc *props_doc = yyjson_read(properties_json, strlen(properties_json), 0);
    if (!props_doc) {
        return NULL;
    }
    yyjson_val *props_root = yyjson_doc_get_root(props_doc);
    if (!props_root || !yyjson_is_obj(props_root)) {
        yyjson_doc_free(props_doc);
        return NULL;
    }
    yyjson_obj_iter iter;
    yyjson_obj_iter_init(props_root, &iter);
    yyjson_val *key;
    while ((key = yyjson_obj_iter_next(&iter))) {
        yyjson_val *val = yyjson_obj_iter_get_val(key);
        const char *k = yyjson_get_str(key);
        if (!k) {
            continue;
        }
        if (yyjson_is_str(val)) {
            yyjson_mut_obj_add_str(doc, obj, k, yyjson_get_str(val));
        } else if (yyjson_is_bool(val)) {
            yyjson_mut_obj_add_bool(doc, obj, k, yyjson_get_bool(val));
        } else if (yyjson_is_int(val)) {
            yyjson_mut_obj_add_int(doc, obj, k, yyjson_get_int(val));
        } else if (yyjson_is_real(val)) {
            yyjson_mut_obj_add_real(doc, obj, k, yyjson_get_real(val));
        }
    }
    return props_doc; /* caller frees after serialization */
}

/* Resolve an absolute path from root_path + file_path, verify containment,
 * and read source lines. Sets *out_abs_path (caller frees). Returns source
 * string (caller frees) or NULL if path is invalid/unreadable. */
static char *resolve_snippet_source(const char *root_path, const char *file_path, int start,
                                    int end, char **out_abs_path) {
    *out_abs_path = NULL;
    if (!root_path || !file_path) {
        return NULL;
    }
    size_t apsz = strlen(root_path) + strlen(file_path) + MCP_SEPARATOR;
    char *abs_path = malloc(apsz);
    snprintf(abs_path, apsz, "%s/%s", root_path, file_path);

    char real_root[CTX_SZ_4K];
    char real_file[CTX_SZ_4K];
    bool path_ok = false;
#ifdef _WIN32
    if (_fullpath(real_root, root_path, sizeof(real_root)) &&
        _fullpath(real_file, abs_path, sizeof(real_file))) {
        ctx_normalize_path_sep(real_root);
        ctx_normalize_path_sep(real_file);
#else
    if (realpath(root_path, real_root) && realpath(abs_path, real_file)) {
#endif
        size_t root_len = strlen(real_root);
        if (strncmp(real_file, real_root, root_len) == 0 &&
            (real_file[root_len] == '/' || real_file[root_len] == '\0')) {
            path_ok = true;
        }
    }
    *out_abs_path = abs_path;
    if (path_ok) {
        return read_file_lines(abs_path, start, end);
    }
    return NULL;
}

/* Build an enriched snippet response for a resolved node. */
/* Add a string array to a JSON object (no-op if count == 0). */
static void add_string_array(yyjson_mut_doc *doc, yyjson_mut_val *obj, const char *key,
                             char **strings, int count) {
    if (count <= 0) {
        return;
    }
    yyjson_mut_val *arr = yyjson_mut_arr(doc);
    for (int i = 0; i < count; i++) {
        yyjson_mut_arr_add_str(doc, arr, strings[i]);
    }
    yyjson_mut_obj_add_val(doc, obj, key, arr);
}

static char *build_snippet_response(ctx_mcp_server_t *srv, ctx_node_t *node,
                                    const char *match_method, bool include_neighbors,
                                    ctx_node_t *alternatives, int alt_count) {
    char *root_path = get_project_root(srv, node->project);

    int start = node->start_line > 0 ? node->start_line : SKIP_ONE;
    int end = node->end_line > start ? node->end_line : start + SNIPPET_DEFAULT_LINES;
    char *abs_path = NULL;
    char *source = resolve_snippet_source(root_path, node->file_path, start, end, &abs_path);

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root_obj = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root_obj);

    yyjson_mut_obj_add_str(doc, root_obj, "name", node->name ? node->name : "");
    yyjson_mut_obj_add_str(doc, root_obj, "qualified_name",
                           node->qualified_name ? node->qualified_name : "");
    yyjson_mut_obj_add_str(doc, root_obj, "label", node->label ? node->label : "");

    const char *display_path = "";
    if (abs_path) {
        display_path = abs_path;
    } else if (node->file_path) {
        display_path = node->file_path;
    }
    yyjson_mut_obj_add_str(doc, root_obj, "file_path", display_path);
    yyjson_mut_obj_add_int(doc, root_obj, "start_line", start);
    yyjson_mut_obj_add_int(doc, root_obj, "end_line", end);

    if (source) {
        yyjson_mut_obj_add_str(doc, root_obj, "source", source);
    } else {
        yyjson_mut_obj_add_str(doc, root_obj, "source", "(source not available)");
    }

    /* match_method — omitted for exact matches */
    if (match_method) {
        yyjson_mut_obj_add_str(doc, root_obj, "match_method", match_method);
    }

    /* Enrich with node properties (freed AFTER serialization — zero-copy). */
    yyjson_doc *props_doc = enrich_node_properties(doc, root_obj, node->properties_json);

    /* Caller/callee counts — store already resolved by calling handler */
    ctx_store_t *store = srv->store;
    int in_deg = 0;
    int out_deg = 0;
    ctx_store_node_degree(store, node->id, &in_deg, &out_deg);
    yyjson_mut_obj_add_int(doc, root_obj, "callers", in_deg);
    yyjson_mut_obj_add_int(doc, root_obj, "callees", out_deg);

    char **nb_callers = NULL;
    int nb_caller_count = 0;
    char **nb_callees = NULL;
    int nb_callee_count = 0;
    if (include_neighbors) {
        ctx_store_node_neighbor_names(store, node->id, MCP_DEFAULT_LIMIT, &nb_callers,
                                      &nb_caller_count, &nb_callees, &nb_callee_count);
        add_string_array(doc, root_obj, "caller_names", nb_callers, nb_caller_count);
        add_string_array(doc, root_obj, "callee_names", nb_callees, nb_callee_count);
    }

    /* Alternatives (when auto-resolved from ambiguous) */
    if (alternatives && alt_count > 0) {
        yyjson_mut_val *arr = yyjson_mut_arr(doc);
        for (int i = 0; i < alt_count; i++) {
            yyjson_mut_val *a = yyjson_mut_obj(doc);
            yyjson_mut_obj_add_str(doc, a, "qualified_name",
                                   alternatives[i].qualified_name ? alternatives[i].qualified_name
                                                                  : "");
            yyjson_mut_obj_add_str(doc, a, "file_path",
                                   alternatives[i].file_path ? alternatives[i].file_path : "");
            yyjson_mut_arr_append(arr, a);
        }
        yyjson_mut_obj_add_val(doc, root_obj, "alternatives", arr);
    }

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    yyjson_doc_free(props_doc); /* safe if NULL */
    for (int i = 0; i < nb_caller_count; i++) {
        free(nb_callers[i]);
    }
    for (int i = 0; i < nb_callee_count; i++) {
        free(nb_callees[i]);
    }
    free(nb_callers);
    free(nb_callees);
    free(root_path);
    free(abs_path);
    free(source);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

static char *handle_get_code_snippet(ctx_mcp_server_t *srv, const char *args) {
    char *qn = ctx_mcp_get_string_arg(args, "qualified_name");
    char *project = ctx_mcp_get_string_arg(args, "project");
    bool include_neighbors = ctx_mcp_get_bool_arg(args, "include_neighbors");

    if (!qn) {
        free(project);
        return ctx_mcp_text_result("qualified_name is required", true);
    }

    ctx_store_t *store = resolve_store(srv, project);
    if (!store) {
        char *_err = build_project_list_error("project not found or not indexed");
        char *_res = ctx_mcp_text_result(_err, true);
        free(_err);
        free(qn);
        free(project);
        return _res;
    }

    char *not_indexed = verify_project_indexed(store, project);
    if (not_indexed) {
        free(qn);
        free(project);
        return not_indexed;
    }

    /* Default to current project (same as all other tools) */
    const char *effective_project = project ? project : srv->current_project;

    /* Tier 1: Exact QN match */
    ctx_node_t node = {0};
    int rc = ctx_store_find_node_by_qn(store, effective_project, qn, &node);
    if (rc == CTX_STORE_OK) {
        char *result = build_snippet_response(srv, &node, NULL, include_neighbors, NULL, 0);
        free_node_contents(&node);
        free(qn);
        free(project);
        return result;
    }

    /* Tier 2: Suffix match — handles partial QNs ("main.HandleRequest")
     * and short names ("ProcessOrder") via LIKE '%.X'. */
    ctx_node_t *suffix_nodes = NULL;
    int suffix_count = 0;
    ctx_store_find_nodes_by_qn_suffix(store, effective_project, qn, &suffix_nodes, &suffix_count);

    if (suffix_count == SKIP_ONE) {
        copy_node(&suffix_nodes[0], &node);
        ctx_store_free_nodes(suffix_nodes, suffix_count);
        char *result = build_snippet_response(srv, &node, "suffix", include_neighbors, NULL, 0);
        free_node_contents(&node);
        free(qn);
        free(project);
        return result;
    }

    if (suffix_count > SKIP_ONE) {
        char *result = snippet_suggestions(qn, suffix_nodes, suffix_count);
        ctx_store_free_nodes(suffix_nodes, suffix_count);
        free(qn);
        free(project);
        return result;
    }

    ctx_store_free_nodes(suffix_nodes, suffix_count);
    free(qn);
    free(project);

    /* Nothing found — guide the caller toward search_graph */
    return ctx_mcp_text_result(
        "symbol not found. Use search_graph(name_pattern=\"...\") first to discover "
        "the exact qualified_name, then pass it to get_code_snippet.",
        true);
}

/* ── search_code v2: graph-augmented code search ─────────────── */

/* Strip non-ASCII bytes to guarantee valid UTF-8 JSON output */
enum { ASCII_MAX = 127 };
static void sanitize_ascii(char *s) {
    for (unsigned char *p = (unsigned char *)s; *p; p++) {
        if (*p > ASCII_MAX) {
            *p = '?';
        }
    }
}

/* Intermediate grep match */
typedef struct {
    char file[CTX_SZ_512];
    int line;
    char content[CTX_SZ_1K];
} grep_match_t;

/* Deduped result: one per containing graph node */
typedef struct {
    int64_t node_id; /* 0 = raw match (no containing node) */
    char node_name[CTX_SZ_256];
    char qualified_name[CTX_SZ_512];
    char label[CTX_SZ_64];
    char file[CTX_SZ_512];
    int start_line;
    int end_line;
    int in_degree;
    int out_degree;
    int score;
    int match_lines[CTX_SZ_64];
    int match_count;
} search_result_t;

/* Score a result for ranking: project source first, vendored last, tests lowest */
enum { SCORE_FUNC = 10, SCORE_ROUTE = 15, SCORE_VENDORED = -50, SCORE_TEST = -5 };
enum { MAX_LINE_SPAN = 999999 };

static int compute_search_score(const search_result_t *r) {
    int score = r->in_degree;
    if (strcmp(r->label, "Function") == 0 || strcmp(r->label, "Method") == 0) {
        score += SCORE_FUNC;
    }
    if (strcmp(r->label, "Route") == 0) {
        score += SCORE_ROUTE;
    }
    if (strstr(r->file, "vendored/") || strstr(r->file, "vendor/") ||
        strstr(r->file, "node_modules/")) {
        score += SCORE_VENDORED;
    }
    /* Penalize test files */
    if (strstr(r->file, "test") || strstr(r->file, "spec") || strstr(r->file, "_test.")) {
        score += SCORE_TEST;
    }
    return score;
}

static int search_result_cmp(const void *a, const void *b) {
    const search_result_t *ra = (const search_result_t *)a;
    const search_result_t *rb = (const search_result_t *)b;
    return rb->score - ra->score; /* descending */
}

/* Build the grep command string based on scoped vs recursive mode */
static void build_grep_cmd(char *cmd, size_t cmd_sz, bool use_regex, bool scoped,
                           const char *file_pattern, const char *tmpfile, const char *filelist,
                           const char *root_path) {
    const char *flag = use_regex ? "-E" : "-F";
    if (scoped) {
        if (file_pattern) {
            snprintf(cmd, cmd_sz, "xargs grep -n %s --include='%s' -f '%s' < '%s' 2>/dev/null",
                     flag, file_pattern, tmpfile, filelist);
        } else {
            snprintf(cmd, cmd_sz, "xargs grep -n %s -f '%s' < '%s' 2>/dev/null", flag, tmpfile,
                     filelist);
        }
    } else {
        if (file_pattern) {
            snprintf(cmd, cmd_sz, "grep -rn %s --include='%s' -f '%s' '%s' 2>/dev/null", flag,
                     file_pattern, tmpfile, root_path);
        } else {
            snprintf(cmd, cmd_sz, "grep -rn %s -f '%s' '%s' 2>/dev/null", flag, tmpfile, root_path);
        }
    }
}

/* Build deduplicated file list from search results + raw matches. */
static yyjson_mut_val *build_dedup_files_array(yyjson_mut_doc *doc, search_result_t *sr,
                                               int output_count, grep_match_t *raw, int raw_count) {
    yyjson_mut_val *files_arr = yyjson_mut_arr(doc);
    char *seen_files[CTX_SZ_512];
    int seen_count = 0;
    for (int fi = 0; fi < output_count; fi++) {
        bool dup = false;
        for (int j = 0; j < seen_count; j++) {
            if (strcmp(seen_files[j], sr[fi].file) == 0) {
                dup = true;
                break;
            }
        }
        if (!dup && seen_count < CTX_SZ_512) {
            seen_files[seen_count++] = sr[fi].file;
            yyjson_mut_arr_add_str(doc, files_arr, sr[fi].file);
        }
    }
    for (int fi = 0; fi < raw_count && seen_count < CTX_SZ_512; fi++) {
        bool dup = false;
        for (int j = 0; j < seen_count; j++) {
            if (strcmp(seen_files[j], raw[fi].file) == 0) {
                dup = true;
                break;
            }
        }
        if (!dup) {
            seen_files[seen_count++] = raw[fi].file;
            yyjson_mut_arr_add_str(doc, files_arr, raw[fi].file);
        }
    }
    return files_arr;
}

/* Attach source or context lines to a search result JSON item. */
static void attach_result_source(yyjson_mut_doc *doc, yyjson_mut_val *item, search_result_t *r,
                                 int mode, int context_lines, const char *root_path) {
    enum { MODE_FULL = 1 };
    if (r->start_line <= 0 || r->end_line <= 0) {
        return;
    }
    char abs_path[CTX_SZ_1K];
    snprintf(abs_path, sizeof(abs_path), "%s/%s", root_path, r->file);

    if (mode == MODE_FULL) {
        char *source = read_file_lines(abs_path, r->start_line, r->end_line);
        if (source) {
            sanitize_ascii(source);
            yyjson_mut_obj_add_strcpy(doc, item, "source", source);
            free(source);
        }
    } else if (context_lines > 0 && r->match_count > 0) {
        int ctx_start = r->match_lines[0] - context_lines;
        int ctx_end = r->match_lines[r->match_count - SKIP_ONE] + context_lines;
        if (ctx_start < SKIP_ONE) {
            ctx_start = SKIP_ONE;
        }
        char *ctx = read_file_lines(abs_path, ctx_start, ctx_end);
        if (ctx) {
            sanitize_ascii(ctx);
            yyjson_mut_obj_add_strcpy(doc, item, "context", ctx);
            yyjson_mut_obj_add_int(doc, item, "context_start", ctx_start);
            free(ctx);
        }
    }
}

/* Build directory distribution object from search results (top-level dir → count). */
static yyjson_mut_val *build_dir_distribution(yyjson_mut_doc *doc, search_result_t *sr,
                                              int sr_count) {
    yyjson_mut_val *dirs = yyjson_mut_obj(doc);
    char dir_names[CTX_SZ_64][CTX_SZ_128];
    int dir_counts[CTX_SZ_64];
    int dir_n = 0;
    for (int di = 0; di < sr_count; di++) {
        char top[CTX_SZ_128] = "";
        const char *slash = strchr(sr[di].file, '/');
        if (slash) {
            size_t dlen = (size_t)(slash - sr[di].file + SKIP_ONE);
            if (dlen >= sizeof(top)) {
                dlen = sizeof(top) - SKIP_ONE;
            }
            memcpy(top, sr[di].file, dlen);
            top[dlen] = '\0';
        } else {
            snprintf(top, sizeof(top), "%s", sr[di].file);
        }
        int found = CTX_NOT_FOUND;
        for (int d = 0; d < dir_n; d++) {
            if (strcmp(dir_names[d], top) == 0) {
                found = d;
                break;
            }
        }
        if (found >= 0) {
            dir_counts[found]++;
        } else if (dir_n < CTX_SZ_64) {
            snprintf(dir_names[dir_n], sizeof(dir_names[0]), "%s", top);
            dir_counts[dir_n] = SKIP_ONE;
            dir_n++;
        }
    }
    for (int d = 0; d < dir_n; d++) {
        yyjson_mut_val *key = yyjson_mut_strcpy(doc, dir_names[d]);
        yyjson_mut_val *val = yyjson_mut_int(doc, dir_counts[d]);
        yyjson_mut_obj_add(dirs, key, val);
    }
    return dirs;
}

/* Phase 4: assemble JSON output from search results */
static char *assemble_search_output(search_result_t *sr, int sr_count, grep_match_t *raw,
                                    int raw_count, int gm_count, int limit, int mode,
                                    int context_lines, const char *root_path) {
    enum { MODE_COMPACT = 0, MODE_FULL = 1, MODE_FILES = 2 };

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root_obj = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root_obj);

    int output_count = sr_count < limit ? sr_count : limit;

    if (mode == MODE_FILES) {
        yyjson_mut_obj_add_val(doc, root_obj, "files",
                               build_dedup_files_array(doc, sr, output_count, raw, raw_count));
    } else {
        yyjson_mut_val *results_arr = yyjson_mut_arr(doc);
        for (int ri = 0; ri < output_count; ri++) {
            search_result_t *r = &sr[ri];
            yyjson_mut_val *item = yyjson_mut_obj(doc);

            yyjson_mut_obj_add_str(doc, item, "node", r->node_name);
            yyjson_mut_obj_add_str(doc, item, "qualified_name", r->qualified_name);
            yyjson_mut_obj_add_str(doc, item, "label", r->label);
            yyjson_mut_obj_add_str(doc, item, "file", r->file);
            yyjson_mut_obj_add_int(doc, item, "start_line", r->start_line);
            yyjson_mut_obj_add_int(doc, item, "end_line", r->end_line);
            yyjson_mut_obj_add_int(doc, item, "in_degree", r->in_degree);
            yyjson_mut_obj_add_int(doc, item, "out_degree", r->out_degree);

            yyjson_mut_val *ml = yyjson_mut_arr(doc);
            for (int j = 0; j < r->match_count; j++) {
                yyjson_mut_arr_add_int(doc, ml, r->match_lines[j]);
            }
            yyjson_mut_obj_add_val(doc, item, "match_lines", ml);
            attach_result_source(doc, item, r, mode, context_lines, root_path);
            yyjson_mut_arr_add_val(results_arr, item);
        }
        yyjson_mut_obj_add_val(doc, root_obj, "results", results_arr);

        enum { MAX_RAW = 20 };
        yyjson_mut_val *raw_arr = yyjson_mut_arr(doc);
        int raw_output = raw_count < MAX_RAW ? raw_count : MAX_RAW;
        for (int ri = 0; ri < raw_output; ri++) {
            yyjson_mut_val *item = yyjson_mut_obj(doc);
            yyjson_mut_obj_add_str(doc, item, "file", raw[ri].file);
            yyjson_mut_obj_add_int(doc, item, "line", raw[ri].line);
            yyjson_mut_obj_add_str(doc, item, "content", raw[ri].content);
            yyjson_mut_arr_add_val(raw_arr, item);
        }
        yyjson_mut_obj_add_val(doc, root_obj, "raw_matches", raw_arr);
    }

    yyjson_mut_obj_add_val(doc, root_obj, "directories", build_dir_distribution(doc, sr, sr_count));

    /* Summary stats */
    yyjson_mut_obj_add_int(doc, root_obj, "total_grep_matches", gm_count);
    yyjson_mut_obj_add_int(doc, root_obj, "total_results", sr_count);
    yyjson_mut_obj_add_int(doc, root_obj, "raw_match_count", raw_count);
    if (sr_count > 0 && gm_count > 0) {
        char ratio[CTX_SZ_32];
        snprintf(ratio, sizeof(ratio), "%.1fx", (double)gm_count / (double)(sr_count + raw_count));
        yyjson_mut_obj_add_strcpy(doc, root_obj, "dedup_ratio", ratio);
    }

    char *json = yy_doc_to_str(doc);
    if (json) {
        sanitize_ascii(json);
    }
    yyjson_mut_doc_free(doc);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* Read grep output from fp, parse file:line:content format, apply path filter,
 * and return a dynamically-allocated grep_match_t array. */
/* Strip root path prefix from a file path. */
static const char *strip_root_prefix(const char *path, const char *root, size_t root_len) {
    if (strncmp(path, root, root_len) != 0) {
        return path;
    }
    const char *p = path + root_len;
    if (*p == '/') {
        p++;
    }
    return p;
}

static grep_match_t *collect_grep_matches(FILE *fp, const char *root_path, size_t root_len,
                                          bool has_path_filter, ctx_regex_t *path_regex,
                                          int grep_limit, int *out_count) {
    int gm_cap = CTX_SZ_64;
    int gm_count = 0;
    grep_match_t *gm = malloc(gm_cap * sizeof(grep_match_t));
    char line[CTX_SZ_2K];

    while (fgets(line, sizeof(line), fp) && gm_count < grep_limit) {
        size_t len = strlen(line);
        while (len > 0 && (line[len - SKIP_ONE] == '\n' || line[len - SKIP_ONE] == '\r')) {
            line[--len] = '\0';
        }
        if (len == 0) {
            continue;
        }

        char *colon1 = strchr(line, ':');
        if (!colon1) {
            continue;
        }
        char *colon2 = strchr(colon1 + SKIP_ONE, ':');
        if (!colon2) {
            continue;
        }

        *colon1 = '\0';
        *colon2 = '\0';

        /* After colon1 truncation, line contains only the file path portion. */
        const char *path = line;
        const char *file = strip_root_prefix(path, root_path, root_len);

        if (has_path_filter && ctx_regexec(path_regex, file, 0, NULL, 0) != CTX_REG_OK) {
            continue;
        }

        if (gm_count >= gm_cap) {
            gm_cap *= PAIR_LEN;
            gm = safe_realloc(gm, gm_cap * sizeof(grep_match_t));
        }
        snprintf(gm[gm_count].file, sizeof(gm[0].file), "%s", file);
        gm[gm_count].line = (int)strtol(colon1 + SKIP_ONE, NULL, CTX_DECIMAL_BASE);
        snprintf(gm[gm_count].content, sizeof(gm[0].content), "%s", colon2 + SKIP_ONE);
        sanitize_ascii(gm[gm_count].content);
        gm_count++;
    }

    *out_count = gm_count;
    return gm;
}

/* Find the tightest node containing a line in a file. Returns index or -1. */
static int find_tightest_node(ctx_node_t *nodes, int count, int line) {
    int best = CTX_NOT_FOUND;
    int best_span = MAX_LINE_SPAN;
    for (int j = 0; j < count; j++) {
        if (nodes[j].start_line <= line && nodes[j].end_line >= line) {
            int span = nodes[j].end_line - nodes[j].start_line;
            if (span < best_span) {
                best = j;
                best_span = span;
            }
        }
    }
    return best;
}

/* Add a grep hit to the search result set (merge into existing or create new). */
static void add_to_search_results(search_result_t **sr, int *sr_count, int *sr_cap, ctx_node_t *n,
                                  int line) {
    for (int j = 0; j < *sr_count; j++) {
        if ((*sr)[j].node_id == n->id) {
            if ((*sr)[j].match_count < CTX_SZ_64) {
                (*sr)[j].match_lines[(*sr)[j].match_count++] = line;
            }
            return;
        }
    }
    if (*sr_count >= *sr_cap) {
        *sr_cap *= PAIR_LEN;
        *sr = safe_realloc(*sr, *sr_cap * sizeof(search_result_t));
        memset(&(*sr)[*sr_count], 0, (*sr_cap - *sr_count) * sizeof(search_result_t));
    }
    search_result_t *r = &(*sr)[*sr_count];
    r->node_id = n->id;
    snprintf(r->node_name, sizeof(r->node_name), "%s", n->name ? n->name : "");
    snprintf(r->qualified_name, sizeof(r->qualified_name), "%s",
             n->qualified_name ? n->qualified_name : "");
    snprintf(r->label, sizeof(r->label), "%s", n->label ? n->label : "");
    snprintf(r->file, sizeof(r->file), "%s", n->file_path ? n->file_path : "");
    r->start_line = n->start_line;
    r->end_line = n->end_line;
    r->match_lines[0] = line;
    r->match_count = SKIP_ONE;
    (*sr_count)++;
}

/* Match a single grep hit to the tightest containing node, then add to sr or raw. */
static void classify_grep_hit(grep_match_t *hit, ctx_node_t *file_nodes, int file_node_count,
                              search_result_t **sr, int *sr_count, int *sr_cap, grep_match_t **raw,
                              int *raw_count, int *raw_cap) {
    int best = find_tightest_node(file_nodes, file_node_count, hit->line);
    if (best >= 0) {
        add_to_search_results(sr, sr_count, sr_cap, &file_nodes[best], hit->line);
    } else {
        if (*raw_count >= *raw_cap) {
            *raw_cap = (*raw_cap == 0) ? CTX_SZ_32 : *raw_cap * PAIR_LEN;
            *raw = safe_realloc(*raw, *raw_cap * sizeof(grep_match_t));
        }
        if (*raw) {
            (*raw)[(*raw_count)++] = *hit;
        }
    }
}

/* Free a file_nodes array returned from ctx_store_find_nodes_by_file. */
static void free_file_nodes(ctx_node_t *nodes, int count) {
    for (int j = 0; j < count; j++) {
        free((void *)nodes[j].project);
        free((void *)nodes[j].label);
        free((void *)nodes[j].name);
        free((void *)nodes[j].qualified_name);
        free((void *)nodes[j].file_path);
        free((void *)nodes[j].properties_json);
    }
    free(nodes);
}

/* Classify all grep matches file-by-file into search results and raw hits. */
static void classify_all_grep_hits(grep_match_t *gm, int gm_count, ctx_store_t *store,
                                   const char *project, search_result_t **sr, int *sr_count,
                                   int *sr_cap, grep_match_t **raw, int *raw_count, int *raw_cap) {
    qsort(gm, gm_count, sizeof(grep_match_t), (int (*)(const void *, const void *))strcmp);
    int i = 0;
    while (i < gm_count) {
        const char *cur_file = gm[i].file;
        int file_start = i;
        while (i < gm_count && strcmp(gm[i].file, cur_file) == 0) {
            i++;
        }
        ctx_node_t *file_nodes = NULL;
        int file_node_count = 0;
        if (store) {
            ctx_store_find_nodes_by_file(store, project, cur_file, &file_nodes, &file_node_count);
        }
        for (int mi = file_start; mi < i; mi++) {
            classify_grep_hit(&gm[mi], file_nodes, file_node_count, sr, sr_count, sr_cap, raw,
                              raw_count, raw_cap);
        }
        free_file_nodes(file_nodes, file_node_count);
    }
}

/* Write indexed file list for scoped grep. Returns true if scoped. */
static bool write_scoped_filelist(ctx_mcp_server_t *srv, const char *project, const char *root_path,
                                  const char *filelist) {
    ctx_store_t *pre_store = resolve_store(srv, project);
    if (!pre_store) {
        return false;
    }
    char **indexed_files = NULL;
    int indexed_count = 0;
    if (ctx_store_list_files(pre_store, project, &indexed_files, &indexed_count) != CTX_STORE_OK ||
        indexed_count == 0) {
        return false;
    }
    FILE *fl = fopen(filelist, "w");
    bool ok = false;
    if (fl) {
        for (int fi = 0; fi < indexed_count; fi++) {
            (void)fprintf(fl, "%s/%s\n", root_path, indexed_files[fi]);
        }
        (void)fclose(fl);
        ok = true;
    }
    for (int fi = 0; fi < indexed_count; fi++) {
        free(indexed_files[fi]);
    }
    free(indexed_files);
    return ok;
}

/* Parse search mode string (0=compact, 1=full, 2=files). */
static int parse_search_mode(const char *mode_str) {
    if (!mode_str) {
        return 0;
    }
    if (strcmp(mode_str, "full") == 0) {
        return SKIP_ONE;
    }
    if (strcmp(mode_str, "files") == 0) {
        return MCP_RETURN_2;
    }
    return 0;
}

/* Validate shell-safe arguments for search. */
static bool validate_search_args(const char *root_path, const char *file_pattern) {
    if (!ctx_validate_shell_arg(root_path)) {
        return false;
    }
    if (file_pattern && !ctx_validate_shell_arg(file_pattern)) {
        return false;
    }
    return true;
}

/* Write pattern to a temp file for grep -f. Returns true on success. */
static bool write_pattern_file(char *tmpfile, int tmpfile_sz, const char *pattern) {
#ifdef _WIN32
    snprintf(tmpfile, tmpfile_sz, "/tmp/ctx_search_%d.pat", (int)_getpid());
#else
    snprintf(tmpfile, tmpfile_sz, "/tmp/ctx_search_%d.pat", getpid());
#endif
    FILE *tf = fopen(tmpfile, "w");
    if (!tf) {
        return false;
    }
    (void)fprintf(tf, "%s\n", pattern);
    (void)fclose(tf);
    return true;
}

/* Compile a path filter regex. Returns true if compiled successfully. */
static bool compile_path_filter(const char *filter, ctx_regex_t *re) {
    if (!filter || !filter[0]) {
        return false;
    }
    return ctx_regcomp(re, filter, CTX_REG_EXTENDED | CTX_REG_NOSUB) == CTX_REG_OK;
}

static char *handle_search_code(ctx_mcp_server_t *srv, const char *args) {
    char *pattern = ctx_mcp_get_string_arg(args, "pattern");
    char *project = ctx_mcp_get_string_arg(args, "project");
    char *file_pattern = ctx_mcp_get_string_arg(args, "file_pattern");
    char *path_filter = ctx_mcp_get_string_arg(args, "path_filter");
    char *mode_str = ctx_mcp_get_string_arg(args, "mode");
    int limit = ctx_mcp_get_int_arg(args, "limit", MCP_DEFAULT_LIMIT);
    int context_lines = ctx_mcp_get_int_arg(args, "context", 0);
    bool use_regex = ctx_mcp_get_bool_arg(args, "regex");

    int mode = parse_search_mode(mode_str);
    free(mode_str);

    ctx_regex_t path_regex;
    bool has_path_filter = compile_path_filter(path_filter, &path_regex);
    free(path_filter);
    path_filter = NULL;

    if (!pattern) {
        free(project);
        free(file_pattern);
        return ctx_mcp_text_result("pattern is required", true);
    }

    /* Project is required */
    if (!project) {
        free(pattern);
        free(file_pattern);
        char *_err = build_project_list_error("project is required");
        char *_res = ctx_mcp_text_result(_err, true);
        free(_err);
        return _res;
    }

    char *root_path = get_project_root(srv, project);
    if (!root_path) {
        free(pattern);
        free(project);
        free(file_pattern);
        char *_err = build_project_list_error("project not found or not indexed");
        char *_res = ctx_mcp_text_result(_err, true);
        free(_err);
        return _res;
    }

    if (!validate_search_args(root_path, file_pattern)) {
        free(root_path);
        free(pattern);
        free(project);
        free(file_pattern);
        return ctx_mcp_text_result("path or file_pattern contains invalid characters", true);
    }

    /* ── Phase 1: Grep scan ──────────────────────────────────── */
    char tmpfile[CTX_SZ_256];
    if (!write_pattern_file(tmpfile, sizeof(tmpfile), pattern)) {
        free(root_path);
        free(pattern);
        free(project);
        free(file_pattern);
        return ctx_mcp_text_result("search failed: temp file", true);
    }

    /* No grep-level match limit — let grep find all matches, then dedup and
     * cap in our code. The -m flag caused results from large vendored files
     * to exhaust the quota before reaching project source files. */
    enum { GREP_MAX_MATCHES = 500 };
    int grep_limit = GREP_MAX_MATCHES;

    /* Scope grep to indexed files only — avoids scanning vendored/generated code.
     * Query the graph for distinct file paths, write them to a temp file,
     * then use xargs to pass them to grep. Falls back to recursive grep if
     * no indexed files found (project not fully indexed). */
    char filelist[CTX_SZ_256];
    snprintf(filelist, sizeof(filelist), "%s.files", tmpfile);
    bool scoped = false;

    scoped = write_scoped_filelist(srv, project, root_path, filelist);

    char cmd[CTX_SZ_4K];
    build_grep_cmd(cmd, sizeof(cmd), use_regex, scoped, file_pattern, tmpfile, filelist, root_path);

    FILE *fp = ctx_popen(cmd, "r");
    if (!fp) {
        ctx_unlink(tmpfile);
        if (scoped) {
            ctx_unlink(filelist);
        }
        free(root_path);
        free(pattern);
        free(project);
        free(file_pattern);
        return ctx_mcp_text_result("search failed", true);
    }

    /* Collect grep matches into array */
    int gm_count = 0;
    grep_match_t *gm = collect_grep_matches(fp, root_path, strlen(root_path), has_path_filter,
                                            &path_regex, grep_limit, &gm_count);
    ctx_pclose(fp);
    ctx_unlink(tmpfile);
    if (scoped) {
        ctx_unlink(filelist);
    }

    /* ── Phase 2+3: Block expansion + graph ranking ──────────── */
    /* Sort grep matches by file for contiguous processing.
     * Then: one SQL query per unique file for nodes, one batch query for all degrees. */

    ctx_store_t *store = resolve_store(srv, project);

    int sr_cap = CTX_SZ_32;
    int sr_count = 0;
    search_result_t *sr = calloc(sr_cap, sizeof(search_result_t));

    int raw_cap = CTX_SZ_32;
    int raw_count = 0;
    grep_match_t *raw = malloc(raw_cap * sizeof(grep_match_t));

    /* Sort matches by file path for contiguous per-file processing */
    qsort(gm, gm_count, sizeof(grep_match_t), (int (*)(const void *, const void *))strcmp);

    classify_all_grep_hits(gm, gm_count, store, project, &sr, &sr_count, &sr_cap, &raw, &raw_count,
                           &raw_cap);

    /* Phase 3: batch degree query — ONE query for all results instead of 2×N */
    if (store && sr_count > 0) {
        int64_t *ids = malloc(sr_count * sizeof(int64_t));
        int *in_degs = malloc(sr_count * sizeof(int));
        int *out_degs = malloc(sr_count * sizeof(int));
        for (int j = 0; j < sr_count; j++) {
            ids[j] = sr[j].node_id;
        }
        if (ctx_store_batch_count_degrees(store, ids, sr_count, "CALLS", in_degs, out_degs) ==
            CTX_STORE_OK) {
            for (int j = 0; j < sr_count; j++) {
                sr[j].in_degree = in_degs[j];
                sr[j].out_degree = out_degs[j];
            }
        }
        free(ids);
        free(in_degs);
        free(out_degs);
    }

    /* Compute scores and sort */
    for (int j = 0; j < sr_count; j++) {
        sr[j].score = compute_search_score(&sr[j]);
    }
    if (sr_count > SKIP_ONE) {
        qsort(sr, sr_count, sizeof(search_result_t), search_result_cmp);
    }

    /* ── Phase 4: Context assembly (extracted helper) ─────────── */

    char *result = assemble_search_output(sr, sr_count, raw, raw_count, gm_count, limit, mode,
                                          context_lines, root_path);
    free(gm);
    free(sr);
    free(raw);
    free(root_path);
    free(pattern);
    free(project);
    free(file_pattern);
    if (has_path_filter) {
        ctx_regfree(&path_regex);
    }
    return result;
}

/* ── detect_changes ───────────────────────────────────────────── */

/* Find symbols defined in a file and add them to the impacted array. */
static void detect_add_impacted_symbols(ctx_store_t *store, const char *project, const char *file,
                                        yyjson_mut_doc *doc, yyjson_mut_val *impacted) {
    ctx_node_t *nodes = NULL;
    int ncount = 0;
    ctx_store_find_nodes_by_file(store, project, file, &nodes, &ncount);
    for (int i = 0; i < ncount; i++) {
        if (nodes[i].label && strcmp(nodes[i].label, "File") != 0 &&
            strcmp(nodes[i].label, "Folder") != 0 && strcmp(nodes[i].label, "Project") != 0) {
            yyjson_mut_val *item = yyjson_mut_obj(doc);
            yyjson_mut_obj_add_strcpy(doc, item, "name", nodes[i].name ? nodes[i].name : "");
            yyjson_mut_obj_add_strcpy(doc, item, "label", nodes[i].label);
            yyjson_mut_obj_add_strcpy(doc, item, "file", file);
            yyjson_mut_arr_add_val(impacted, item);
        }
    }
    ctx_store_free_nodes(nodes, ncount);
}

static char *handle_detect_changes(ctx_mcp_server_t *srv, const char *args) {
    char *project = ctx_mcp_get_string_arg(args, "project");
    char *base_branch = ctx_mcp_get_string_arg(args, "base_branch");
    char *scope = ctx_mcp_get_string_arg(args, "scope");
    int depth = ctx_mcp_get_int_arg(args, "depth", MCP_DEFAULT_BFS_DEPTH);

    /* scope: "files" = just changed files, "symbols" = files + symbols (default) */
    bool want_symbols = !scope || strcmp(scope, "symbols") == 0 || strcmp(scope, "impact") == 0;

    if (!base_branch) {
        base_branch = heap_strdup("main");
    }

    /* Reject shell metacharacters in user-supplied branch name */
    if (!ctx_validate_shell_arg(base_branch)) {
        free(project);
        free(base_branch);
        free(scope);
        return ctx_mcp_text_result("base_branch contains invalid characters", true);
    }

    char *root_path = get_project_root(srv, project);
    if (!root_path) {
        free(project);
        free(base_branch);
        free(scope);
        return ctx_mcp_text_result("project not found", true);
    }

    if (!ctx_validate_shell_arg(root_path)) {
        free(root_path);
        free(project);
        free(base_branch);
        free(scope);
        return ctx_mcp_text_result("project path contains invalid characters", true);
    }

    /* Get changed files via git (-C avoids cd + quoting issues on Windows) */
    char cmd[CTX_SZ_2K];
#ifdef _WIN32
    snprintf(cmd, sizeof(cmd),
             "git -C \"%s\" diff --name-only \"%s\"...HEAD 2>NUL & "
             "git -C \"%s\" diff --name-only 2>NUL",
             root_path, base_branch, root_path);
#else
    snprintf(cmd, sizeof(cmd),
             "{ git -C '%s' diff --name-only '%s'...HEAD 2>/dev/null; "
             "git -C '%s' diff --name-only 2>/dev/null; } | sort -u",
             root_path, base_branch, root_path);
#endif

    FILE *fp = ctx_popen(cmd, "r");
    if (!fp) {
        free(root_path);
        free(project);
        free(base_branch);
        free(scope);
        return ctx_mcp_text_result("git diff failed", true);
    }

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root_obj = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root_obj);

    yyjson_mut_val *changed = yyjson_mut_arr(doc);
    yyjson_mut_val *impacted = yyjson_mut_arr(doc);

    /* resolve_store already called via get_project_root above */
    ctx_store_t *store = srv->store;

    char line[CTX_SZ_1K];
    int file_count = 0;

    while (fgets(line, sizeof(line), fp)) {
        size_t len = strlen(line);
        while (len > 0 && (line[len - SKIP_ONE] == '\n' || line[len - SKIP_ONE] == '\r')) {
            line[--len] = '\0';
        }
        if (len == 0) {
            continue;
        }

        yyjson_mut_arr_add_strcpy(doc, changed, line);
        file_count++;

        if (want_symbols) {
            detect_add_impacted_symbols(store, project, line, doc, impacted);
        }
    }
    ctx_pclose(fp);

    yyjson_mut_obj_add_val(doc, root_obj, "changed_files", changed);
    yyjson_mut_obj_add_int(doc, root_obj, "changed_count", file_count);
    yyjson_mut_obj_add_val(doc, root_obj, "impacted_symbols", impacted);
    yyjson_mut_obj_add_int(doc, root_obj, "depth", depth);

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    free(root_path);
    free(project);
    free(base_branch);
    free(scope);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* ── manage_adr ───────────────────────────────────────────────── */

/* ADR "sections" mode: list markdown headers from file. */
static void adr_list_sections(yyjson_mut_doc *doc, yyjson_mut_val *root_obj, const char *adr_path) {
    yyjson_mut_val *sections = yyjson_mut_arr(doc);
    FILE *fp = fopen(adr_path, "r");
    if (fp) {
        char line[CTX_SZ_1K];
        while (fgets(line, sizeof(line), fp)) {
            if (line[0] == '#') {
                size_t len = strlen(line);
                while (len > 0 && (line[len - SKIP_ONE] == '\n' || line[len - SKIP_ONE] == '\r')) {
                    line[--len] = '\0';
                }
                yyjson_mut_arr_add_strcpy(doc, sections, line);
            }
        }
        (void)fclose(fp);
    }
    yyjson_mut_obj_add_val(doc, root_obj, "sections", sections);
}

/* ADR "get" mode: read content from file. Returns heap buffer (caller frees
 * AFTER serialization since yyjson borrows the pointer). */
static char *adr_read_content(yyjson_mut_doc *doc, yyjson_mut_val *root_obj, const char *adr_path) {
    FILE *fp = fopen(adr_path, "r");
    if (fp) {
        (void)fseek(fp, 0, SEEK_END);
        long sz = ftell(fp);
        if (sz < 0) {
            sz = 0;
        }
        (void)fseek(fp, 0, SEEK_SET);
        char *buf = malloc((size_t)sz + SKIP_ONE);
        size_t n = (sz > 0) ? fread(buf, SKIP_ONE, (size_t)sz, fp) : 0;
        if (n > (size_t)sz) {
            n = (size_t)sz;
        }
        buf[n] = '\0';
        (void)fclose(fp);
        yyjson_mut_obj_add_str(doc, root_obj, "content", buf);
        return buf;
    }
    yyjson_mut_obj_add_str(doc, root_obj, "content", "");
    yyjson_mut_obj_add_str(doc, root_obj, "status", "no_adr");
    yyjson_mut_obj_add_str(
        doc, root_obj, "adr_hint",
        "No ADR yet. Create one with manage_adr(mode='update', "
        "content='## PURPOSE\\n...\\n\\n## STACK\\n...\\n\\n## ARCHITECTURE\\n..."
        "\\n\\n## PATTERNS\\n...\\n\\n## TRADEOFFS\\n...\\n\\n## PHILOSOPHY\\n...'). "
        "For guided creation: explore the codebase with get_architecture, "
        "then draft and store. Sections: PURPOSE, STACK, ARCHITECTURE, "
        "PATTERNS, TRADEOFFS, PHILOSOPHY.");
    return NULL;
}

static char *handle_manage_adr(ctx_mcp_server_t *srv, const char *args) {
    char *project = ctx_mcp_get_string_arg(args, "project");
    char *mode_str = ctx_mcp_get_string_arg(args, "mode");
    char *content = ctx_mcp_get_string_arg(args, "content");

    if (!mode_str) {
        mode_str = heap_strdup("get");
    }

    char *root_path = get_project_root(srv, project);
    if (!root_path) {
        free(project);
        free(mode_str);
        free(content);
        return ctx_mcp_text_result("project not found", true);
    }

    char adr_dir[CTX_SZ_4K];
    snprintf(adr_dir, sizeof(adr_dir), "%s/.codebase-memory", root_path);
    char adr_path[CTX_SZ_4K];
    snprintf(adr_path, sizeof(adr_path), "%s/adr.md", adr_dir);

    char *adr_buf = NULL;
    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root_obj = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root_obj);

    if (strcmp(mode_str, "update") == 0 && content) {
        ctx_mkdir(adr_dir);
        FILE *fp = fopen(adr_path, "w");
        if (fp) {
            (void)fputs(content, fp);
            (void)fclose(fp);
            yyjson_mut_obj_add_str(doc, root_obj, "status", "updated");
        } else {
            yyjson_mut_obj_add_str(doc, root_obj, "status", "write_error");
        }
    } else if (strcmp(mode_str, "sections") == 0) {
        adr_list_sections(doc, root_obj, adr_path);
    } else {
        adr_buf = adr_read_content(doc, root_obj, adr_path);
    }

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);
    free(adr_buf);
    free(root_path);
    free(project);
    free(mode_str);
    free(content);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* ── ingest_traces ────────────────────────────────────────────── */

static char *handle_ingest_traces(ctx_mcp_server_t *srv, const char *args) {
    (void)srv;
    /* Parse traces array from JSON args */
    yyjson_doc *adoc = yyjson_read(args, strlen(args), 0);
    int trace_count = 0;

    if (adoc) {
        yyjson_val *aroot = yyjson_doc_get_root(adoc);
        yyjson_val *traces = yyjson_obj_get(aroot, "traces");
        if (traces && yyjson_is_arr(traces)) {
            trace_count = (int)yyjson_arr_size(traces);
        }
        yyjson_doc_free(adoc);
    }

    yyjson_mut_doc *doc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_mut_obj(doc);
    yyjson_mut_doc_set_root(doc, root);

    yyjson_mut_obj_add_str(doc, root, "status", "accepted");
    yyjson_mut_obj_add_int(doc, root, "traces_received", trace_count);
    yyjson_mut_obj_add_str(doc, root, "note",
                           "Runtime edge creation from traces not yet implemented");

    char *json = yy_doc_to_str(doc);
    yyjson_mut_doc_free(doc);

    char *result = ctx_mcp_text_result(json, false);
    free(json);
    return result;
}

/* ── Tool dispatch ────────────────────────────────────────────── */

char *ctx_mcp_handle_tool(ctx_mcp_server_t *srv, const char *tool_name, const char *args_json) {
    if (!tool_name) {
        return ctx_mcp_text_result("missing tool name", true);
    }

    if (strcmp(tool_name, "list_projects") == 0) {
        return handle_list_projects(srv, args_json);
    }
    if (strcmp(tool_name, "get_graph_schema") == 0) {
        return handle_get_graph_schema(srv, args_json);
    }
    if (strcmp(tool_name, "search_graph") == 0) {
        return handle_search_graph(srv, args_json);
    }
    if (strcmp(tool_name, "query_graph") == 0) {
        return handle_query_graph(srv, args_json);
    }
    if (strcmp(tool_name, "index_status") == 0) {
        return handle_index_status(srv, args_json);
    }
    if (strcmp(tool_name, "delete_project") == 0) {
        return handle_delete_project(srv, args_json);
    }
    if (strcmp(tool_name, "trace_path") == 0 || strcmp(tool_name, "trace_call_path") == 0) {
        return handle_trace_call_path(srv, args_json);
    }
    if (strcmp(tool_name, "get_architecture") == 0) {
        return handle_get_architecture(srv, args_json);
    }

    /* Pipeline-dependent tools */
    if (strcmp(tool_name, "index_repository") == 0) {
        return handle_index_repository(srv, args_json);
    }
    if (strcmp(tool_name, "get_code_snippet") == 0) {
        return handle_get_code_snippet(srv, args_json);
    }
    if (strcmp(tool_name, "search_code") == 0) {
        return handle_search_code(srv, args_json);
    }
    if (strcmp(tool_name, "detect_changes") == 0) {
        return handle_detect_changes(srv, args_json);
    }
    if (strcmp(tool_name, "manage_adr") == 0) {
        return handle_manage_adr(srv, args_json);
    }
    if (strcmp(tool_name, "ingest_traces") == 0) {
        return handle_ingest_traces(srv, args_json);
    }
    char msg[CTX_SZ_256];
    snprintf(msg, sizeof(msg), "unknown tool: %s", tool_name);
    return ctx_mcp_text_result(msg, true);
}


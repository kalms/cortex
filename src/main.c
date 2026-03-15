// NOLINTBEGIN(cert-err33-c) — best-effort logging and snprintf truncation
// NOLINTBEGIN(readability-magic-numbers) — buffer sizes, scoring weights, and capacity constants
/*
 * main.c — Entry point for codebase-memory-mcp.
 *
 * Modes:
 *   (default)       Run as MCP server on stdin/stdout (JSON-RPC 2.0)
 *   cli <tool> <json>  Run a single tool call and print result
 *   --version       Print version and exit
 *   --help          Print usage and exit
 *
 * Signal handling: SIGTERM/SIGINT trigger graceful shutdown.
 * Watcher runs in a background thread, polling for git changes.
 */
#include "mcp/mcp.h"
#include "watcher/watcher.h"
#include "pipeline/pipeline.h"
#include "store/store.h"
#include "foundation/log.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <pthread.h>
#include <stdatomic.h>

#ifndef CBM_VERSION
#define CBM_VERSION "dev"
#endif

/* ── Globals for signal handling ────────────────────────────────── */

static cbm_watcher_t *g_watcher = NULL;
static cbm_mcp_server_t *g_server = NULL;
static atomic_int g_shutdown = 0;

static void signal_handler(int sig) {
    (void)sig;
    atomic_store(&g_shutdown, 1);
    if (g_watcher) {
        cbm_watcher_stop(g_watcher);
    }
    /* Close stdin to unblock getline in the MCP server loop */
    fclose(stdin);
}

/* ── Watcher background thread ──────────────────────────────────── */

static void *watcher_thread(void *arg) {
    cbm_watcher_t *w = arg;
    cbm_watcher_run(w, 5000); /* 5s base interval */
    return NULL;
}

/* ── Index callback for watcher ─────────────────────────────────── */

static int watcher_index_fn(const char *project_name, const char *root_path, void *user_data) {
    (void)user_data;
    cbm_log_info("watcher.reindex", "project", project_name, "path", root_path);

    cbm_pipeline_t *p = cbm_pipeline_new(root_path, NULL, CBM_MODE_FULL);
    if (!p) {
        return -1;
    }

    int rc = cbm_pipeline_run(p);
    cbm_pipeline_free(p);
    return rc;
}

/* ── CLI mode ───────────────────────────────────────────────────── */

static int run_cli(int argc, char **argv) {
    if (argc < 1) {
        // NOLINTNEXTLINE(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
        fprintf(stderr, "Usage: codebase-memory-mcp cli <tool_name> [json_args]\n");
        return 1;
    }

    const char *tool_name = argv[0];
    const char *args_json = argc >= 2 ? argv[1] : "{}";

    cbm_mcp_server_t *srv = cbm_mcp_server_new(NULL);
    if (!srv) {
        // NOLINTNEXTLINE(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
        fprintf(stderr, "Failed to create server\n");
        return 1;
    }

    char *result = cbm_mcp_handle_tool(srv, tool_name, args_json);
    if (result) {
        printf("%s\n", result);
        free(result);
    }

    cbm_mcp_server_free(srv);
    return 0;
}

/* ── Help ───────────────────────────────────────────────────────── */

static void print_help(void) {
    printf("codebase-memory-mcp %s\n\n", CBM_VERSION);
    printf("Usage:\n");
    printf("  codebase-memory-mcp              Run MCP server on stdio\n");
    printf("  codebase-memory-mcp cli <tool> [json]  Run a single tool\n");
    printf("  codebase-memory-mcp --version    Print version\n");
    printf("  codebase-memory-mcp --help       Print this help\n");
    printf("\nTools: index_repository, search_graph, query_graph, trace_call_path,\n");
    printf("  get_code_snippet, get_graph_schema, get_architecture, search_code,\n");
    printf("  list_projects, delete_project, index_status, detect_changes,\n");
    printf("  manage_adr, ingest_traces\n");
}

/* ── Main ───────────────────────────────────────────────────────── */

int main(int argc, char **argv) {
    /* Parse arguments */
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--version") == 0) {
            printf("codebase-memory-mcp %s\n", CBM_VERSION);
            return 0;
        }
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_help();
            return 0;
        }
        if (strcmp(argv[i], "cli") == 0) {
            return run_cli(argc - i - 1, argv + i + 1);
        }
    }

    /* Default: MCP server on stdio */
    cbm_log_info("server.start", "version", CBM_VERSION);

    /* Install signal handlers */
    // NOLINTNEXTLINE(misc-include-cleaner) — sigaction provided by standard header
    struct sigaction sa = {0};
    // NOLINTNEXTLINE(misc-include-cleaner) — sa_handler provided by standard header
    sa.sa_handler = signal_handler;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = 0;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);

    /* Create MCP server */
    g_server = cbm_mcp_server_new(NULL);
    if (!g_server) {
        cbm_log_error("server.err", "msg", "failed to create server");
        return 1;
    }

    /* Create and start watcher in background thread */
    cbm_store_t *watch_store = cbm_store_open_memory();
    g_watcher = cbm_watcher_new(watch_store, watcher_index_fn, NULL);
    // NOLINTNEXTLINE(misc-include-cleaner) — pthread_t provided by standard header
    pthread_t watcher_tid;
    bool watcher_started = false;

    if (g_watcher) {
        if (pthread_create(&watcher_tid, NULL, watcher_thread, g_watcher) == 0) {
            watcher_started = true;
        }
    }

    /* Run MCP event loop (blocks until EOF or signal) */
    int rc = cbm_mcp_server_run(g_server, stdin, stdout);

    /* Shutdown */
    cbm_log_info("server.shutdown");

    if (watcher_started) {
        cbm_watcher_stop(g_watcher);
        pthread_join(watcher_tid, NULL);
    }
    cbm_watcher_free(g_watcher);
    cbm_store_close(watch_store);
    cbm_mcp_server_free(g_server);

    g_watcher = NULL;
    g_server = NULL;

    return rc;
}

// NOLINTEND(readability-magic-numbers)
// NOLINTEND(cert-err33-c)

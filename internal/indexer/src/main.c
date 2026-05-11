/*
 * main.c — Entry point for cortex-indexer.
 *
 * Modes:
 *   cli <tool> <json>  Run a single tool call and print result
 *   install            Install agent integrations
 *   uninstall          Remove agent integrations
 *   update             Update installed integrations
 *   config             Read/write persisted config
 *   --version          Print version and exit
 *   --help             Print usage and exit
 *
 * The legacy default-mode MCP server on stdio was removed in Phase 6 of the
 * CBM removal plan. Running the binary with no subcommand now prints usage
 * to stderr and exits non-zero.
 */
#include "handlers/handlers.h"
#include "cli/cli.h"
#include "cli/progress_sink.h"
#include "foundation/constants.h"
#include "foundation/mem.h"
#include "foundation/profile.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef CTX_VERSION
#define CTX_VERSION "dev"
#endif

enum {
    MAIN_MIN_ARGC = 1,
    MAIN_CLI_ARGC = 2,
};
#define MAIN_RAM_FRACTION 0.5

/* ── CLI mode ───────────────────────────────────────────────────── */

static int run_cli(int argc, char **argv) {
    if (argc < MAIN_MIN_ARGC) {
        (void)fprintf(stderr,
                      "Usage: cortex-indexer cli [--progress] <tool_name> [json_args]\n");
        return SKIP_ONE;
    }

    /* Strip --progress flag from argv. */
    bool progress = false;
    for (int i = 0; i < argc; i++) {
        if (strcmp(argv[i], "--progress") == 0) {
            progress = true;
            for (int j = i; j < argc - SKIP_ONE; j++) {
                argv[j] = argv[j + SKIP_ONE];
            }
            argc--;
            break;
        }
    }

    if (argc < MAIN_MIN_ARGC) {
        (void)fprintf(stderr,
                      "Usage: cortex-indexer cli [--progress] <tool_name> [json_args]\n");
        return SKIP_ONE;
    }

    const char *tool_name = argv[0];
    const char *args_json = argc >= MAIN_CLI_ARGC ? argv[SKIP_ONE] : "{}";

    if (progress) {
        ctx_progress_sink_init(stderr);
    }

    ctx_mcp_server_t *srv = ctx_mcp_server_new(NULL);
    if (!srv) {
        (void)fprintf(stderr, "Failed to create server\n");
        if (progress) {
            ctx_progress_sink_fini();
        }
        return SKIP_ONE;
    }

    char *result = ctx_mcp_handle_tool(srv, tool_name, args_json);
    if (result) {
        printf("%s\n", result);
        free(result);
    }

    ctx_mcp_server_free(srv);
    if (progress) {
        ctx_progress_sink_fini();
    }
    return 0;
}

/* ── Help ───────────────────────────────────────────────────────── */

static void print_help(void) {
    printf("cortex-indexer %s\n\n", CTX_VERSION);
    printf("Usage:\n");
    printf("  cortex-indexer cli <tool> [json]  Run a single tool\n");
    printf("  cortex-indexer install [-y|-n] [--force] [--dry-run]\n");
    printf("  cortex-indexer uninstall [-y|-n] [--dry-run]\n");
    printf("  cortex-indexer update [-y|-n]\n");
    printf("  cortex-indexer config <list|get|set|reset>\n");
    printf("  cortex-indexer --version    Print version\n");
    printf("  cortex-indexer --help       Print this help\n");
    printf("\nSupported agents (auto-detected):\n");
    printf("  Claude Code, Codex CLI, Gemini CLI, Zed, OpenCode, Antigravity, Aider, KiloCode\n");
    printf("\nTools: index_repository, search_graph, query_graph, trace_path,\n");
    printf("  get_code_snippet, get_graph_schema, get_architecture, search_code,\n");
    printf("  list_projects, delete_project, index_status, detect_changes,\n");
    printf("  manage_adr, ingest_traces\n");
}

static void print_usage_stderr(void) {
    (void)fprintf(stderr,
                  "cortex-indexer: a subcommand is required.\n"
                  "Run 'cortex-indexer --help' for usage.\n");
}

/* ── Main ───────────────────────────────────────────────────────── */

/* Try to handle a subcommand (cli/install/uninstall/update/config/--version/--help).
 * Returns -1 if no subcommand matched, otherwise the exit code. */
static int handle_subcommand(int argc, char **argv) {
    /* First scan: global flags */
    for (int i = SKIP_ONE; i < argc; i++) {
        if (strcmp(argv[i], "--profile") == 0) {
            ctx_profile_enable();
        }
    }
    for (int i = SKIP_ONE; i < argc; i++) {
        if (strcmp(argv[i], "--version") == 0) {
            printf("cortex-indexer %s\n", CTX_VERSION);
            return 0;
        }
        if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_help();
            return 0;
        }
        if (strcmp(argv[i], "cli") == 0) {
            ctx_mem_init(MAIN_RAM_FRACTION);
            return run_cli(argc - i - SKIP_ONE, argv + i + SKIP_ONE);
        }
        if (strcmp(argv[i], "install") == 0) {
            return ctx_cmd_install(argc - i - SKIP_ONE, argv + i + SKIP_ONE);
        }
        if (strcmp(argv[i], "uninstall") == 0) {
            return ctx_cmd_uninstall(argc - i - SKIP_ONE, argv + i + SKIP_ONE);
        }
        if (strcmp(argv[i], "update") == 0) {
            return ctx_cmd_update(argc - i - SKIP_ONE, argv + i + SKIP_ONE);
        }
        if (strcmp(argv[i], "config") == 0) {
            return ctx_cmd_config(argc - i - SKIP_ONE, argv + i + SKIP_ONE);
        }
    }
    return CTX_NOT_FOUND;
}

int main(int argc, char **argv) {
    ctx_profile_init(); /* reads CTX_PROFILE env var, gates all prof macros */
    int subcmd = handle_subcommand(argc, argv);
    if (subcmd >= 0) {
        return subcmd;
    }

    /* No subcommand matched: the legacy default-MCP-server mode was removed
     * in Phase 6. Print usage to stderr and exit non-zero. */
    print_usage_stderr();
    return SKIP_ONE;
}

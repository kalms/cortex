/*
 * handlers.h — Tool handlers for the cortex-indexer CLI.
 *
 * Provides the server context (ctx_mcp_server_t) and the tool dispatcher
 * (ctx_mcp_handle_tool) used by main.c::run_cli to execute the 14 graph
 * analysis tools (search, trace, query, index, etc.). All tool handlers
 * format their result as an MCP-style {content:[{type:"text",...}]} envelope
 * via ctx_mcp_text_result.
 */
#ifndef CTX_HANDLERS_H
#define CTX_HANDLERS_H

#include <stdbool.h>

/* ── MCP protocol helpers ─────────────────────────────────────── */

/* Format an MCP tool result with text content. Returns heap-allocated JSON. */
char *ctx_mcp_text_result(const char *text, bool is_error);

/* ── Tool argument helpers ────────────────────────────────────── */

/* Extract a string argument from the tools/call params JSON.
 * Returns heap-allocated copy, or NULL if not found. */
char *ctx_mcp_get_string_arg(const char *args_json, const char *key);

/* Extract an int argument. Returns default_val if not found. */
int ctx_mcp_get_int_arg(const char *args_json, const char *key, int default_val);

/* Extract a bool argument. Returns false if not found. */
bool ctx_mcp_get_bool_arg(const char *args_json, const char *key);

/* ── Server context ───────────────────────────────────────────── */

typedef struct ctx_mcp_server ctx_mcp_server_t;

/* Create a server context. store_path is the SQLite database directory
 * (NULL → in-memory store for test/embedded use). */
ctx_mcp_server_t *ctx_mcp_server_new(const char *store_path);

/* Free a server context. */
void ctx_mcp_server_free(ctx_mcp_server_t *srv);

/* ── Tool handler dispatch ────────────────────────────────────── */

/* Dispatch a tool call by name. Returns MCP tool result JSON. */
char *ctx_mcp_handle_tool(ctx_mcp_server_t *srv, const char *tool_name, const char *args_json);

#endif /* CTX_HANDLERS_H */

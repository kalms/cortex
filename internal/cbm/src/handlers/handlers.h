/*
 * handlers.h — Tool handlers for the cortex-indexer CLI.
 *
 * Provides the server context (cbm_mcp_server_t) and the tool dispatcher
 * (cbm_mcp_handle_tool) used by main.c::run_cli to execute the 14 graph
 * analysis tools (search, trace, query, index, etc.). All tool handlers
 * format their result as an MCP-style {content:[{type:"text",...}]} envelope
 * via cbm_mcp_text_result.
 */
#ifndef CBM_HANDLERS_H
#define CBM_HANDLERS_H

#include <stdbool.h>

/* ── Forward declarations ─────────────────────────────────────── */

typedef struct cbm_store cbm_store_t; /* from store/store.h */

/* ── MCP protocol helpers ─────────────────────────────────────── */

/* Format an MCP tool result with text content. Returns heap-allocated JSON. */
char *cbm_mcp_text_result(const char *text, bool is_error);

/* ── Tool argument helpers ────────────────────────────────────── */

/* Extract a string argument from the tools/call params JSON.
 * Returns heap-allocated copy, or NULL if not found. */
char *cbm_mcp_get_string_arg(const char *args_json, const char *key);

/* Extract an int argument. Returns default_val if not found. */
int cbm_mcp_get_int_arg(const char *args_json, const char *key, int default_val);

/* Extract a bool argument. Returns false if not found. */
bool cbm_mcp_get_bool_arg(const char *args_json, const char *key);

/* ── Server context ───────────────────────────────────────────── */

typedef struct cbm_mcp_server cbm_mcp_server_t;

/* Create a server context. store_path is the SQLite database directory
 * (NULL → in-memory store for test/embedded use). */
cbm_mcp_server_t *cbm_mcp_server_new(const char *store_path);

/* Free a server context. */
void cbm_mcp_server_free(cbm_mcp_server_t *srv);

/* ── Tool handler dispatch ────────────────────────────────────── */

/* Dispatch a tool call by name. Returns MCP tool result JSON. */
char *cbm_mcp_handle_tool(cbm_mcp_server_t *srv, const char *tool_name, const char *args_json);

/* ── Testing helpers ───────────────────────────────────────────── */

/* Get the store handle from a server (for test setup). */
cbm_store_t *cbm_mcp_server_store(cbm_mcp_server_t *srv);

/* Set the project name associated with the server's current store (for test setup).
 * This prevents resolve_store() from trying to open a .db file when tools specify a project. */
void cbm_mcp_server_set_project(cbm_mcp_server_t *srv, const char *project);

#endif /* CBM_HANDLERS_H */

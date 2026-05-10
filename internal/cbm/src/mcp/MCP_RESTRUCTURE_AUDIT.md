# MCP vs Shared Code Audit (Phase 6)

This document classifies every top-level function in `internal/cbm/src/mcp/mcp.c`
(3886 lines) as either **DELETE** (JSON-RPC transport — used only by the
stdio MCP server mode) or **KEEP** (shared with CLI mode, which dispatches
via `cbm_mcp_handle_tool` from `internal/cbm/src/main.c::run_cli`).

It exists to guide the Phase 6 strip-down of the CBM binary, which removes
MCP-server mode while preserving the tool handlers used by `bin/cortex-indexer
cli <tool> <json>`. The boundary is: parsing/framing/dispatch of JSON-RPC
envelopes goes; the tool handlers, the dispatcher `cbm_mcp_handle_tool`, the
server context and its lifecycle, and all static helpers reachable from the
handlers stay.

**Notes on shared external callers found during the audit:**

- `cbm_mcp_server_handle` is called from `internal/cbm/src/ui/http_server.c:965`
  in addition to `cbm_mcp_server_run`. If the HTTP server is being kept and
  needs to keep accepting JSON-RPC over HTTP, this dependency must be
  considered before deleting `cbm_mcp_server_handle`. If the HTTP server is
  also being removed/rewritten in Phase 6, this is moot.
- `cbm_parse_file_uri` is currently unused outside `mcp.c` itself except in
  `tests/test_mcp.c`. It is dead code in a CLI-only world.
- `cbm_mcp_get_string_arg` / `_int_arg` / `_bool_arg` are heavily used by the
  tool handlers (99 references across the file) — they are KEEP.
- `cbm_mcp_text_result` is used by both the dispatcher and many handlers
  to build error/text result envelopes — KEEP.

Delete this doc at the end of Phase 6 once the restructure is verified and
the build/tests are green.

## DELETE — JSON-RPC transport layer

| Function | Line | Justification |
|---|---|---|
| `cbm_jsonrpc_parse` | 116 | Parses a JSON-RPC 2.0 request envelope. Only used by `cbm_mcp_server_handle`. |
| `cbm_jsonrpc_request_free` | 162 | Frees a parsed JSON-RPC request struct. Only used alongside `cbm_jsonrpc_parse`. |
| `cbm_jsonrpc_format_response` | 176 | Builds the `{"jsonrpc":"2.0","id":...,"result":...}` envelope. JSON-RPC framing. |
| `cbm_jsonrpc_format_error` | 207 | Builds the JSON-RPC error envelope. JSON-RPC framing. |
| `cbm_mcp_tools_list` | 391 | Serves the `tools/list` MCP method. JSON-RPC method handler, not used by CLI. |
| `cbm_mcp_initialize_response` | 433 | Serves the `initialize` MCP method (protocol version negotiation). Not used by CLI. |
| `cbm_mcp_get_tool_name` | 479 | Extracts `name` from `tools/call` params — only the JSON-RPC dispatcher uses it; CLI passes the tool name on argv. |
| `cbm_mcp_get_arguments` | 494 | Extracts `arguments` sub-object from `tools/call` params — only the JSON-RPC dispatcher uses it; CLI passes the args JSON on argv. |
| `cbm_mcp_server_handle` | 3634 | The JSON-RPC method dispatcher: parses a request line, dispatches `initialize`/`tools/list`/`tools/call`, formats response. Pure transport. (Also used by `ui/http_server.c` — see intro note.) |
| `handle_content_length_frame` | 3691 | Handles LSP-style `Content-Length:` framed message bodies. Stdio transport framing. |
| `poll_for_input_unix` | 3725 | Three-phase Unix poll on stdin fd for the event loop. Stdio transport. |
| `cbm_mcp_server_run` | 3779 | The stdin/stdout event loop. The MCP server entrypoint. |
| `cbm_parse_file_uri` | 3860 | `file://` URI parser. Not referenced outside mcp.c/tests; legacy MCP resource helper. |

## KEEP — Shared with CLI mode

| Function | Line | Justification |
|---|---|---|
| `heap_strdup` | 91 | Static helper used by handlers and dispatcher to copy strings. |
| `yy_doc_to_str` | 106 | Static helper used by handlers and dispatcher to serialize yyjson docs. |
| `cbm_mcp_text_result` | 229 | Builds the MCP `{content:[{type:"text",...}], isError:...}` result envelope. Returned by `cbm_mcp_handle_tool` and used by handlers — this is the CLI's output format. |
| `cbm_mcp_get_string_arg` | 509 | Used by every handler to read string args. |
| `cbm_mcp_get_int_arg` | 524 | Used by handlers to read int args. |
| `cbm_mcp_get_bool_arg` | 539 | Used by handlers to read bool args. |
| `cbm_mcp_server_new` | 578 | Server context constructor. Called by `run_cli` in `main.c:153`. |
| `cbm_mcp_server_store` | 597 | Test/embedded accessor for the inner store. |
| `cbm_mcp_server_set_project` | 601 | Sets the current project on the server context — used by handlers (`resolve_store`) and tests. |
| `cbm_mcp_server_set_watcher` | 609 | Wires external watcher. Not transport. |
| `cbm_mcp_server_set_config` | 615 | Wires external config. Not transport. |
| `cbm_mcp_server_free` | 621 | Server context destructor. Called by `run_cli` in `main.c:168`. |
| `cbm_mcp_server_evict_idle` | 640 | Idle store eviction. Called from event loop today (DELETE caller), but also exposed for tests and may stay as a no-op hook; trivial helper, KEEP for now. |
| `cbm_mcp_server_has_cached_store` | 664 | Test/embedded accessor. KEEP. |
| `cache_dir` | 671 | Static helper for resolving cache directory paths. Used by `handle_list_projects`. |
| `project_db_path` | 683 | Static helper for resolving project DB paths. Used by handlers. |
| `resolve_store` | 692 | Opens the right project's `.db` for query tools. Called by every handler. |
| `collect_db_project_names` | 754 | Walks the cache dir to list projects. Used by `handle_list_projects`/error path. |
| `build_project_list_error` | 785 | Builds an error response that lists available projects. Used by handlers via `_err = build_project_list_error(...)`. |
| `is_project_db_file` | 823 | Filename filter for project `.db` files. Used by `handle_list_projects`. |
| `build_project_json_entry` | 836 | Builds one entry of the list_projects response. Used by `handle_list_projects`. |
| `handle_list_projects` | 874 | Tool handler — `cbm_mcp_handle_tool` case "list_projects". |
| `verify_project_indexed` | 925 | Used by every handler to gate on project indexed state. |
| `handle_get_graph_schema` | 935 | Tool handler — case "get_graph_schema". |
| `validate_edge_type` | 999 | Edge-type whitelist check used by `handle_search_graph`. |
| `enrich_add_bfs` | 1013 | Helper for search_graph result enrichment. |
| `enrich_connected` | 1022 | Helper for search_graph result enrichment. |
| `emit_search_results` | 1215 | Helper used by `handle_search_graph`. |
| `extract_semantic_keywords` | 1242 | Helper used by `handle_search_graph` (semantic mode). |
| `emit_semantic_results` | 1260 | Helper used by `handle_search_graph` (semantic mode). |
| `run_semantic_query` | 1278 | Helper used by `handle_search_graph` (semantic mode). |
| `handle_search_graph` | 1306 | Tool handler — case "search_graph". |
| `handle_query_graph` | 1416 | Tool handler — case "query_graph". |
| `handle_index_status` | 1488 | Tool handler — case "index_status". |
| `handle_delete_project` | 1518 | Tool handler — case "delete_project". |
| `aspect_wanted` | 1574 | Helper used by `handle_get_architecture`. |
| `handle_get_architecture` | 1591 | Tool handler — case "get_architecture". |
| `is_test_file` | 1729 | Helper used by `handle_trace_call_path` to filter test files. |
| `handle_trace_call_path` | 1767 | Tool handler — cases "trace_path" and "trace_call_path". |
| `free_node_contents` | 1893 | Helper to free `cbm_node_t` fields. Used by snippet/search paths. |
| `read_file_lines` | 1905 | Helper to read a line range from a file. Used by snippet/search paths. (The `fgets` loop near 1918 is inside this helper, not MCP-only.) |
| `get_project_root` | 1946 | Helper used by `handle_index_repository` and snippet paths. |
| `handle_index_repository` | 1967 | Tool handler — case "index_repository". |
| `copy_node` | 2061 | Helper used by `handle_get_code_snippet`. |
| `snippet_suggestions` | 2074 | Helper used by `handle_get_code_snippet` to produce ambiguous-match suggestions. |
| `resolve_snippet_source` | 2149 | Helper used by `handle_get_code_snippet`. |
| `add_string_array` | 2185 | Helper used by `handle_get_code_snippet` response building. |
| `build_snippet_response` | 2197 | Helper used by `handle_get_code_snippet`. |
| `handle_get_code_snippet` | 2294 | Tool handler — case "get_code_snippet". |
| `sanitize_ascii` | 2374 | Helper used by `handle_search_code`. |
| `compute_search_score` | 2409 | Ranking helper used by `handle_search_code`. |
| `search_result_cmp` | 2428 | qsort comparator used by `handle_search_code`. |
| `build_grep_cmd` | 2435 | Builds the grep command for `handle_search_code`. |
| `attach_result_source` | 2493 | Helper used by `handle_search_code` response building. |
| `assemble_search_output` | 2569 | Helper used by `handle_search_code`. |
| `find_tightest_node` | 2711 | Helper used by `handle_search_code` to attach match to containing function. |
| `add_to_search_results` | 2727 | Helper used by `handle_search_code`. |
| `classify_grep_hit` | 2757 | Helper used by `handle_search_code`. |
| `free_file_nodes` | 2775 | Helper used by `handle_search_code`. |
| `classify_all_grep_hits` | 2788 | Helper used by `handle_search_code`. |
| `write_scoped_filelist` | 2813 | Helper used by `handle_search_code` (path scoping). |
| `parse_search_mode` | 2842 | Helper used by `handle_search_code`. |
| `validate_search_args` | 2856 | Helper used by `handle_search_code`. |
| `write_pattern_file` | 2867 | Helper used by `handle_search_code` (pattern file for grep -f). |
| `compile_path_filter` | 2883 | Helper used by `handle_search_code` (regex path filter). |
| `handle_search_code` | 2890 | Tool handler — case "search_code". |
| `detect_add_impacted_symbols` | 3063 | Helper used by `handle_detect_changes`. |
| `handle_detect_changes` | 3081 | Tool handler — case "detect_changes". |
| `adr_list_sections` | 3192 | Helper used by `handle_manage_adr`. |
| `adr_read_content` | 3213 | Helper used by `handle_manage_adr`. |
| `handle_manage_adr` | 3245 | Tool handler — case "manage_adr". |
| `handle_ingest_traces` | 3303 | Tool handler — case "ingest_traces". |
| `cbm_mcp_handle_tool` | 3337 | The shared tool dispatcher. Called by `run_cli` in `main.c:162` AND by `cbm_mcp_server_handle`. The KEEP/DELETE split hinges on this function. |
| `detect_session` | 3394 | Detects the project root from CWD. Currently called from the event loop's `initialize` path (DELETE caller); KEEP unless explicitly removed — useful for CLI auto-detection too. Re-evaluate in Task 6.2 if unused after stripping. |
| `autoindex_thread` | 3424 | Background auto-index thread fn. Currently triggered from the event loop's `initialize` path (DELETE caller). Re-evaluate in Task 6.2 — may be dropped if `maybe_auto_index` is dropped. |
| `maybe_auto_index` | 3456 | Starts auto-index thread. Currently triggered from the event loop's `initialize` path (DELETE caller). Re-evaluate in Task 6.2 — likely DELETE once `cbm_mcp_server_handle` is gone. |
| `update_check_thread` | 3529 | Background update-check thread fn. Triggered from `initialize` (DELETE caller). Re-evaluate in Task 6.2 — likely DELETE once `cbm_mcp_server_handle` is gone. |
| `start_update_check` | 3579 | Spawns `update_check_thread`. Same fate as above — re-evaluate in Task 6.2. |
| `inject_update_notice` | 3590 | Prepends update notice to a tool result. Only called from `cbm_mcp_server_handle` (DELETE caller). Re-evaluate in Task 6.2 — likely DELETE. |

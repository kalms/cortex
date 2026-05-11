#ifndef CTX_HELPERS_H
#define CTX_HELPERS_H

#include "cbm.h"

// Extract text of a node from source. Returns arena-allocated string.
char *ctx_node_text(CtxArena *a, TSNode node, const char *source);

// Check if a string is a language keyword (should be skipped as callee/usage).
bool ctx_is_keyword(const char *name, CtxLanguage lang);

// Classify a string literal as URL, config, or neither.
// Returns CTX_STRREF_URL (0), CTX_STRREF_CONFIG (1), or -1 for neither.
int ctx_classify_string(const char *str, int len);

// Check if a name is exported per language convention.
bool ctx_is_exported(const char *name, CtxLanguage lang);

// Check if a file is a test file based on path and language.
bool ctx_is_test_file(const char *rel_path, CtxLanguage lang);

// Find the innermost enclosing function node by walking parent chain.
// Returns a null node if none found.
TSNode ctx_find_enclosing_func(TSNode node, CtxLanguage lang);

// Get the QN of an enclosing function, or module_qn if none.
const char *ctx_enclosing_func_qn(CtxArena *a, TSNode node, CtxLanguage lang, const char *source,
                                  const char *project, const char *rel_path, const char *module_qn);

// Cached version: uses ctx->ef_cache to avoid repeated parent-chain walks.
const char *ctx_enclosing_func_qn_cached(CtxExtractCtx *ctx, TSNode node);

// Find a child node by kind string.
TSNode ctx_find_child_by_kind(TSNode parent, const char *kind);

// Check if node kind matches a set of types (NULL-terminated array of strings).
bool ctx_kind_in_set(TSNode node, const char **types);

// Check if node has an ancestor of the given kind, within max_depth levels.
bool ctx_has_ancestor_kind(TSNode node, const char *kind, int max_depth);

// Count nodes of given kinds in subtree (for complexity metric).
int ctx_count_branching(TSNode node, const char **branching_types);

// Is this a module-level node? (not nested inside function/class body)
bool ctx_is_module_level(TSNode node, CtxLanguage lang);

// --- FQN computation ---

// Compute qualified name: project.rel_path_parts.name
char *ctx_fqn_compute(CtxArena *a, const char *project, const char *rel_path, const char *name);

// Module QN (file without name): project.rel_path_parts
char *ctx_fqn_module(CtxArena *a, const char *project, const char *rel_path);

// Folder QN: project.dir_parts
char *ctx_fqn_folder(CtxArena *a, const char *project, const char *rel_dir);

#endif // CTX_HELPERS_H

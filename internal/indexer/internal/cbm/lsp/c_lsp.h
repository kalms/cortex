#ifndef CTX_LSP_C_LSP_H
#define CTX_LSP_C_LSP_H

#include "type_rep.h"
#include "scope.h"
#include "type_registry.h"
#include "../cbm.h"
#include "go_lsp.h"  // for CtxLSPDef, CtxResolvedCallArray

// CLSPContext holds state for C/C++ expression type evaluation within a file.
typedef struct {
    CtxArena* arena;
    const char* source;
    int source_len;
    const CtxTypeRegistry* registry;
    CtxScope* current_scope;

    // Include map: header_path -> namespace QN prefix
    const char** include_paths;
    const char** include_ns_qns;
    int include_count;

    // Namespace state
    const char* current_namespace;   // current namespace QN (e.g., "proj.ns1.ns2")

    // Using namespace directives
    const char** using_namespaces;
    int using_ns_count;
    int using_ns_cap;

    // Using declarations: specific names imported into scope
    const char** using_decl_names;
    const char** using_decl_qns;
    int using_decl_count;
    int using_decl_cap;

    // Namespace aliases: short -> full QN
    const char** ns_alias_names;
    const char** ns_alias_qns;
    int ns_alias_count;
    int ns_alias_cap;

    // Current context
    const char* enclosing_func_qn;
    const char* enclosing_class_qn;  // for implicit `this` resolution
    const char* module_qn;

    // Output
    CtxResolvedCallArray* resolved_calls;

    // Function pointer targets: var_name -> target function QN
    const char** fp_var_names;
    const char** fp_target_qns;
    int fp_count;
    int fp_cap;

    // Template parameter defaults for current template scope
    const char** template_param_names;    // e.g., ["T", "U"]
    const CtxType** template_param_defaults; // e.g., [int_type, NULL]
    int template_param_count;

    // Pending template calls: member calls on TYPE_PARAM inside template functions.
    // At call sites with known arg types, these are resolved retroactively.
    struct {
        const char* func_qn;       // enclosing template function
        const char* type_param;    // e.g., "T"
        const char* method_name;   // e.g., "draw"
        int arg_count;
    } *pending_template_calls;
    int pending_tc_count;
    int pending_tc_cap;

    // Flags
    bool cpp_mode;          // C++ features enabled
    bool in_template;       // currently inside template declaration
    bool debug;
    int eval_depth;         // recursion depth for c_eval_expr_type (crash guard)
} CLSPContext;

// --- API ---

void c_lsp_init(CLSPContext* ctx, CtxArena* arena, const char* source, int source_len,
    const CtxTypeRegistry* registry, const char* module_qn, bool cpp_mode,
    CtxResolvedCallArray* out);

void c_lsp_add_include(CLSPContext* ctx, const char* header_path, const char* ns_qn);

void c_lsp_process_file(CLSPContext* ctx, TSNode root);

const CtxType* c_eval_expr_type(CLSPContext* ctx, TSNode node);
const CtxType* c_parse_type_node(CLSPContext* ctx, TSNode node);
void c_process_statement(CLSPContext* ctx, TSNode node);

// Look up a member (method/field) on a type, traversing base classes.
const CtxRegisteredFunc* c_lookup_member(CLSPContext* ctx, const char* type_qn, const char* member_name);

// Type simplification: unwrap refs, aliases, pointers (like clangd simplifyType).
const CtxType* c_simplify_type(CLSPContext* ctx, const CtxType* t, bool unwrap_pointer);

// --- Entry points ---

// Single-file LSP: build registry from file defs + stdlib, run resolution.
void ctx_run_c_lsp(CtxArena* arena, CtxFileResult* result,
    const char* source, int source_len, TSNode root, bool cpp_mode);

// Cross-file LSP: build registry from defs + stdlib, re-parse and resolve.
void ctx_run_c_lsp_cross(
    CtxArena* arena,
    const char* source, int source_len,
    const char* module_qn,
    bool cpp_mode,
    CtxLSPDef* defs, int def_count,
    const char** include_paths, const char** include_ns_qns, int include_count,
    TSTree* cached_tree,           // NULL = parse internally
    CtxResolvedCallArray* out);

// Register C stdlib types and functions into a registry.
void ctx_c_stdlib_register(CtxTypeRegistry* reg, CtxArena* arena);

// Register C++ stdlib types and functions into a registry.
void ctx_cpp_stdlib_register(CtxTypeRegistry* reg, CtxArena* arena);

// --- Batch cross-file LSP ---

// Per-file input for batch C/C++ LSP processing.
typedef struct {
    const char* source;
    int source_len;
    const char* module_qn;
    bool cpp_mode;
    TSTree* cached_tree;           // from TSTree caching (NULL = parse internally)
    CtxLSPDef* defs;               // combined file-local + cross-file defs
    int def_count;
    const char** include_paths;    // parallel arrays, include_count long
    const char** include_ns_qns;
    int include_count;
} CtxBatchCLSPFile;

// Process multiple C/C++ files' cross-file LSP in one CGo call.
// out must point to file_count pre-zeroed CtxResolvedCallArray structs.
void ctx_batch_c_lsp_cross(
    CtxArena* arena,
    CtxBatchCLSPFile* files, int file_count,
    CtxResolvedCallArray* out);

#endif // CTX_LSP_C_LSP_H

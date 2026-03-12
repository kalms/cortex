#include "c_lsp.h"
#include "../helpers.h"
#include <string.h>
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>

// Forward declarations
static void c_resolve_calls_in_node(CLSPContext* ctx, TSNode node);
static void c_emit_resolved_call(CLSPContext* ctx, const char* callee_qn, const char* strategy, float confidence);
static void c_emit_unresolved_call(CLSPContext* ctx, const char* expr_text, const char* reason);
static const CBMType* c_lookup_field_type(CLSPContext* ctx, const char* type_qn, const char* field_name, int depth);
static void c_process_function(CLSPContext* ctx, TSNode func_node);
static void c_process_namespace(CLSPContext* ctx, TSNode ns_node);
static void c_process_class(CLSPContext* ctx, TSNode class_node);
static void c_process_body_child(CLSPContext* ctx, TSNode child);
static const char* type_to_qn(const CBMType* t);
const CBMType* c_simplify_type(CLSPContext* ctx, const CBMType* t, bool unwrap_pointer);
const CBMType* c_eval_expr_type(CLSPContext* ctx, TSNode node);

// External tree-sitter language functions (defined in grammar_*.c)
extern const TSLanguage* tree_sitter_c(void);
extern const TSLanguage* tree_sitter_cpp(void);

// --- Smart pointer names for deref ---
static bool is_smart_ptr(const char* name) {
    if (!name) return false;
    return strcmp(name, "std.unique_ptr") == 0 ||
           strcmp(name, "std.shared_ptr") == 0 ||
           strcmp(name, "std.weak_ptr") == 0 ||
           strcmp(name, "std.auto_ptr") == 0 ||
           strcmp(name, "boost.shared_ptr") == 0 ||
           strcmp(name, "boost.scoped_ptr") == 0 ||
           // Legacy :: format (cross-file defs)
           strcmp(name, "std::unique_ptr") == 0 ||
           strcmp(name, "std::shared_ptr") == 0 ||
           strcmp(name, "std::weak_ptr") == 0;
}

// --- Helper: get node text ---
static char* c_node_text(CLSPContext* ctx, TSNode node) {
    return cbm_node_text(ctx->arena, node, ctx->source);
}

// --- Initialization ---

void c_lsp_init(CLSPContext* ctx, CBMArena* arena, const char* source, int source_len,
    const CBMTypeRegistry* registry, const char* module_qn, bool cpp_mode,
    CBMResolvedCallArray* out) {
    memset(ctx, 0, sizeof(CLSPContext));
    ctx->arena = arena;
    ctx->source = source;
    ctx->source_len = source_len;
    ctx->registry = registry;
    ctx->module_qn = module_qn;
    ctx->cpp_mode = cpp_mode;
    ctx->resolved_calls = out;
    ctx->current_scope = cbm_scope_push(arena, NULL);

    const char* debug_env = getenv("CBM_LSP_DEBUG");
    ctx->debug = (debug_env && debug_env[0]);
}

void c_lsp_add_include(CLSPContext* ctx, const char* header_path, const char* ns_qn) {
    if (ctx->include_count % 32 == 0) {
        int new_cap = ctx->include_count + 32;
        const char** new_paths = (const char**)cbm_arena_alloc(ctx->arena, (new_cap + 1) * sizeof(const char*));
        const char** new_qns = (const char**)cbm_arena_alloc(ctx->arena, (new_cap + 1) * sizeof(const char*));
        if (!new_paths || !new_qns) return;
        if (ctx->include_paths && ctx->include_count > 0) {
            memcpy(new_paths, ctx->include_paths, ctx->include_count * sizeof(const char*));
            memcpy(new_qns, ctx->include_ns_qns, ctx->include_count * sizeof(const char*));
        }
        ctx->include_paths = new_paths;
        ctx->include_ns_qns = new_qns;
    }
    ctx->include_paths[ctx->include_count] = cbm_arena_strdup(ctx->arena, header_path);
    ctx->include_ns_qns[ctx->include_count] = cbm_arena_strdup(ctx->arena, ns_qn);
    ctx->include_count++;
}

// --- Helper: add using namespace ---
static void c_add_using_namespace(CLSPContext* ctx, const char* ns_qn) {
    if (ctx->using_ns_count >= ctx->using_ns_cap) {
        int new_cap = ctx->using_ns_cap == 0 ? 16 : ctx->using_ns_cap * 2;
        const char** new_arr = (const char**)cbm_arena_alloc(ctx->arena, new_cap * sizeof(const char*));
        if (!new_arr) return;
        if (ctx->using_namespaces && ctx->using_ns_count > 0)
            memcpy(new_arr, ctx->using_namespaces, ctx->using_ns_count * sizeof(const char*));
        ctx->using_namespaces = new_arr;
        ctx->using_ns_cap = new_cap;
    }
    ctx->using_namespaces[ctx->using_ns_count++] = cbm_arena_strdup(ctx->arena, ns_qn);
}

// --- Helper: add using declaration ---
static void c_add_using_decl(CLSPContext* ctx, const char* short_name, const char* full_qn) {
    if (ctx->using_decl_count >= ctx->using_decl_cap) {
        int new_cap = ctx->using_decl_cap == 0 ? 16 : ctx->using_decl_cap * 2;
        const char** new_names = (const char**)cbm_arena_alloc(ctx->arena, new_cap * sizeof(const char*));
        const char** new_qns = (const char**)cbm_arena_alloc(ctx->arena, new_cap * sizeof(const char*));
        if (!new_names || !new_qns) return;
        if (ctx->using_decl_names && ctx->using_decl_count > 0) {
            memcpy(new_names, ctx->using_decl_names, ctx->using_decl_count * sizeof(const char*));
            memcpy(new_qns, ctx->using_decl_qns, ctx->using_decl_count * sizeof(const char*));
        }
        ctx->using_decl_names = new_names;
        ctx->using_decl_qns = new_qns;
        ctx->using_decl_cap = new_cap;
    }
    ctx->using_decl_names[ctx->using_decl_count] = cbm_arena_strdup(ctx->arena, short_name);
    ctx->using_decl_qns[ctx->using_decl_count] = cbm_arena_strdup(ctx->arena, full_qn);
    ctx->using_decl_count++;
}

// --- Helper: add namespace alias ---
static void c_add_ns_alias(CLSPContext* ctx, const char* alias, const char* full_qn) {
    if (ctx->ns_alias_count >= ctx->ns_alias_cap) {
        int new_cap = ctx->ns_alias_cap == 0 ? 8 : ctx->ns_alias_cap * 2;
        const char** new_names = (const char**)cbm_arena_alloc(ctx->arena, new_cap * sizeof(const char*));
        const char** new_qns = (const char**)cbm_arena_alloc(ctx->arena, new_cap * sizeof(const char*));
        if (!new_names || !new_qns) return;
        if (ctx->ns_alias_names && ctx->ns_alias_count > 0) {
            memcpy(new_names, ctx->ns_alias_names, ctx->ns_alias_count * sizeof(const char*));
            memcpy(new_qns, ctx->ns_alias_qns, ctx->ns_alias_count * sizeof(const char*));
        }
        ctx->ns_alias_names = new_names;
        ctx->ns_alias_qns = new_qns;
        ctx->ns_alias_cap = new_cap;
    }
    ctx->ns_alias_names[ctx->ns_alias_count] = cbm_arena_strdup(ctx->arena, alias);
    ctx->ns_alias_qns[ctx->ns_alias_count] = cbm_arena_strdup(ctx->arena, full_qn);
    ctx->ns_alias_count++;
}

// --- Helper: track function pointer target ---
static void c_add_fp_target(CLSPContext* ctx, const char* var_name, const char* target_qn) {
    if (ctx->fp_count >= ctx->fp_cap) {
        int new_cap = ctx->fp_cap == 0 ? 16 : ctx->fp_cap * 2;
        const char** new_names = (const char**)cbm_arena_alloc(ctx->arena, new_cap * sizeof(const char*));
        const char** new_qns = (const char**)cbm_arena_alloc(ctx->arena, new_cap * sizeof(const char*));
        if (!new_names || !new_qns) return;
        if (ctx->fp_var_names && ctx->fp_count > 0) {
            memcpy(new_names, ctx->fp_var_names, ctx->fp_count * sizeof(const char*));
            memcpy(new_qns, ctx->fp_target_qns, ctx->fp_count * sizeof(const char*));
        }
        ctx->fp_var_names = new_names;
        ctx->fp_target_qns = new_qns;
        ctx->fp_cap = new_cap;
    }
    ctx->fp_var_names[ctx->fp_count] = cbm_arena_strdup(ctx->arena, var_name);
    ctx->fp_target_qns[ctx->fp_count] = cbm_arena_strdup(ctx->arena, target_qn);
    ctx->fp_count++;
}

// Look up function pointer target
static const char* c_lookup_fp_target(CLSPContext* ctx, const char* var_name) {
    for (int i = ctx->fp_count - 1; i >= 0; i--) {
        if (strcmp(ctx->fp_var_names[i], var_name) == 0)
            return ctx->fp_target_qns[i];
    }
    return NULL;
}

// --- Helper: pending template calls (member calls on TYPE_PARAM inside templates) ---
static void c_add_pending_template_call(CLSPContext* ctx, const char* func_qn,
    const char* type_param, const char* method_name, int arg_count) {
    if (!func_qn || !type_param || !method_name) return;
    if (ctx->pending_tc_count >= ctx->pending_tc_cap) {
        int new_cap = ctx->pending_tc_cap == 0 ? 16 : ctx->pending_tc_cap * 2;
        size_t sz = new_cap * sizeof(ctx->pending_template_calls[0]);
        void* new_arr = cbm_arena_alloc(ctx->arena, sz);
        if (!new_arr) return;
        if (ctx->pending_template_calls && ctx->pending_tc_count > 0)
            memcpy(new_arr, ctx->pending_template_calls,
                ctx->pending_tc_count * sizeof(ctx->pending_template_calls[0]));
        ctx->pending_template_calls = new_arr;
        ctx->pending_tc_cap = new_cap;
    }
    int i = ctx->pending_tc_count++;
    ctx->pending_template_calls[i].func_qn = cbm_arena_strdup(ctx->arena, func_qn);
    ctx->pending_template_calls[i].type_param = cbm_arena_strdup(ctx->arena, type_param);
    ctx->pending_template_calls[i].method_name = cbm_arena_strdup(ctx->arena, method_name);
    ctx->pending_template_calls[i].arg_count = arg_count;
}

// Resolve pending template calls for a function being called with known arg types.
// Deduces type params from call-site args and resolves stored method calls.
static void c_resolve_pending_template_calls(CLSPContext* ctx,
    const CBMRegisteredFunc* callee, const CBMType** call_arg_types, int call_arg_count) {
    if (!callee || !callee->type_param_names || !call_arg_types) return;

    // Build type param → concrete type mapping from call-site arguments
    const char** tpn = callee->type_param_names;
    const CBMType* param_map[8] = {0};
    int tpn_count = 0;
    while (tpn[tpn_count] && tpn_count < 8) tpn_count++;

    // Match call arg types against function param types to deduce type params
    if (callee->signature && callee->signature->kind == CBM_TYPE_FUNC &&
        callee->signature->data.func.param_types) {
        for (int i = 0; i < call_arg_count; i++) {
            const CBMType* formal = callee->signature->data.func.param_types[i];
            if (!formal || !call_arg_types[i]) continue;
            // Unwrap references/pointers
            while (formal && (formal->kind == CBM_TYPE_REFERENCE ||
                              formal->kind == CBM_TYPE_RVALUE_REF ||
                              formal->kind == CBM_TYPE_POINTER)) {
                formal = (formal->kind == CBM_TYPE_POINTER) ?
                    formal->data.pointer.elem : formal->data.reference.elem;
            }
            if (formal && formal->kind == CBM_TYPE_TYPE_PARAM) {
                for (int j = 0; j < tpn_count; j++) {
                    if (strcmp(tpn[j], formal->data.type_param.name) == 0) {
                        const CBMType* arg = call_arg_types[i];
                        arg = c_simplify_type(ctx, arg, false);
                        param_map[j] = arg;
                    }
                }
            }
        }
    }

    // Resolve pending calls for this function
    for (int i = 0; i < ctx->pending_tc_count; i++) {
        if (strcmp(ctx->pending_template_calls[i].func_qn, callee->qualified_name) != 0)
            continue;
        const char* tp = ctx->pending_template_calls[i].type_param;
        const char* method = ctx->pending_template_calls[i].method_name;

        // Find which type param this is
        for (int j = 0; j < tpn_count; j++) {
            if (strcmp(tpn[j], tp) != 0 || !param_map[j]) continue;
            const char* concrete_qn = type_to_qn(param_map[j]);
            if (!concrete_qn) continue;
            // Look up the method on the concrete type
            const CBMRegisteredFunc* m = c_lookup_member(ctx, concrete_qn, method);
            if (m) {
                c_emit_resolved_call(ctx, m->qualified_name, "lsp_template_instantiation", 0.90f);
            }
            break;
        }
    }
}

// --- Helper: extract call argument types for overload scoring ---
static const CBMType** c_extract_call_arg_types(CLSPContext* ctx, TSNode call_node, int* out_count) {
    TSNode args = ts_node_child_by_field_name(call_node, "arguments", 9);
    if (ts_node_is_null(args)) { *out_count = 0; return NULL; }
    uint32_t nc = ts_node_named_child_count(args);
    if (nc == 0) { *out_count = 0; return NULL; }
    const CBMType** types = (const CBMType**)cbm_arena_alloc(ctx->arena, (nc + 1) * sizeof(const CBMType*));
    if (!types) { *out_count = 0; return NULL; }
    int count = 0;
    for (uint32_t i = 0; i < nc; i++) {
        TSNode child = ts_node_named_child(args, i);
        if (!ts_node_is_null(child)) {
            types[count++] = c_eval_expr_type(ctx, child);
        }
    }
    types[count] = NULL;
    *out_count = count;
    return types;
}

// --- Helper: parse template parameter defaults ---
static void c_parse_template_params(CLSPContext* ctx, TSNode template_decl) {
    TSNode params = ts_node_child_by_field_name(template_decl, "parameters", 10);
    if (ts_node_is_null(params)) return;

    ctx->template_param_count = 0;
    uint32_t nc = ts_node_named_child_count(params);
    if (nc == 0) return;

    const char** names = (const char**)cbm_arena_alloc(ctx->arena, (nc + 1) * sizeof(const char*));
    const CBMType** defaults = (const CBMType**)cbm_arena_alloc(ctx->arena, (nc + 1) * sizeof(const CBMType*));
    if (!names || !defaults) return;

    int idx = 0;
    for (uint32_t i = 0; i < nc && idx < 16; i++) {
        TSNode param = ts_node_named_child(params, i);
        if (ts_node_is_null(param)) continue;
        const char* pk = ts_node_type(param);

        // type_parameter_declaration: template<class T = int>
        // optional_type_parameter_declaration: template<class T = Default>
        if (strcmp(pk, "type_parameter_declaration") == 0 ||
            strcmp(pk, "optional_type_parameter_declaration") == 0) {
            // Get parameter name
            TSNode name_node = ts_node_child_by_field_name(param, "name", 4);
            if (ts_node_is_null(name_node)) {
                // Some grammars put the identifier as a direct child
                for (uint32_t j = 0; j < ts_node_named_child_count(param); j++) {
                    TSNode ch = ts_node_named_child(param, j);
                    if (strcmp(ts_node_type(ch), "type_identifier") == 0 ||
                        strcmp(ts_node_type(ch), "identifier") == 0) {
                        name_node = ch;
                        break;
                    }
                }
            }

            char* pname = NULL;
            if (!ts_node_is_null(name_node)) pname = c_node_text(ctx, name_node);
            if (!pname) pname = cbm_arena_sprintf(ctx->arena, "T%d", idx);

            names[idx] = pname;

            // Get default type
            TSNode default_node = ts_node_child_by_field_name(param, "default_type", 12);
            if (ts_node_is_null(default_node)) {
                // Try "default_value" field
                default_node = ts_node_child_by_field_name(param, "default", 7);
            }
            if (!ts_node_is_null(default_node)) {
                defaults[idx] = c_parse_type_node(ctx, default_node);
            } else {
                defaults[idx] = NULL;
            }
            idx++;
        }
    }

    names[idx] = NULL;
    defaults[idx] = NULL;
    ctx->template_param_names = names;
    ctx->template_param_defaults = defaults;
    ctx->template_param_count = idx;
}

// Resolve a template type parameter using defaults from current template scope
static const CBMType* c_resolve_template_param(CLSPContext* ctx, const char* param_name) {
    if (!param_name || !ctx->template_param_names) return NULL;
    for (int i = 0; i < ctx->template_param_count; i++) {
        if (ctx->template_param_names[i] &&
            strcmp(ctx->template_param_names[i], param_name) == 0) {
            return ctx->template_param_defaults[i];  // may be NULL if no default
        }
    }
    return NULL;
}

// --- Helper: resolve namespace alias ---
static const char* c_resolve_ns_alias(CLSPContext* ctx, const char* name) {
    for (int i = 0; i < ctx->ns_alias_count; i++) {
        if (strcmp(ctx->ns_alias_names[i], name) == 0)
            return ctx->ns_alias_qns[i];
    }
    return NULL;
}

// --- C/C++ builtin check ---
static bool is_c_builtin_type(const char* name) {
    static const char* builtins[] = {
        "int", "char", "short", "long", "float", "double", "void",
        "bool", "size_t", "ssize_t", "ptrdiff_t", "intptr_t", "uintptr_t",
        "int8_t", "int16_t", "int32_t", "int64_t",
        "uint8_t", "uint16_t", "uint32_t", "uint64_t",
        "wchar_t", "char16_t", "char32_t", "char8_t",
        "unsigned", "signed",
        NULL
    };
    for (const char** b = builtins; *b; b++) {
        if (strcmp(name, *b) == 0) return true;
    }
    return false;
}

static bool is_c_builtin_func(const char* name) {
    // C stdlib functions are registered in the registry, not hardcoded here.
    // But we skip certain compiler builtins that should not generate CALLS edges.
    static const char* skip[] = {
        "__builtin_expect", "__builtin_unreachable", "__builtin_offsetof",
        "__builtin_va_start", "__builtin_va_end", "__builtin_va_arg",
        "sizeof", "alignof", "_Alignof", "typeof", "decltype",
        "static_assert", "_Static_assert",
        NULL
    };
    for (const char** b = skip; *b; b++) {
        if (strcmp(name, *b) == 0) return true;
    }
    return false;
}

// --- Qualified name construction ---

// Build a qualified name from a namespace-qualified identifier.
// Converts "::" to "." for our QN format.
// Inline ABI namespaces to strip during QN construction.
// Only ABI-internal segments, NOT __detail (contains internal types).
static bool is_inline_abi_ns(const char* seg, size_t seg_len) {
    return (seg_len == 3 && memcmp(seg, "__1", 3) == 0) ||
           (seg_len == 7 && memcmp(seg, "__cxx11", 7) == 0) ||
           (seg_len == 9 && memcmp(seg, "__gnu_cxx", 9) == 0);
}

static const char* c_build_qn(CLSPContext* ctx, const char* text) {
    if (!text) return NULL;
    // Replace :: with . and strip inline ABI namespaces
    size_t len = strlen(text);
    char* buf = (char*)cbm_arena_alloc(ctx->arena, len + 1);
    if (!buf) return text;
    size_t j = 0;
    for (size_t i = 0; i < len; i++) {
        if (text[i] == ':' && i + 1 < len && text[i + 1] == ':') {
            // Peek at next segment to check for inline ABI namespace
            size_t seg_start = i + 2;
            size_t seg_end = seg_start;
            while (seg_end < len && text[seg_end] != ':') seg_end++;
            size_t seg_len = seg_end - seg_start;
            if (seg_len > 0 && is_inline_abi_ns(text + seg_start, seg_len) &&
                seg_end + 1 < len && text[seg_end] == ':' && text[seg_end + 1] == ':') {
                // Skip ABI ns + its trailing ::
                i = seg_end + 1; // loop increments to seg_end+2 = after "::"
                // Don't emit a dot — we're removing this segment
                continue;
            }
            buf[j++] = '.';
            i++; // skip second ':'
        } else {
            buf[j++] = text[i];
        }
    }
    buf[j] = '\0';
    return buf;
}

// --- Name lookup (C++ multi-scope resolution) ---

// Look up a name following C++ name resolution order:
// 1. Current scope chain
// 2. Using declarations
// 3. Enclosing class (implicit this)
// 4. Using namespaces
// 5. Current namespace
// 6. Module scope
static const char* c_resolve_name(CLSPContext* ctx, const char* name) {
    if (!name) return NULL;

    // 1. Scope lookup
    const CBMType* t = cbm_scope_lookup(ctx->current_scope, name);
    if (!cbm_type_is_unknown(t)) return NULL; // found in scope, not a function

    // 2. Using declarations
    for (int i = 0; i < ctx->using_decl_count; i++) {
        if (strcmp(ctx->using_decl_names[i], name) == 0)
            return ctx->using_decl_qns[i];
    }

    // 3. Enclosing class (implicit this)
    if (ctx->enclosing_class_qn) {
        const CBMRegisteredFunc* f = cbm_registry_lookup_method(ctx->registry,
            ctx->enclosing_class_qn, name);
        if (f) return f->qualified_name;
    }

    // 4. Using namespaces
    for (int i = 0; i < ctx->using_ns_count; i++) {
        const CBMRegisteredFunc* f = cbm_registry_lookup_symbol(ctx->registry,
            ctx->using_namespaces[i], name);
        if (f) return f->qualified_name;
    }

    // 5. Current namespace + parent namespaces
    if (ctx->current_namespace) {
        const char* ns = ctx->current_namespace;
        while (ns && ns[0]) {
            const CBMRegisteredFunc* f = cbm_registry_lookup_symbol(ctx->registry, ns, name);
            if (f) return f->qualified_name;
            // Walk up: "a.b.c" -> "a.b" -> "a"
            const char* dot = strrchr(ns, '.');
            if (!dot) break;
            char* parent = (char*)cbm_arena_alloc(ctx->arena, (size_t)(dot - ns) + 1);
            if (!parent) break;
            memcpy(parent, ns, (size_t)(dot - ns));
            parent[dot - ns] = '\0';
            ns = parent;
        }
    }

    // 6. Module scope
    if (ctx->module_qn) {
        const CBMRegisteredFunc* f = cbm_registry_lookup_symbol(ctx->registry,
            ctx->module_qn, name);
        if (f) return f->qualified_name;
    }

    // 7. Global scope (no prefix — C stdlib functions)
    const CBMRegisteredFunc* f = cbm_registry_lookup_func(ctx->registry, name);
    if (f) return f->qualified_name;

    return NULL;
}

// --- ADL (Argument-Dependent Lookup) ---
// Extract the namespace from a qualified name: "std.vector" → "std", "boost.asio.ip" → "boost.asio"
static const char* extract_namespace_from_qn(CBMArena* arena, const char* qn) {
    if (!qn) return NULL;
    const char* dot = strrchr(qn, '.');
    if (!dot || dot == qn) return NULL;
    size_t len = (size_t)(dot - qn);
    char* ns = (char*)cbm_arena_alloc(arena, len + 1);
    if (!ns) return NULL;
    memcpy(ns, qn, len);
    ns[len] = '\0';
    return ns;
}

// ADL: resolve unqualified function call by searching namespaces of argument types.
// E.g., swap(a, b) where a is std::string → look up std::swap.
static const char* c_adl_resolve(CLSPContext* ctx, const char* name, TSNode call_node) {
    if (!ctx->cpp_mode || !name) return NULL;

    TSNode args = ts_node_child_by_field_name(call_node, "arguments", 9);
    if (ts_node_is_null(args)) return NULL;

    uint32_t nc = ts_node_named_child_count(args);
    if (nc == 0) return NULL;

    // Collect unique namespace QNs from argument types (max 8 to bound work)
    const char* namespaces[8];
    int ns_count = 0;

    for (uint32_t i = 0; i < nc && ns_count < 8; i++) {
        TSNode arg = ts_node_named_child(args, i);
        if (ts_node_is_null(arg)) continue;

        const CBMType* arg_type = c_eval_expr_type(ctx, arg);
        const char* qn = type_to_qn(c_simplify_type(ctx, arg_type, false));
        if (!qn) continue;

        const char* ns = extract_namespace_from_qn(ctx->arena, qn);
        if (!ns) continue;

        // Deduplicate
        bool dup = false;
        for (int j = 0; j < ns_count; j++) {
            if (strcmp(namespaces[j], ns) == 0) { dup = true; break; }
        }
        if (!dup) namespaces[ns_count++] = ns;
    }

    // Try each namespace
    for (int i = 0; i < ns_count; i++) {
        const CBMRegisteredFunc* f = cbm_registry_lookup_symbol(ctx->registry,
            namespaces[i], name);
        if (f) return f->qualified_name;
    }

    return NULL;
}

// Resolve a name to a function QN via registry only (skips scope check).
// Used for function pointer target resolution where the name IS in scope
// as a function definition but we need the registry QN, not NULL.
static const char* c_resolve_name_to_func_qn(CLSPContext* ctx, const char* name) {
    if (!name) return NULL;

    // Using declarations
    for (int i = 0; i < ctx->using_decl_count; i++) {
        if (strcmp(ctx->using_decl_names[i], name) == 0)
            return ctx->using_decl_qns[i];
    }

    // Enclosing class
    if (ctx->enclosing_class_qn) {
        const CBMRegisteredFunc* f = cbm_registry_lookup_method(ctx->registry,
            ctx->enclosing_class_qn, name);
        if (f) return f->qualified_name;
    }

    // Using namespaces
    for (int i = 0; i < ctx->using_ns_count; i++) {
        const CBMRegisteredFunc* f = cbm_registry_lookup_symbol(ctx->registry,
            ctx->using_namespaces[i], name);
        if (f) return f->qualified_name;
    }

    // Current namespace + parents
    if (ctx->current_namespace) {
        const char* ns = ctx->current_namespace;
        while (ns && ns[0]) {
            const CBMRegisteredFunc* f = cbm_registry_lookup_symbol(ctx->registry, ns, name);
            if (f) return f->qualified_name;
            const char* dot = strrchr(ns, '.');
            if (!dot) break;
            char* parent = (char*)cbm_arena_alloc(ctx->arena, (size_t)(dot - ns) + 1);
            if (!parent) break;
            memcpy(parent, ns, (size_t)(dot - ns));
            parent[dot - ns] = '\0';
            ns = parent;
        }
    }

    // Module scope
    if (ctx->module_qn) {
        const CBMRegisteredFunc* f = cbm_registry_lookup_symbol(ctx->registry,
            ctx->module_qn, name);
        if (f) return f->qualified_name;
    }

    // Global scope
    const CBMRegisteredFunc* gf = cbm_registry_lookup_func(ctx->registry, name);
    if (gf) return gf->qualified_name;

    return NULL;
}

// Resolve a name to a type (for identifiers used as types)
static const CBMType* c_resolve_name_to_type(CLSPContext* ctx, const char* name) {
    if (!name) return cbm_type_unknown();

    // Builtin types
    if (is_c_builtin_type(name)) return cbm_type_builtin(ctx->arena, name);

    // Template type parameters (T, U, etc.)
    if (ctx->in_template && ctx->template_param_names) {
        for (int i = 0; i < ctx->template_param_count; i++) {
            if (ctx->template_param_names[i] &&
                strcmp(ctx->template_param_names[i], name) == 0) {
                // Return default if available, otherwise TYPE_PARAM
                if (ctx->template_param_defaults && ctx->template_param_defaults[i])
                    return ctx->template_param_defaults[i];
                return cbm_type_type_param(ctx->arena, name);
            }
        }
    }

    // Using declarations
    for (int i = 0; i < ctx->using_decl_count; i++) {
        if (strcmp(ctx->using_decl_names[i], name) == 0) {
            const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, ctx->using_decl_qns[i]);
            if (rt) return cbm_type_named(ctx->arena, rt->qualified_name);
        }
    }

    // Enclosing class (nested types: Factory::Product)
    if (ctx->enclosing_class_qn) {
        const char* qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->enclosing_class_qn, name);
        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, qn);
        if (rt) return cbm_type_named(ctx->arena, qn);
    }

    // Current namespace
    if (ctx->current_namespace) {
        const char* qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->current_namespace, name);
        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, qn);
        if (rt) return cbm_type_named(ctx->arena, qn);
    }

    // Module scope
    if (ctx->module_qn) {
        const char* qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, name);
        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, qn);
        if (rt) return cbm_type_named(ctx->arena, qn);
    }

    // Using namespaces
    for (int i = 0; i < ctx->using_ns_count; i++) {
        const char* qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->using_namespaces[i], name);
        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, qn);
        if (rt) return cbm_type_named(ctx->arena, qn);
    }

    // Try std:: prefix (very common)
    if (ctx->cpp_mode) {
        const char* std_qn = cbm_arena_sprintf(ctx->arena, "std.%s", name);
        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, std_qn);
        if (rt) return cbm_type_named(ctx->arena, std_qn);
    }

    // Unresolved — return named with module prefix
    if (ctx->module_qn) {
        return cbm_type_named(ctx->arena,
            cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, name));
    }
    return cbm_type_named(ctx->arena, name);
}

// ============================================================================
// c_parse_type_node: AST type node -> CBMType
// ============================================================================

const CBMType* c_parse_type_node(CLSPContext* ctx, TSNode node) {
    if (ts_node_is_null(node)) return cbm_type_unknown();
    const char* kind = ts_node_type(node);

    // primitive_type: int, double, char, void, bool
    if (strcmp(kind, "primitive_type") == 0) {
        char* name = c_node_text(ctx, node);
        return name ? cbm_type_builtin(ctx->arena, name) : cbm_type_unknown();
    }

    // sized_type_specifier: unsigned int, long long, etc.
    if (strcmp(kind, "sized_type_specifier") == 0) {
        char* name = c_node_text(ctx, node);
        return name ? cbm_type_builtin(ctx->arena, name) : cbm_type_unknown();
    }

    // type_identifier: Foo, MyClass
    if (strcmp(kind, "type_identifier") == 0) {
        char* name = c_node_text(ctx, node);
        if (!name) return cbm_type_unknown();
        return c_resolve_name_to_type(ctx, name);
    }

    // qualified_identifier: std::vector, ns::Foo
    if (strcmp(kind, "qualified_identifier") == 0 ||
        strcmp(kind, "scoped_type_identifier") == 0) {
        // Check if name field is a template_type (e.g., std::vector<Widget>)
        // If so, build scoped QN prefix and delegate to template_type handler
        TSNode name_child = ts_node_child_by_field_name(node, "name", 4);
        if (!ts_node_is_null(name_child) &&
            strcmp(ts_node_type(name_child), "template_type") == 0) {
            // Build scope prefix from scope chain
            TSNode scope_node = ts_node_child_by_field_name(node, "scope", 5);
            char* scope_text = NULL;
            if (!ts_node_is_null(scope_node)) {
                scope_text = c_node_text(ctx, scope_node);
                if (scope_text) {
                    const char* alias_qn = c_resolve_ns_alias(ctx, scope_text);
                    if (alias_qn) scope_text = (char*)alias_qn;
                }
            }
            // Parse the template_type's own name
            TSNode tmpl_name = ts_node_child_by_field_name(name_child, "name", 4);
            TSNode tmpl_args = ts_node_child_by_field_name(name_child, "arguments", 9);
            char* tmpl_name_text = NULL;
            if (!ts_node_is_null(tmpl_name)) tmpl_name_text = c_node_text(ctx, tmpl_name);
            if (!tmpl_name_text) return cbm_type_unknown();

            // Build full QN: scope.template_name
            const char* template_qn;
            if (scope_text) {
                const char* scoped = cbm_arena_sprintf(ctx->arena, "%s::%s", scope_text, tmpl_name_text);
                template_qn = c_build_qn(ctx, scoped);
            } else {
                template_qn = c_build_qn(ctx, tmpl_name_text);
            }

            // Resolve against registry
            const CBMRegisteredType* trt = cbm_registry_lookup_type(ctx->registry, template_qn);
            if (!trt && ctx->module_qn) {
                const char* mod_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, template_qn);
                trt = cbm_registry_lookup_type(ctx->registry, mod_qn);
                if (trt) template_qn = mod_qn;
            }

            // Parse template arguments
            const CBMType* targs[16];
            int targ_count = 0;
            if (!ts_node_is_null(tmpl_args)) {
                uint32_t nc = ts_node_named_child_count(tmpl_args);
                for (uint32_t i = 0; i < nc && targ_count < 15; i++) {
                    TSNode arg = ts_node_named_child(tmpl_args, i);
                    if (ts_node_is_null(arg)) continue;
                    const char* ak = ts_node_type(arg);
                    if (strcmp(ak, "type_descriptor") == 0) {
                        if (ts_node_named_child_count(arg) > 0)
                            targs[targ_count++] = c_parse_type_node(ctx, ts_node_named_child(arg, 0));
                    } else {
                        targs[targ_count++] = c_parse_type_node(ctx, arg);
                    }
                }
            }

            if (targ_count > 0)
                return cbm_type_template(ctx->arena, template_qn, targs, targ_count);
            return cbm_type_named(ctx->arena, template_qn);
        }

        char* text = c_node_text(ctx, node);
        if (!text) return cbm_type_unknown();

        // Check for namespace alias at start
        TSNode scope_node = ts_node_child_by_field_name(node, "scope", 5);
        if (!ts_node_is_null(scope_node)) {
            char* scope_text = c_node_text(ctx, scope_node);
            if (scope_text) {
                const char* alias_qn = c_resolve_ns_alias(ctx, scope_text);
                if (alias_qn) {
                    if (!ts_node_is_null(name_child)) {
                        char* name = c_node_text(ctx, name_child);
                        if (name) text = (char*)cbm_arena_sprintf(ctx->arena, "%s::%s", alias_qn, name);
                    }
                }
            }
        }

        const char* qn = c_build_qn(ctx, text);
        // Check registry
        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, qn);
        if (rt) return cbm_type_named(ctx->arena, qn);
        return cbm_type_named(ctx->arena, qn);
    }

    // template_type: vector<int>, map<K,V>
    if (strcmp(kind, "template_type") == 0) {
        TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
        TSNode args_node = ts_node_child_by_field_name(node, "arguments", 9);

        char* name_text = NULL;
        if (!ts_node_is_null(name_node)) {
            name_text = c_node_text(ctx, name_node);
        }
        if (!name_text) return cbm_type_unknown();

        const char* template_qn = c_build_qn(ctx, name_text);

        // Try resolving short name to full QN
        const CBMRegisteredType* trt = cbm_registry_lookup_type(ctx->registry, template_qn);
        if (!trt && ctx->module_qn) {
            // Try with module prefix
            const char* mod_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, template_qn);
            trt = cbm_registry_lookup_type(ctx->registry, mod_qn);
            if (trt) template_qn = mod_qn;
        }
        if (!trt) {
            // Try with std:: prefix
            const char* std_qn = cbm_arena_sprintf(ctx->arena, "std.%s", template_qn);
            trt = cbm_registry_lookup_type(ctx->registry, std_qn);
            if (trt) template_qn = std_qn;
        }

        // Parse template arguments
        const CBMType* targs[16];
        int targ_count = 0;
        if (!ts_node_is_null(args_node)) {
            uint32_t nc = ts_node_named_child_count(args_node);
            for (uint32_t i = 0; i < nc && targ_count < 15; i++) {
                TSNode arg = ts_node_named_child(args_node, i);
                if (ts_node_is_null(arg)) continue;
                const char* ak = ts_node_type(arg);
                if (strcmp(ak, "type_descriptor") == 0) {
                    // type_descriptor wraps a type node
                    if (ts_node_named_child_count(arg) > 0) {
                        targs[targ_count++] = c_parse_type_node(ctx, ts_node_named_child(arg, 0));
                    }
                } else {
                    targs[targ_count++] = c_parse_type_node(ctx, arg);
                }
            }
        }

        if (targ_count > 0) {
            return cbm_type_template(ctx->arena, template_qn, targs, targ_count);
        }
        return cbm_type_named(ctx->arena, template_qn);
    }

    // pointer_declarator / pointer (*) in type context
    if (strcmp(kind, "pointer_declarator") == 0 ||
        strcmp(kind, "pointer_type") == 0) {
        if (ts_node_named_child_count(node) > 0) {
            return cbm_type_pointer(ctx->arena,
                c_parse_type_node(ctx, ts_node_named_child(node, 0)));
        }
        return cbm_type_pointer(ctx->arena, cbm_type_unknown());
    }

    // reference_declarator / reference_type (&)
    if (strcmp(kind, "reference_declarator") == 0 ||
        strcmp(kind, "abstract_reference_declarator") == 0) {
        if (ts_node_named_child_count(node) > 0) {
            return cbm_type_reference(ctx->arena,
                c_parse_type_node(ctx, ts_node_named_child(node, 0)));
        }
        return cbm_type_reference(ctx->arena, cbm_type_unknown());
    }

    // auto keyword
    if (strcmp(kind, "auto") == 0 || strcmp(kind, "placeholder_type_specifier") == 0) {
        return cbm_type_unknown(); // will be resolved from initializer
    }

    // decltype
    if (strcmp(kind, "decltype") == 0) {
        if (ts_node_named_child_count(node) > 0) {
            return c_eval_expr_type(ctx, ts_node_named_child(node, 0));
        }
        return cbm_type_unknown();
    }

    // const/volatile qualifier — strip and recurse
    if (strcmp(kind, "type_qualifier") == 0) {
        return cbm_type_unknown(); // qualifier itself has no type
    }

    // array_declarator: int[10]
    if (strcmp(kind, "array_declarator") == 0 || strcmp(kind, "array_type") == 0) {
        if (ts_node_named_child_count(node) > 0) {
            return cbm_type_slice(ctx->arena,
                c_parse_type_node(ctx, ts_node_named_child(node, 0)));
        }
        return cbm_type_unknown();
    }

    // function_declarator: int (*)(int)
    if (strcmp(kind, "function_declarator") == 0 ||
        strcmp(kind, "abstract_function_declarator") == 0) {
        return cbm_type_func(ctx->arena, NULL, NULL, NULL);
    }

    // struct_specifier / class_specifier (inline struct/class type)
    if (strcmp(kind, "struct_specifier") == 0 || strcmp(kind, "class_specifier") == 0) {
        TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
        if (!ts_node_is_null(name_node)) {
            char* name = c_node_text(ctx, name_node);
            if (name) return c_resolve_name_to_type(ctx, name);
        }
        // Anonymous struct
        CBMType* t = (CBMType*)cbm_arena_alloc(ctx->arena, sizeof(CBMType));
        memset(t, 0, sizeof(CBMType));
        t->kind = CBM_TYPE_STRUCT;
        return t;
    }

    // enum_specifier
    if (strcmp(kind, "enum_specifier") == 0) {
        TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
        if (!ts_node_is_null(name_node)) {
            char* name = c_node_text(ctx, name_node);
            if (name) return c_resolve_name_to_type(ctx, name);
        }
        return cbm_type_builtin(ctx->arena, "int");
    }

    // type_descriptor: wraps a type with optional qualifiers
    if (strcmp(kind, "type_descriptor") == 0) {
        uint32_t nc = ts_node_named_child_count(node);
        // Find the actual type node (skip qualifiers)
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_named_child(node, i);
            const char* ck = ts_node_type(child);
            if (strcmp(ck, "type_qualifier") != 0) {
                return c_parse_type_node(ctx, child);
            }
        }
        return cbm_type_unknown();
    }

    // parenthesized_type: (T)
    if (strcmp(kind, "parenthesized_type") == 0 && ts_node_named_child_count(node) > 0) {
        return c_parse_type_node(ctx, ts_node_named_child(node, 0));
    }

    // dependent_type: in template scope
    if (strcmp(kind, "dependent_type") == 0 || strcmp(kind, "dependent_name") == 0) {
        char* text = c_node_text(ctx, node);
        if (text) return cbm_type_named(ctx->arena, c_build_qn(ctx, text));
        return cbm_type_unknown();
    }

    return cbm_type_unknown();
}

// ============================================================================
// c_simplify_type: multi-step type unwrapping (clangd simplifyType)
// ============================================================================

const CBMType* c_simplify_type(CLSPContext* ctx, const CBMType* t, bool unwrap_pointer) {
    for (int i = 0; i < 64 && t; i++) {
        // Resolve aliases
        if (t->kind == CBM_TYPE_ALIAS) {
            if (t->data.alias.underlying) {
                t = t->data.alias.underlying;
                continue;
            }
            break;
        }

        // Resolve template type parameters using defaults
        if (t->kind == CBM_TYPE_TYPE_PARAM && ctx->in_template) {
            const CBMType* resolved = c_resolve_template_param(ctx, t->data.type_param.name);
            if (resolved) {
                t = resolved;
                continue;
            }
            break;  // no default available
        }

        // Unwrap references
        if (t->kind == CBM_TYPE_REFERENCE || t->kind == CBM_TYPE_RVALUE_REF) {
            t = t->data.reference.elem;
            continue;
        }

        if (!unwrap_pointer) break;

        // Unwrap pointer
        if (t->kind == CBM_TYPE_POINTER) {
            t = t->data.pointer.elem;
            break;
        }

        // Smart pointer: extract first template arg
        if (t->kind == CBM_TYPE_TEMPLATE && is_smart_ptr(t->data.template_type.template_name)) {
            if (t->data.template_type.arg_count > 0 && t->data.template_type.template_args) {
                t = t->data.template_type.template_args[0];
                break;
            }
        }

        // Named type with operator->
        if (t->kind == CBM_TYPE_NAMED) {
            const CBMRegisteredFunc* op = cbm_registry_lookup_method(ctx->registry,
                t->data.named.qualified_name, "operator->");
            if (op && op->signature && op->signature->kind == CBM_TYPE_FUNC &&
                op->signature->data.func.return_types && op->signature->data.func.return_types[0]) {
                t = op->signature->data.func.return_types[0];
                // deref the pointer return
                if (t->kind == CBM_TYPE_POINTER) t = t->data.pointer.elem;
                break;
            }
        }

        break;
    }
    return t ? t : cbm_type_unknown();
}

// Get the QN string from a type (for member lookup)
static const char* type_to_qn(const CBMType* t) {
    if (!t) return NULL;
    switch (t->kind) {
    case CBM_TYPE_NAMED: return t->data.named.qualified_name;
    case CBM_TYPE_TEMPLATE: return t->data.template_type.template_name;
    default: return NULL;
    }
}

// ============================================================================
// c_eval_expr_type: recursive expression type evaluator
// ============================================================================

const CBMType* c_eval_expr_type(CLSPContext* ctx, TSNode node) {
    if (ts_node_is_null(node)) return cbm_type_unknown();
    const char* kind = ts_node_type(node);

    // --- identifier: scope lookup ---
    if (strcmp(kind, "identifier") == 0) {
        char* name = c_node_text(ctx, node);
        if (!name) return cbm_type_unknown();

        // Scope lookup
        const CBMType* t = cbm_scope_lookup(ctx->current_scope, name);
        if (!cbm_type_is_unknown(t)) return t;

        // Check if it's a type name (for constructor calls / casts)
        const CBMType* type = c_resolve_name_to_type(ctx, name);
        if (type && type->kind == CBM_TYPE_NAMED) {
            // Could be a constructor call — return as type
            return type;
        }

        // Check if it's a registered function
        const char* fqn = c_resolve_name(ctx, name);
        if (fqn) {
            const CBMRegisteredFunc* f = cbm_registry_lookup_func(ctx->registry, fqn);
            if (f && f->signature) return f->signature;
        }

        return cbm_type_unknown();
    }

    // --- this ---
    if (strcmp(kind, "this") == 0) {
        if (ctx->enclosing_class_qn) {
            return cbm_type_pointer(ctx->arena,
                cbm_type_named(ctx->arena, ctx->enclosing_class_qn));
        }
        return cbm_type_unknown();
    }

    // --- field_expression: a.b or a->b ---
    if (strcmp(kind, "field_expression") == 0) {
        TSNode arg_node = ts_node_child_by_field_name(node, "argument", 8);
        TSNode field_node = ts_node_child_by_field_name(node, "field", 5);
        if (ts_node_is_null(arg_node) || ts_node_is_null(field_node))
            return cbm_type_unknown();

        char* field_name = c_node_text(ctx, field_node);
        if (!field_name) return cbm_type_unknown();

        const CBMType* obj_type = c_eval_expr_type(ctx, arg_node);
        if (cbm_type_is_unknown(obj_type)) return cbm_type_unknown();

        // Determine if this is . or -> access
        // Check for "->" operator in node text
        bool is_arrow = false;
        uint32_t nc = ts_node_child_count(node);
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_child(node, i);
            if (!ts_node_is_named(child)) {
                char* op = c_node_text(ctx, child);
                if (op && strcmp(op, "->") == 0) { is_arrow = true; break; }
            }
        }

        // Simplify type for member lookup
        const CBMType* base;
        if (is_arrow) {
            base = c_simplify_type(ctx, obj_type, true); // unwrap pointer/smart ptr
        } else {
            base = c_simplify_type(ctx, obj_type, false); // just unwrap refs/aliases
        }

        const char* type_qn = type_to_qn(base);
        if (!type_qn) return cbm_type_unknown();

        // Look up method
        const CBMRegisteredFunc* method = c_lookup_member(ctx, type_qn, field_name);
        if (method && method->signature) return method->signature;

        // Look up field
        const CBMType* field_type = c_lookup_field_type(ctx, type_qn, field_name, 0);
        if (field_type && !cbm_type_is_unknown(field_type)) return field_type;

        return cbm_type_unknown();
    }

    // --- qualified_identifier: ns::Class::method or Enum::Value ---
    if (strcmp(kind, "qualified_identifier") == 0) {
        char* text = c_node_text(ctx, node);
        if (!text) return cbm_type_unknown();
        const char* qn = c_build_qn(ctx, text);

        // Try as function
        const CBMRegisteredFunc* f = cbm_registry_lookup_func(ctx->registry, qn);
        if (f && f->signature) return f->signature;

        // Try as type
        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, qn);
        if (rt) return cbm_type_named(ctx->arena, qn);

        // Try as enum member: Enum::Value → look up Enum type, return int/enum type
        const char* dot = strrchr(qn, '.');
        if (dot) {
            size_t prefix_len = (size_t)(dot - qn);
            char* enum_qn = (char*)cbm_arena_alloc(ctx->arena, prefix_len + 1);
            if (enum_qn) {
                memcpy(enum_qn, qn, prefix_len);
                enum_qn[prefix_len] = '\0';
                const CBMRegisteredType* enum_rt = cbm_registry_lookup_type(ctx->registry, enum_qn);
                if (enum_rt) {
                    return cbm_type_named(ctx->arena, enum_qn);
                }
                // Try with module prefix
                if (ctx->module_qn) {
                    const char* fqn_enum = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, enum_qn);
                    enum_rt = cbm_registry_lookup_type(ctx->registry, fqn_enum);
                    if (enum_rt) return cbm_type_named(ctx->arena, fqn_enum);
                }
            }

            // Template heuristic: T::member where T is a template param with default
            if (ctx->in_template && dot) {
                size_t prefix_len2 = (size_t)(dot - qn);
                char* scope_name = (char*)cbm_arena_alloc(ctx->arena, prefix_len2 + 1);
                if (scope_name) {
                    memcpy(scope_name, qn, prefix_len2);
                    scope_name[prefix_len2] = '\0';
                    const CBMType* default_type = c_resolve_template_param(ctx, scope_name);
                    if (default_type) {
                        default_type = c_simplify_type(ctx, default_type, false);
                        const char* default_qn = type_to_qn(default_type);
                        if (default_qn) {
                            // Try as method: DefaultType::member
                            const char* member = dot + 1;
                            const CBMRegisteredFunc* mf = cbm_registry_lookup_method(
                                ctx->registry, default_qn, member);
                            if (mf && mf->signature) return mf->signature;
                            // Try as static function
                            const char* dep_qn = cbm_arena_sprintf(ctx->arena, "%s.%s",
                                default_qn, member);
                            const CBMRegisteredFunc* sf = cbm_registry_lookup_func(
                                ctx->registry, dep_qn);
                            if (sf && sf->signature) return sf->signature;
                        }
                    }
                }
            }
        }

        return cbm_type_unknown();
    }

    // --- template_function: make_shared<Widget>, make_unique<Foo> ---
    // Returns a FUNC type whose return type is TEMPLATE(base_return, [explicit_args]).
    if (strcmp(kind, "template_function") == 0) {
        TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
        TSNode args_node = ts_node_child_by_field_name(node, "arguments", 9);
        if (ts_node_is_null(name_node)) return cbm_type_unknown();

        char* name = c_node_text(ctx, name_node);
        if (!name) return cbm_type_unknown();

        // Look up the function — handle both simple and qualified names
        const CBMRegisteredFunc* f = NULL;
        const char* nk = ts_node_type(name_node);
        if (strcmp(nk, "qualified_identifier") == 0 || strcmp(nk, "scoped_identifier") == 0) {
            // Qualified: std::make_shared → std.make_shared
            const char* qn = c_build_qn(ctx, name);
            f = cbm_registry_lookup_func(ctx->registry, qn);
            if (!f && ctx->module_qn) {
                const char* mod_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, qn);
                f = cbm_registry_lookup_func(ctx->registry, mod_qn);
            }
        } else {
            const char* fqn = c_resolve_name(ctx, name);
            if (fqn) f = cbm_registry_lookup_func(ctx->registry, fqn);
        }
        if (!f || !f->signature) return cbm_type_unknown();

        // Get the base return type from the function signature
        const CBMType* base_ret = NULL;
        if (f->signature->kind == CBM_TYPE_FUNC &&
            f->signature->data.func.return_types &&
            f->signature->data.func.return_types[0]) {
            base_ret = f->signature->data.func.return_types[0];
        }
        if (!base_ret) return f->signature;

        // Parse explicit template arguments from <...>
        const CBMType* targs[16];
        int targ_count = 0;
        if (!ts_node_is_null(args_node)) {
            uint32_t nc = ts_node_named_child_count(args_node);
            for (uint32_t i = 0; i < nc && targ_count < 15; i++) {
                TSNode arg = ts_node_named_child(args_node, i);
                if (ts_node_is_null(arg)) continue;
                const char* ak = ts_node_type(arg);
                if (strcmp(ak, "type_descriptor") == 0) {
                    if (ts_node_named_child_count(arg) > 0)
                        targs[targ_count++] = c_parse_type_node(ctx, ts_node_named_child(arg, 0));
                } else {
                    targs[targ_count++] = c_parse_type_node(ctx, arg);
                }
            }
        }

        // Substitute explicit template args into return type
        if (targ_count > 0) {
            const char** tpn = f->type_param_names;
            if (tpn) {
                // Use registered type param names (e.g., ["T", NULL])
                base_ret = cbm_type_substitute(ctx->arena, base_ret, tpn, targs);
            } else {
                // Fallback: positional T, U, V
                const char* fallback_names[] = {"T", "U", "V", "W", NULL};
                base_ret = cbm_type_substitute(ctx->arena, base_ret, fallback_names, targs);
            }
        }

        // Wrap return type in FUNC signature
        const CBMType** rets = cbm_arena_alloc(ctx->arena, 2 * sizeof(CBMType*));
        rets[0] = base_ret;
        rets[1] = NULL;
        return cbm_type_func(ctx->arena, NULL, NULL, rets);
    }

    // --- call_expression: f(args) ---
    if (strcmp(kind, "call_expression") == 0) {
        TSNode func_node = ts_node_child_by_field_name(node, "function", 8);
        if (ts_node_is_null(func_node)) return cbm_type_unknown();

        const CBMType* func_type = c_eval_expr_type(ctx, func_node);
        if (!func_type) return cbm_type_unknown();

        // FUNC type -> return its return type
        if (func_type->kind == CBM_TYPE_FUNC &&
            func_type->data.func.return_types && func_type->data.func.return_types[0]) {
            const CBMType* ret = func_type->data.func.return_types[0];

            // Template param substitution: try receiver's template args (method calls)
            // then try TAD from call-site argument types (free function calls)
            bool needs_subst = (ret->kind == CBM_TYPE_TYPE_PARAM ||
                                ret->kind == CBM_TYPE_REFERENCE ||
                                ret->kind == CBM_TYPE_RVALUE_REF ||
                                ret->kind == CBM_TYPE_TEMPLATE);

            if (needs_subst) {
                bool substituted = false;

                // Strategy 1: method call on templated receiver — use receiver's template args
                if (strcmp(ts_node_type(func_node), "field_expression") == 0) {
                    TSNode arg_node = ts_node_child_by_field_name(func_node, "argument", 8);
                    if (!ts_node_is_null(arg_node)) {
                        const CBMType* obj_type = c_eval_expr_type(ctx, arg_node);
                        obj_type = c_simplify_type(ctx, obj_type, true);
                        if (obj_type && obj_type->kind == CBM_TYPE_TEMPLATE &&
                            obj_type->data.template_type.template_args) {
                            // Use registered type_param_names if available
                            TSNode field_node = ts_node_child_by_field_name(func_node, "field", 5);
                            char* method_name = !ts_node_is_null(field_node) ?
                                c_node_text(ctx, field_node) : NULL;
                            const char* recv_qn = type_to_qn(obj_type);
                            const CBMRegisteredFunc* mf = (recv_qn && method_name) ?
                                cbm_registry_lookup_method(ctx->registry, recv_qn, method_name) : NULL;
                            const char** tpn = mf ? mf->type_param_names : NULL;

                            // Build substitution from receiver template args
                            int nargs = obj_type->data.template_type.arg_count;
                            if (tpn) {
                                // Use actual type param names from function registration
                                ret = cbm_type_substitute(ctx->arena, ret, tpn,
                                    obj_type->data.template_type.template_args);
                                substituted = true;
                            } else {
                                // Fallback: positional params T, K, V, T1, T2
                                const char* params[] = {"T", "K", "V", "T1", "T2", NULL};
                                const CBMType* pargs[5] = {NULL};
                                if (nargs > 0) pargs[0] = obj_type->data.template_type.template_args[0];
                                if (nargs > 0) pargs[1] = obj_type->data.template_type.template_args[0];
                                if (nargs > 1) pargs[2] = obj_type->data.template_type.template_args[1];
                                if (nargs > 0) pargs[3] = obj_type->data.template_type.template_args[0];
                                if (nargs > 1) pargs[4] = obj_type->data.template_type.template_args[1];
                                ret = cbm_type_substitute(ctx->arena, ret, params, pargs);
                                substituted = true;
                            }
                        }
                    }
                }

                // Strategy 2: TAD — deduce template params from call-site argument types
                if (!substituted) {
                    // Find the registered function to get its type_param_names and param_types
                    const CBMRegisteredFunc* rf = NULL;
                    const char* fn_type = ts_node_type(func_node);
                    if (strcmp(fn_type, "identifier") == 0) {
                        char* fname = c_node_text(ctx, func_node);
                        if (fname) {
                            const char* fqn = c_resolve_name(ctx, fname);
                            if (fqn) rf = cbm_registry_lookup_func(ctx->registry, fqn);
                        }
                    } else if (strcmp(fn_type, "qualified_identifier") == 0 ||
                               strcmp(fn_type, "scoped_identifier") == 0) {
                        char* fname = c_node_text(ctx, func_node);
                        if (fname) {
                            const char* qn = c_build_qn(ctx, fname);
                            rf = cbm_registry_lookup_func(ctx->registry, qn);
                        }
                    }

                    if (rf && rf->type_param_names && rf->signature &&
                        rf->signature->kind == CBM_TYPE_FUNC &&
                        rf->signature->data.func.param_types) {
                        // Deduce: match call-site arg types against param types
                        // to bind type_param_names
                        int tp_count = 0;
                        while (rf->type_param_names[tp_count]) tp_count++;
                        if (tp_count > 0 && tp_count <= 8) {
                            const CBMType* deduced[8] = {NULL};
                            TSNode call_args = ts_node_child_by_field_name(node, "arguments", 9);
                            int pi = 0;
                            if (!ts_node_is_null(call_args)) {
                                uint32_t anc = ts_node_named_child_count(call_args);
                                for (uint32_t ai = 0; ai < anc && rf->signature->data.func.param_types[pi]; ai++) {
                                    TSNode carg = ts_node_named_child(call_args, ai);
                                    if (ts_node_is_null(carg)) continue;
                                    const CBMType* arg_t = c_eval_expr_type(ctx, carg);
                                    if (cbm_type_is_unknown(arg_t)) { pi++; continue; }
                                    // Unwrap ref/ptr from param type
                                    const CBMType* param_t = rf->signature->data.func.param_types[pi];
                                    while (param_t && (param_t->kind == CBM_TYPE_REFERENCE ||
                                                       param_t->kind == CBM_TYPE_RVALUE_REF ||
                                                       param_t->kind == CBM_TYPE_POINTER)) {
                                        if (param_t->kind == CBM_TYPE_POINTER) param_t = param_t->data.pointer.elem;
                                        else param_t = param_t->data.reference.elem;
                                    }
                                    // If param type is TYPE_PARAM, bind it
                                    if (param_t && param_t->kind == CBM_TYPE_TYPE_PARAM) {
                                        for (int ti = 0; ti < tp_count; ti++) {
                                            if (strcmp(rf->type_param_names[ti], param_t->data.type_param.name) == 0) {
                                                // Unwrap ref/ptr from actual arg too
                                                const CBMType* unwrapped = arg_t;
                                                while (unwrapped && (unwrapped->kind == CBM_TYPE_REFERENCE ||
                                                                     unwrapped->kind == CBM_TYPE_RVALUE_REF ||
                                                                     unwrapped->kind == CBM_TYPE_POINTER)) {
                                                    if (unwrapped->kind == CBM_TYPE_POINTER) unwrapped = unwrapped->data.pointer.elem;
                                                    else unwrapped = unwrapped->data.reference.elem;
                                                }
                                                if (!deduced[ti]) deduced[ti] = unwrapped;
                                                break;
                                            }
                                        }
                                    }
                                    pi++;
                                }
                            }
                            // Apply deduced substitutions
                            bool any_deduced = false;
                            for (int ti = 0; ti < tp_count; ti++) {
                                if (deduced[ti]) { any_deduced = true; break; }
                            }
                            if (any_deduced) {
                                ret = cbm_type_substitute(ctx->arena, ret,
                                    rf->type_param_names, deduced);
                            }
                        }
                    }
                }
            }

            // Unwrap references in return type
            if (ret->kind == CBM_TYPE_REFERENCE || ret->kind == CBM_TYPE_RVALUE_REF)
                ret = ret->data.reference.elem;
            return ret;
        }

        // Constructor call: Type(args) — if func_node resolves to a named type
        if (func_type->kind == CBM_TYPE_NAMED) {
            return func_type;
        }

        return cbm_type_unknown();
    }

    // --- new_expression: new Foo(args) ---
    if (strcmp(kind, "new_expression") == 0) {
        TSNode type_node = ts_node_child_by_field_name(node, "type", 4);
        if (!ts_node_is_null(type_node)) {
            return cbm_type_pointer(ctx->arena, c_parse_type_node(ctx, type_node));
        }
        // Try first named child
        uint32_t nc = ts_node_named_child_count(node);
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_named_child(node, i);
            const char* ck = ts_node_type(child);
            if (strcmp(ck, "type_identifier") == 0 || strcmp(ck, "template_type") == 0 ||
                strcmp(ck, "scoped_type_identifier") == 0 || strcmp(ck, "primitive_type") == 0) {
                return cbm_type_pointer(ctx->arena, c_parse_type_node(ctx, child));
            }
        }
        return cbm_type_pointer(ctx->arena, cbm_type_unknown());
    }

    // --- delete_expression ---
    if (strcmp(kind, "delete_expression") == 0) {
        return cbm_type_unknown(); // void
    }

    // --- subscript_expression: a[i] ---
    if (strcmp(kind, "subscript_expression") == 0) {
        TSNode arg_node = ts_node_child_by_field_name(node, "argument", 8);
        if (ts_node_is_null(arg_node)) return cbm_type_unknown();
        const CBMType* arr_type = c_eval_expr_type(ctx, arg_node);
        if (!arr_type) return cbm_type_unknown();

        // Array/slice: return element
        if (arr_type->kind == CBM_TYPE_SLICE) return arr_type->data.slice.elem;
        if (arr_type->kind == CBM_TYPE_POINTER) return arr_type->data.pointer.elem;

        // Template with operator[]: return via method lookup
        const char* qn = type_to_qn(c_simplify_type(ctx, arr_type, false));
        if (qn) {
            const CBMRegisteredFunc* op = cbm_registry_lookup_method(ctx->registry, qn, "operator[]");
            if (op && op->signature && op->signature->kind == CBM_TYPE_FUNC &&
                op->signature->data.func.return_types && op->signature->data.func.return_types[0]) {
                const CBMType* ret = op->signature->data.func.return_types[0];
                if (ret->kind == CBM_TYPE_REFERENCE) ret = ret->data.reference.elem;

                // Substitute template params
                if (ret->kind == CBM_TYPE_TYPE_PARAM && arr_type->kind == CBM_TYPE_TEMPLATE) {
                    const char* params[] = {"T", "K", "V", NULL};
                    const CBMType* args[3] = {NULL};
                    int nargs = arr_type->data.template_type.arg_count;
                    if (nargs > 0) args[0] = arr_type->data.template_type.template_args[0];
                    if (nargs > 0) args[1] = arr_type->data.template_type.template_args[0];
                    if (nargs > 1) args[2] = arr_type->data.template_type.template_args[1];
                    ret = cbm_type_substitute(ctx->arena, ret, params, args);
                }
                return ret;
            }
        }
        return cbm_type_unknown();
    }

    // --- cast expressions ---
    if (strcmp(kind, "cast_expression") == 0) {
        TSNode type_node = ts_node_child_by_field_name(node, "type", 4);
        if (!ts_node_is_null(type_node)) return c_parse_type_node(ctx, type_node);
        // Fallback: first named child might be type_descriptor
        if (ts_node_named_child_count(node) > 0) {
            TSNode first = ts_node_named_child(node, 0);
            if (strcmp(ts_node_type(first), "type_descriptor") == 0)
                return c_parse_type_node(ctx, first);
        }
        return cbm_type_unknown();
    }
    if (strcmp(kind, "static_cast_expression") == 0 ||
        strcmp(kind, "dynamic_cast_expression") == 0 ||
        strcmp(kind, "reinterpret_cast_expression") == 0 ||
        strcmp(kind, "const_cast_expression") == 0) {
        TSNode type_node = ts_node_child_by_field_name(node, "type", 4);
        if (!ts_node_is_null(type_node)) return c_parse_type_node(ctx, type_node);
        return cbm_type_unknown();
    }

    // --- unary_expression: *p, &x, !x, -x ---
    if (strcmp(kind, "unary_expression") == 0) {
        TSNode operand = ts_node_child_by_field_name(node, "argument", 8);
        if (ts_node_is_null(operand)) {
            // Try "operand" field name
            operand = ts_node_child_by_field_name(node, "operand", 7);
        }
        if (ts_node_is_null(operand)) return cbm_type_unknown();

        // Get operator from first non-named child
        for (uint32_t i = 0; i < ts_node_child_count(node); i++) {
            TSNode child = ts_node_child(node, i);
            if (!ts_node_is_named(child)) {
                char* op = c_node_text(ctx, child);
                if (!op) continue;
                if (strcmp(op, "*") == 0) {
                    const CBMType* inner = c_eval_expr_type(ctx, operand);
                    return cbm_type_deref(inner);
                }
                if (strcmp(op, "&") == 0) {
                    return cbm_type_pointer(ctx->arena, c_eval_expr_type(ctx, operand));
                }
                if (strcmp(op, "!") == 0 || strcmp(op, "~") == 0) {
                    return c_eval_expr_type(ctx, operand);
                }
                if (strcmp(op, "-") == 0 || strcmp(op, "+") == 0) {
                    return c_eval_expr_type(ctx, operand);
                }
                break;
            }
        }
        return cbm_type_unknown();
    }

    // --- pointer_expression: *p or &x (C tree-sitter uses this instead of unary_expression) ---
    if (strcmp(kind, "pointer_expression") == 0) {
        TSNode arg = ts_node_child_by_field_name(node, "argument", 8);
        if (ts_node_is_null(arg)) return cbm_type_unknown();
        // Check operator
        for (uint32_t i = 0; i < ts_node_child_count(node); i++) {
            TSNode child = ts_node_child(node, i);
            if (!ts_node_is_named(child)) {
                char* op = c_node_text(ctx, child);
                if (op && strcmp(op, "*") == 0) return cbm_type_deref(c_eval_expr_type(ctx, arg));
                if (op && strcmp(op, "&") == 0) return cbm_type_pointer(ctx->arena, c_eval_expr_type(ctx, arg));
                break;
            }
        }
        return cbm_type_unknown();
    }

    // --- update_expression: ++i, i++ ---
    if (strcmp(kind, "update_expression") == 0) {
        TSNode operand = ts_node_child_by_field_name(node, "argument", 8);
        if (!ts_node_is_null(operand)) return c_eval_expr_type(ctx, operand);
        return cbm_type_unknown();
    }

    // --- binary_expression ---
    if (strcmp(kind, "binary_expression") == 0) {
        TSNode left = ts_node_child_by_field_name(node, "left", 4);
        // Check operator for comparison (returns bool)
        for (uint32_t i = 0; i < ts_node_child_count(node); i++) {
            TSNode child = ts_node_child(node, i);
            if (!ts_node_is_named(child)) {
                char* op = c_node_text(ctx, child);
                if (op && (strcmp(op, "==") == 0 || strcmp(op, "!=") == 0 ||
                           strcmp(op, "<") == 0 || strcmp(op, ">") == 0 ||
                           strcmp(op, "<=") == 0 || strcmp(op, ">=") == 0 ||
                           strcmp(op, "&&") == 0 || strcmp(op, "||") == 0)) {
                    return cbm_type_builtin(ctx->arena, "bool");
                }
                break;
            }
        }
        if (!ts_node_is_null(left)) return c_eval_expr_type(ctx, left);
        return cbm_type_unknown();
    }

    // --- conditional_expression: a ? b : c ---
    if (strcmp(kind, "conditional_expression") == 0) {
        TSNode consequence = ts_node_child_by_field_name(node, "consequence", 11);
        if (!ts_node_is_null(consequence)) return c_eval_expr_type(ctx, consequence);
        return cbm_type_unknown();
    }

    // --- parenthesized_expression: (expr) ---
    if (strcmp(kind, "parenthesized_expression") == 0 && ts_node_named_child_count(node) > 0) {
        return c_eval_expr_type(ctx, ts_node_named_child(node, 0));
    }

    // --- comma_expression ---
    if (strcmp(kind, "comma_expression") == 0) {
        TSNode right = ts_node_child_by_field_name(node, "right", 5);
        if (!ts_node_is_null(right)) return c_eval_expr_type(ctx, right);
        return cbm_type_unknown();
    }

    // --- sizeof / alignof ---
    if (strcmp(kind, "sizeof_expression") == 0 || strcmp(kind, "alignof_expression") == 0) {
        return cbm_type_builtin(ctx->arena, "size_t");
    }

    // --- lambda_expression ---
    if (strcmp(kind, "lambda_expression") == 0) {
        const CBMType* ret_type = NULL;

        // Phase A: trailing return type on declarator (e.g., [](int x) -> Widget { ... })
        TSNode declarator = ts_node_child_by_field_name(node, "declarator", 10);
        if (!ts_node_is_null(declarator)) {
            uint32_t dnc = ts_node_named_child_count(declarator);
            for (uint32_t di = 0; di < dnc; di++) {
                TSNode ch = ts_node_named_child(declarator, di);
                if (strcmp(ts_node_type(ch), "trailing_return_type") == 0) {
                    TSNode type_desc = ts_node_named_child_count(ch) > 0 ?
                        ts_node_named_child(ch, 0) : ch;
                    ret_type = c_parse_type_node(ctx, type_desc);
                    break;
                }
            }
        }

        // Phase B: infer from body's immediate return statements (no descent into nested lambdas)
        if (!ret_type || cbm_type_is_unknown(ret_type)) {
            TSNode body = ts_node_child_by_field_name(node, "body", 4);
            if (!ts_node_is_null(body)) {
                uint32_t bnc = ts_node_named_child_count(body);
                for (uint32_t bi = 0; bi < bnc; bi++) {
                    TSNode stmt = ts_node_named_child(body, bi);
                    if (ts_node_is_null(stmt)) continue;
                    const char* sk = ts_node_type(stmt);
                    // Skip nested lambdas, loops, etc. — only immediate returns
                    if (strcmp(sk, "return_statement") == 0) {
                        if (ts_node_named_child_count(stmt) > 0) {
                            TSNode ret_expr = ts_node_named_child(stmt, 0);
                            ret_type = c_eval_expr_type(ctx, ret_expr);
                        }
                        break; // first return only
                    }
                }
            }
        }

        if (ret_type && !cbm_type_is_unknown(ret_type)) {
            const CBMType** ret_types = (const CBMType**)cbm_arena_alloc(ctx->arena, 2 * sizeof(const CBMType*));
            if (ret_types) {
                ret_types[0] = ret_type;
                ret_types[1] = NULL;
                return cbm_type_func(ctx->arena, NULL, NULL, ret_types);
            }
        }
        return cbm_type_func(ctx->arena, NULL, NULL, NULL);
    }

    // --- Literals ---
    if (strcmp(kind, "number_literal") == 0) {
        char* text = c_node_text(ctx, node);
        if (text) {
            // Check for float suffix or decimal point
            for (const char* p = text; *p; p++) {
                if (*p == '.' || *p == 'f' || *p == 'F' || *p == 'e' || *p == 'E')
                    return cbm_type_builtin(ctx->arena, "double");
            }
        }
        return cbm_type_builtin(ctx->arena, "int");
    }
    if (strcmp(kind, "string_literal") == 0 || strcmp(kind, "concatenated_string") == 0 ||
        strcmp(kind, "raw_string_literal") == 0) {
        // C and C++ string literals are const char*, not std::string
        // (std::string requires explicit construction or "hello"s suffix)
        return cbm_type_pointer(ctx->arena, cbm_type_builtin(ctx->arena, "char"));
    }
    if (strcmp(kind, "char_literal") == 0) {
        return cbm_type_builtin(ctx->arena, "char");
    }
    if (strcmp(kind, "true") == 0 || strcmp(kind, "false") == 0) {
        return cbm_type_builtin(ctx->arena, "bool");
    }
    if (strcmp(kind, "null") == 0 || strcmp(kind, "nullptr") == 0) {
        return cbm_type_pointer(ctx->arena, cbm_type_unknown());
    }

    // --- compound_literal_expression: (Type){...} ---
    if (strcmp(kind, "compound_literal_expression") == 0) {
        TSNode type_node = ts_node_child_by_field_name(node, "type", 4);
        if (!ts_node_is_null(type_node)) return c_parse_type_node(ctx, type_node);
        return cbm_type_unknown();
    }

    // --- assignment_expression: a = b (returns LHS type) ---
    if (strcmp(kind, "assignment_expression") == 0) {
        TSNode left = ts_node_child_by_field_name(node, "left", 4);
        if (!ts_node_is_null(left)) return c_eval_expr_type(ctx, left);
        return cbm_type_unknown();
    }

    // --- initializer_list: {1, 2, 3} ---
    if (strcmp(kind, "initializer_list") == 0) {
        return cbm_type_unknown(); // context-dependent
    }

    return cbm_type_unknown();
}

// ============================================================================
// c_lookup_member: method/field lookup with base class traversal
// ============================================================================

const CBMRegisteredFunc* c_lookup_member(CLSPContext* ctx, const char* type_qn, const char* member_name) {
    if (!type_qn || !member_name) return NULL;

    // Direct method lookup
    const CBMRegisteredFunc* f = cbm_registry_lookup_method(ctx->registry, type_qn, member_name);
    if (f) return f;

    // Try module-prefixed QN (e.g., "std.vector" -> "test.std.vector")
    if (ctx->module_qn && !strchr(type_qn, '.')) {
        // Short name without dots — unlikely to need prefix
    } else if (ctx->module_qn) {
        const char* prefixed = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, type_qn);
        f = cbm_registry_lookup_method(ctx->registry, prefixed, member_name);
        if (f) return f;
    }

    // Check registered type for alias and base classes
    const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, type_qn);
    if (!rt && ctx->module_qn) {
        rt = cbm_registry_lookup_type(ctx->registry,
            cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, type_qn));
    }
    if (rt) {
        // Alias chain
        if (rt->alias_of) {
            f = c_lookup_member(ctx, rt->alias_of, member_name);
            if (f) return f;
        }

        // Base classes (embedded_types stores base class QNs)
        if (rt->embedded_types) {
            for (int i = 0; rt->embedded_types[i]; i++) {
                f = c_lookup_member(ctx, rt->embedded_types[i], member_name);
                if (f) return f;
            }
        }
    }

    return NULL;
}

// Field type lookup
static const CBMType* c_lookup_field_type(CLSPContext* ctx, const char* type_qn,
    const char* field_name, int depth) {
    if (!type_qn || !field_name || depth > 5) return NULL;

    const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, type_qn);
    if (!rt && ctx->module_qn) {
        rt = cbm_registry_lookup_type(ctx->registry,
            cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, type_qn));
    }
    if (!rt) return NULL;

    if (rt->alias_of) return c_lookup_field_type(ctx, rt->alias_of, field_name, depth + 1);

    if (rt->field_names) {
        for (int i = 0; rt->field_names[i]; i++) {
            if (strcmp(rt->field_names[i], field_name) == 0 && rt->field_types && rt->field_types[i])
                return rt->field_types[i];
        }
    }

    // Base classes
    if (rt->embedded_types) {
        for (int i = 0; rt->embedded_types[i]; i++) {
            const CBMType* f = c_lookup_field_type(ctx, rt->embedded_types[i], field_name, depth + 1);
            if (f) return f;
        }
    }
    return NULL;
}

// ============================================================================
// c_process_statement: bind variables from statements
// ============================================================================

// Parse a declaration to extract type and declarators
static const CBMType* c_parse_declaration_type(CLSPContext* ctx, TSNode decl_node) {
    // Look for type node in declaration children
    uint32_t nc = ts_node_named_child_count(decl_node);
    for (uint32_t i = 0; i < nc; i++) {
        TSNode child = ts_node_named_child(decl_node, i);
        const char* ck = ts_node_type(child);

        // Skip declarators
        if (strcmp(ck, "init_declarator") == 0 || strcmp(ck, "identifier") == 0 ||
            strcmp(ck, "pointer_declarator") == 0 || strcmp(ck, "reference_declarator") == 0 ||
            strcmp(ck, "array_declarator") == 0 || strcmp(ck, "function_declarator") == 0)
            continue;

        // Found a type node
        return c_parse_type_node(ctx, child);
    }
    return cbm_type_unknown();
}

void c_process_statement(CLSPContext* ctx, TSNode node) {
    if (ts_node_is_null(node)) return;
    const char* kind = ts_node_type(node);

    // declaration: Type var = expr; or Type var1, var2;
    if (strcmp(kind, "declaration") == 0) {
        const CBMType* base_type = c_parse_declaration_type(ctx, node);
        bool has_auto = false;

        // Check if type is auto/decltype
        uint32_t nc = ts_node_named_child_count(node);
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_named_child(node, i);
            const char* ck = ts_node_type(child);
            if (strcmp(ck, "placeholder_type_specifier") == 0 || strcmp(ck, "auto") == 0) {
                has_auto = true;
                break;
            }
            if (strcmp(ck, "decltype") == 0) {
                base_type = c_parse_type_node(ctx, child);
                break;
            }
        }

        // Process each declarator
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_named_child(node, i);
            const char* ck = ts_node_type(child);

            if (strcmp(ck, "init_declarator") == 0) {
                TSNode decl = ts_node_child_by_field_name(child, "declarator", 10);
                TSNode value = ts_node_child_by_field_name(child, "value", 5);

                const CBMType* var_type = base_type;

                // For auto, infer from initializer
                if (has_auto && !ts_node_is_null(value)) {
                    var_type = c_eval_expr_type(ctx, value);
                }

                // Get variable name from declarator
                if (!ts_node_is_null(decl)) {
                    const char* dk = ts_node_type(decl);
                    char* var_name = NULL;

                    if (strcmp(dk, "identifier") == 0) {
                        var_name = c_node_text(ctx, decl);
                    } else if (strcmp(dk, "pointer_declarator") == 0) {
                        // Count pointer depth and find identifier
                        int ptr_depth = 0;
                        TSNode inner = decl;
                        while (!ts_node_is_null(inner) &&
                               strcmp(ts_node_type(inner), "pointer_declarator") == 0) {
                            ptr_depth++;
                            uint32_t dnc = ts_node_named_child_count(inner);
                            inner = dnc > 0 ? ts_node_named_child(inner, dnc - 1) : (TSNode){0};
                        }
                        if (!ts_node_is_null(inner) && strcmp(ts_node_type(inner), "identifier") == 0)
                            var_name = c_node_text(ctx, inner);
                        for (int d = 0; d < ptr_depth; d++)
                            var_type = cbm_type_pointer(ctx->arena, var_type);
                    } else if (strcmp(dk, "reference_declarator") == 0) {
                        if (ts_node_named_child_count(decl) > 0) {
                            TSNode inner = ts_node_named_child(decl, 0);
                            if (strcmp(ts_node_type(inner), "identifier") == 0)
                                var_name = c_node_text(ctx, inner);
                        }
                        var_type = cbm_type_reference(ctx->arena, var_type);
                    } else if (strcmp(dk, "function_declarator") == 0) {
                        // Function pointer: int (*fp)(int) = &target_func;
                        // Walk into function_declarator → parenthesized_declarator → pointer_declarator → identifier
                        TSNode inner = ts_node_child_by_field_name(decl, "declarator", 10);
                        while (!ts_node_is_null(inner)) {
                            const char* ik = ts_node_type(inner);
                            if (strcmp(ik, "identifier") == 0) {
                                var_name = c_node_text(ctx, inner);
                                break;
                            } else if (strcmp(ik, "parenthesized_declarator") == 0 ||
                                       strcmp(ik, "pointer_declarator") == 0) {
                                // Walk deeper: get last named child
                                uint32_t nc = ts_node_named_child_count(inner);
                                inner = nc > 0 ? ts_node_named_child(inner, nc - 1) : (TSNode){0};
                            } else {
                                break;
                            }
                        }
                        // Mark as pointer type (function pointer decays to pointer)
                        var_type = cbm_type_pointer(ctx->arena, var_type);
                    } else if (strcmp(dk, "array_declarator") == 0) {
                        // Type var[N]; — extract name and wrap in slice
                        TSNode inner = ts_node_child_by_field_name(decl, "declarator", 10);
                        if (!ts_node_is_null(inner) && strcmp(ts_node_type(inner), "identifier") == 0) {
                            var_name = c_node_text(ctx, inner);
                        }
                        var_type = cbm_type_slice(ctx->arena, var_type);
                    } else if (strcmp(dk, "structured_binding_declarator") == 0) {
                        // auto [a, b] = expr;
                        // Try to decompose pair/tuple from initializer type
                        const CBMType* rhs_type = cbm_type_unknown();
                        if (!ts_node_is_null(value)) {
                            rhs_type = c_eval_expr_type(ctx, value);
                            rhs_type = c_simplify_type(ctx, rhs_type, false);
                        }
                        uint32_t bnc = ts_node_named_child_count(decl);
                        int binding_idx = 0;
                        for (uint32_t bi = 0; bi < bnc; bi++) {
                            TSNode bn = ts_node_named_child(decl, bi);
                            if (strcmp(ts_node_type(bn), "identifier") == 0) {
                                char* bname = c_node_text(ctx, bn);
                                if (!bname) continue;
                                const CBMType* elem_type = cbm_type_unknown();
                                // Decompose std::pair<T1,T2> → first=T1, second=T2
                                if (rhs_type && rhs_type->kind == CBM_TYPE_TEMPLATE &&
                                    rhs_type->data.template_type.template_args) {
                                    int nta = rhs_type->data.template_type.arg_count;
                                    if (binding_idx < nta) {
                                        elem_type = rhs_type->data.template_type.template_args[binding_idx];
                                    }
                                }
                                // Decompose struct fields
                                if (cbm_type_is_unknown(elem_type) && rhs_type) {
                                    const char* rhs_qn = type_to_qn(rhs_type);
                                    if (rhs_qn) {
                                        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, rhs_qn);
                                        if (rt && rt->field_types && rt->field_types[binding_idx]) {
                                            elem_type = rt->field_types[binding_idx];
                                        }
                                    }
                                }
                                cbm_scope_bind(ctx->current_scope, bname, elem_type);
                                binding_idx++;
                            }
                        }
                        continue;
                    }

                    if (var_name && var_name[0] && strcmp(var_name, "_") != 0) {
                        cbm_scope_bind(ctx->current_scope, var_name, var_type);

                        // Track function pointer targets: fp = &foo or fp = foo
                        // Accept any pointer or func type — C function pointer declarators
                        // like int (*fp)(int) often parse as pointer(int), not pointer(FUNC).
                        if (var_type && (var_type->kind == CBM_TYPE_FUNC ||
                            var_type->kind == CBM_TYPE_POINTER)) {
                            if (!ts_node_is_null(value)) {
                                const char* vk = ts_node_type(value);
                                // pointer_expression with & operator: &foo
                                if (strcmp(vk, "pointer_expression") == 0 ||
                                    strcmp(vk, "unary_expression") == 0) {
                                    uint32_t vnc = ts_node_named_child_count(value);
                                    for (uint32_t vi = 0; vi < vnc; vi++) {
                                        TSNode vch = ts_node_named_child(value, vi);
                                        if (strcmp(ts_node_type(vch), "identifier") == 0) {
                                            char* target_name = c_node_text(ctx, vch);
                                            if (target_name) {
                                                const char* target_qn = c_resolve_name_to_func_qn(ctx, target_name);
                                                if (target_qn) {
                                                    c_add_fp_target(ctx, var_name, target_qn);
                                                }
                                            }
                                            break;
                                        }
                                    }
                                }
                                // Direct identifier: fp = foo (function decays to pointer)
                                else if (strcmp(vk, "identifier") == 0) {
                                    char* target_name = c_node_text(ctx, value);
                                    if (target_name) {
                                        const char* target_qn = c_resolve_name_to_func_qn(ctx, target_name);
                                        if (target_qn) {
                                            c_add_fp_target(ctx, var_name, target_qn);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } else if (strcmp(ck, "identifier") == 0) {
                // Bare declaration without initializer: Type var;
                char* var_name = c_node_text(ctx, child);
                if (var_name && var_name[0]) {
                    cbm_scope_bind(ctx->current_scope, var_name, base_type);
                }
            } else if (strcmp(ck, "pointer_declarator") == 0) {
                // Type *var; without initializer
                int ptr_depth = 0;
                TSNode inner = child;
                while (!ts_node_is_null(inner) &&
                       strcmp(ts_node_type(inner), "pointer_declarator") == 0) {
                    ptr_depth++;
                    uint32_t dnc = ts_node_named_child_count(inner);
                    inner = dnc > 0 ? ts_node_named_child(inner, dnc - 1) : (TSNode){0};
                }
                if (!ts_node_is_null(inner) && strcmp(ts_node_type(inner), "identifier") == 0) {
                    char* var_name = c_node_text(ctx, inner);
                    if (var_name) {
                        const CBMType* vt = base_type;
                        for (int d = 0; d < ptr_depth; d++)
                            vt = cbm_type_pointer(ctx->arena, vt);
                        cbm_scope_bind(ctx->current_scope, var_name, vt);
                    }
                }
            }
        }
        return;
    }

    // using_declaration: using namespace std; or using std::cout;
    if (strcmp(kind, "using_declaration") == 0) {
        char* text = c_node_text(ctx, node);
        if (!text) return;

        // "using namespace XXX;"
        if (strstr(text, "namespace")) {
            // Extract namespace name after "namespace"
            uint32_t nc = ts_node_named_child_count(node);
            for (uint32_t i = 0; i < nc; i++) {
                TSNode child = ts_node_named_child(node, i);
                const char* ck = ts_node_type(child);
                if (strcmp(ck, "identifier") == 0 || strcmp(ck, "qualified_identifier") == 0 ||
                    strcmp(ck, "scoped_identifier") == 0) {
                    char* ns_name = c_node_text(ctx, child);
                    if (ns_name) c_add_using_namespace(ctx, c_build_qn(ctx, ns_name));
                }
            }
        } else if (strstr(text, "enum")) {
            // "using enum MyEnum;" — import enum members into scope
            uint32_t nc = ts_node_named_child_count(node);
            for (uint32_t i = 0; i < nc; i++) {
                TSNode child = ts_node_named_child(node, i);
                const char* ck = ts_node_type(child);
                if (strcmp(ck, "identifier") == 0 || strcmp(ck, "qualified_identifier") == 0 ||
                    strcmp(ck, "scoped_identifier") == 0 || strcmp(ck, "type_identifier") == 0) {
                    char* enum_text = c_node_text(ctx, child);
                    if (enum_text) {
                        const char* enum_qn = c_build_qn(ctx, enum_text);
                        // Try to find the enum type in registry, import its members
                        const CBMRegisteredType* et = cbm_registry_lookup_type(ctx->registry, enum_qn);
                        if (!et && ctx->module_qn) {
                            enum_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, enum_qn);
                            et = cbm_registry_lookup_type(ctx->registry, enum_qn);
                        }
                        if (!et && ctx->current_namespace) {
                            enum_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->current_namespace, enum_text);
                            et = cbm_registry_lookup_type(ctx->registry, enum_qn);
                        }
                        // Even if enum type not found, add as using namespace for name lookup
                        c_add_using_namespace(ctx, enum_qn);
                    }
                }
            }
        } else {
            // "using std::cout;" — specific declaration
            uint32_t nc = ts_node_named_child_count(node);
            for (uint32_t i = 0; i < nc; i++) {
                TSNode child = ts_node_named_child(node, i);
                const char* ck = ts_node_type(child);
                if (strcmp(ck, "qualified_identifier") == 0 || strcmp(ck, "scoped_identifier") == 0) {
                    char* full_text = c_node_text(ctx, child);
                    if (full_text) {
                        const char* qn = c_build_qn(ctx, full_text);
                        // Extract short name (last component)
                        const char* short_name = strrchr(qn, '.');
                        short_name = short_name ? short_name + 1 : qn;
                        c_add_using_decl(ctx, short_name, qn);
                    }
                }
            }
        }
        return;
    }

    // alias_declaration: using Foo = Bar;
    if (strcmp(kind, "alias_declaration") == 0) {
        TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
        TSNode type_node = ts_node_child_by_field_name(node, "type", 4);
        if (!ts_node_is_null(name_node) && !ts_node_is_null(type_node)) {
            char* alias_name = c_node_text(ctx, name_node);
            const CBMType* target = c_parse_type_node(ctx, type_node);
            if (alias_name && target) {
                // Build alias QN
                const char* alias_qn = ctx->current_namespace ?
                    cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->current_namespace, alias_name) :
                    cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, alias_name);
                cbm_scope_bind(ctx->current_scope, alias_name,
                    cbm_type_alias(ctx->arena, alias_qn, target));
            }
        }
        return;
    }

    // type_definition: typedef Bar Foo;
    if (strcmp(kind, "type_definition") == 0) {
        // Get the type being aliased
        const CBMType* target = cbm_type_unknown();
        uint32_t nc = ts_node_named_child_count(node);
        bool found_type = false;
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_named_child(node, i);
            const char* ck = ts_node_type(child);
            if (!found_type && strcmp(ck, "type_identifier") != 0 &&
                strcmp(ck, "pointer_declarator") != 0 &&
                strcmp(ck, "identifier") != 0) {
                target = c_parse_type_node(ctx, child);
                found_type = true;
            } else if (found_type && strcmp(ck, "type_identifier") == 0) {
                char* alias_name = c_node_text(ctx, child);
                if (alias_name) {
                    const char* alias_qn = ctx->current_namespace ?
                        cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->current_namespace, alias_name) :
                        cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, alias_name);
                    cbm_scope_bind(ctx->current_scope, alias_name,
                        cbm_type_alias(ctx->arena, alias_qn, target));
                }
            }
        }
        return;
    }

    // namespace_alias_definition: namespace fs = std::filesystem;
    if (strcmp(kind, "namespace_alias_definition") == 0) {
        TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
        TSNode value_node = ts_node_child_by_field_name(node, "value", 5);
        if (ts_node_is_null(value_node)) {
            // Try last named child
            uint32_t nc = ts_node_named_child_count(node);
            if (nc >= 2) {
                name_node = ts_node_named_child(node, 0);
                value_node = ts_node_named_child(node, nc - 1);
            }
        }
        if (!ts_node_is_null(name_node) && !ts_node_is_null(value_node)) {
            char* alias = c_node_text(ctx, name_node);
            char* target = c_node_text(ctx, value_node);
            if (alias && target) {
                c_add_ns_alias(ctx, alias, c_build_qn(ctx, target));
            }
        }
        return;
    }

    // for_range_loop: for (auto& x : container) { ... }
    if (strcmp(kind, "for_range_loop") == 0) {
        TSNode decl = ts_node_child_by_field_name(node, "declarator", 10);
        TSNode type_node = ts_node_child_by_field_name(node, "type", 4);
        TSNode right = ts_node_child_by_field_name(node, "right", 5);

        const CBMType* elem_type = cbm_type_unknown();
        if (!ts_node_is_null(right)) {
            const CBMType* container_type = c_eval_expr_type(ctx, right);
            // Deduce element type: container's begin()->operator* or element type
            if (container_type) {
                if (container_type->kind == CBM_TYPE_SLICE) {
                    elem_type = container_type->data.slice.elem;
                } else if (container_type->kind == CBM_TYPE_TEMPLATE &&
                           container_type->data.template_type.arg_count > 0) {
                    // Map containers: element is pair<K,V> not just K
                    const char* tname = container_type->data.template_type.template_name;
                    if (tname && container_type->data.template_type.arg_count >= 2 &&
                        (strstr(tname, "map") || strstr(tname, "Map"))) {
                        const CBMType* pair_args[3];
                        pair_args[0] = container_type->data.template_type.template_args[0];
                        pair_args[1] = container_type->data.template_type.template_args[1];
                        pair_args[2] = NULL;
                        elem_type = cbm_type_template(ctx->arena, "std.pair",
                            pair_args, 2);
                    } else {
                        elem_type = container_type->data.template_type.template_args[0];
                    }
                }
                // Iterator protocol fallback: begin() -> iter -> operator*() -> elem
                if (cbm_type_is_unknown(elem_type) && container_type->kind == CBM_TYPE_NAMED) {
                    const char* cqn = container_type->data.named.qualified_name;
                    const CBMRegisteredFunc* begin_fn = c_lookup_member(ctx, cqn, "begin");
                    if (begin_fn && begin_fn->signature &&
                        begin_fn->signature->kind == CBM_TYPE_FUNC &&
                        begin_fn->signature->data.func.return_types &&
                        begin_fn->signature->data.func.return_types[0]) {
                        const CBMType* iter_type = begin_fn->signature->data.func.return_types[0];
                        const char* iter_qn = type_to_qn(iter_type);
                        if (iter_qn) {
                            const CBMRegisteredFunc* deref = c_lookup_member(ctx, iter_qn, "operator*");
                            if (deref && deref->signature &&
                                deref->signature->kind == CBM_TYPE_FUNC &&
                                deref->signature->data.func.return_types &&
                                deref->signature->data.func.return_types[0]) {
                                elem_type = deref->signature->data.func.return_types[0];
                            }
                        }
                    }
                }
            }
        }

        // If explicit type, use that
        if (!ts_node_is_null(type_node)) {
            const char* tk = ts_node_type(type_node);
            if (strcmp(tk, "placeholder_type_specifier") != 0 && strcmp(tk, "auto") != 0) {
                elem_type = c_parse_type_node(ctx, type_node);
            }
        }

        // Bind declarator
        if (!ts_node_is_null(decl)) {
            const char* dk = ts_node_type(decl);
            if (strcmp(dk, "identifier") == 0) {
                char* var_name = c_node_text(ctx, decl);
                if (var_name) cbm_scope_bind(ctx->current_scope, var_name, elem_type);
            } else if (strcmp(dk, "reference_declarator") == 0) {
                if (ts_node_named_child_count(decl) > 0) {
                    TSNode inner = ts_node_named_child(decl, 0);
                    if (strcmp(ts_node_type(inner), "identifier") == 0) {
                        char* var_name = c_node_text(ctx, inner);
                        if (var_name) cbm_scope_bind(ctx->current_scope, var_name, elem_type);
                    }
                }
            }
        }
        return;
    }

    // parameter_declaration: bind param
    if (strcmp(kind, "parameter_declaration") == 0) {
        TSNode type_node = ts_node_child_by_field_name(node, "type", 4);
        TSNode decl = ts_node_child_by_field_name(node, "declarator", 10);
        if (ts_node_is_null(type_node)) return;

        const CBMType* param_type = c_parse_type_node(ctx, type_node);

        if (!ts_node_is_null(decl)) {
            const char* dk = ts_node_type(decl);
            if (strcmp(dk, "identifier") == 0) {
                char* name = c_node_text(ctx, decl);
                if (name) cbm_scope_bind(ctx->current_scope, name, param_type);
            } else if (strcmp(dk, "pointer_declarator") == 0) {
                int ptr_depth = 0;
                TSNode inner = decl;
                while (!ts_node_is_null(inner) && strcmp(ts_node_type(inner), "pointer_declarator") == 0) {
                    ptr_depth++;
                    uint32_t dnc = ts_node_named_child_count(inner);
                    inner = dnc > 0 ? ts_node_named_child(inner, dnc - 1) : (TSNode){0};
                }
                if (!ts_node_is_null(inner) && strcmp(ts_node_type(inner), "identifier") == 0) {
                    char* name = c_node_text(ctx, inner);
                    if (name) {
                        const CBMType* vt = param_type;
                        for (int d = 0; d < ptr_depth; d++) vt = cbm_type_pointer(ctx->arena, vt);
                        cbm_scope_bind(ctx->current_scope, name, vt);
                    }
                }
            } else if (strcmp(dk, "reference_declarator") == 0) {
                if (ts_node_named_child_count(decl) > 0) {
                    TSNode inner = ts_node_named_child(decl, 0);
                    if (strcmp(ts_node_type(inner), "identifier") == 0) {
                        char* name = c_node_text(ctx, inner);
                        if (name) cbm_scope_bind(ctx->current_scope, name,
                            cbm_type_reference(ctx->arena, param_type));
                    }
                }
            }
        }
        return;
    }
}

// ============================================================================
// Emit helpers
// ============================================================================

static void c_emit_resolved_call(CLSPContext* ctx, const char* callee_qn, const char* strategy, float confidence) {
    if (!ctx->resolved_calls || !callee_qn || !ctx->enclosing_func_qn) return;
    CBMResolvedCall rc;
    rc.caller_qn = ctx->enclosing_func_qn;
    rc.callee_qn = callee_qn;
    rc.strategy = strategy;
    rc.confidence = confidence;
    rc.reason = NULL;
    cbm_resolvedcall_push(ctx->resolved_calls, ctx->arena, rc);
}

static void c_emit_unresolved_call(CLSPContext* ctx, const char* expr_text, const char* reason) {
    if (!ctx->resolved_calls || !ctx->enclosing_func_qn) return;
    CBMResolvedCall rc;
    rc.caller_qn = ctx->enclosing_func_qn;
    rc.callee_qn = expr_text ? expr_text : "?";
    rc.strategy = "lsp_unresolved";
    rc.confidence = 0.0f;
    rc.reason = reason;
    cbm_resolvedcall_push(ctx->resolved_calls, ctx->arena, rc);
}

// ============================================================================
// resolve_calls_in_node: walk AST and resolve calls
// ============================================================================

static void c_resolve_calls_in_node(CLSPContext* ctx, TSNode node) {
    if (ts_node_is_null(node)) return;
    const char* kind = ts_node_type(node);

    // Process statements for scope building
    c_process_statement(ctx, node);

    // --- Resolve call expressions ---
    if (strcmp(kind, "call_expression") == 0) {
        TSNode func_node = ts_node_child_by_field_name(node, "function", 8);
        if (!ts_node_is_null(func_node)) {
            const char* fk = ts_node_type(func_node);

            // field_expression: obj.method() or ptr->method()
            if (strcmp(fk, "field_expression") == 0) {
                TSNode arg_node = ts_node_child_by_field_name(func_node, "argument", 8);
                TSNode field_node = ts_node_child_by_field_name(func_node, "field", 5);
                if (!ts_node_is_null(arg_node) && !ts_node_is_null(field_node)) {
                    char* field_name = c_node_text(ctx, field_node);
                    if (field_name) {
                        const CBMType* obj_type = c_eval_expr_type(ctx, arg_node);

                        // Determine if arrow or dot
                        bool is_arrow = false;
                        uint32_t fnc = ts_node_child_count(func_node);
                        for (uint32_t fi = 0; fi < fnc; fi++) {
                            TSNode ch = ts_node_child(func_node, fi);
                            if (!ts_node_is_named(ch)) {
                                char* op = c_node_text(ctx, ch);
                                if (op && strcmp(op, "->") == 0) { is_arrow = true; break; }
                            }
                        }

                        const CBMType* base = is_arrow ?
                            c_simplify_type(ctx, obj_type, true) :
                            c_simplify_type(ctx, obj_type, false);

                        const char* type_qn = type_to_qn(base);
                        if (type_qn) {
                            int arg_count = 0;
                            const CBMType** arg_types = c_extract_call_arg_types(ctx, node, &arg_count);
                            if (ctx->debug) fprintf(stderr, "  [clsp] member call: type_qn=%s field=%s args=%d\n", type_qn, field_name, arg_count);
                            // Use type-aware overload scoring
                            const CBMRegisteredFunc* method = cbm_registry_lookup_method_by_types(
                                ctx->registry, type_qn, field_name, arg_types, arg_count);
                            // Fall back to c_lookup_member for base class traversal
                            if (!method) method = c_lookup_member(ctx, type_qn, field_name);
                            if (ctx->debug) fprintf(stderr, "  [clsp] member call result: %s\n", method ? method->qualified_name : "NULL");
                            if (method) {
                                const char* strategy = "lsp_type_dispatch";
                                // Check if resolved through base class — prefer derived override
                                if (method->receiver_type && strcmp(method->receiver_type, type_qn) != 0) {
                                    const CBMRegisteredFunc* override_m = cbm_registry_lookup_method(
                                        ctx->registry, type_qn, field_name);
                                    if (override_m) {
                                        method = override_m;
                                        strategy = "lsp_virtual_dispatch";
                                    } else {
                                        strategy = "lsp_base_dispatch";
                                    }
                                }
                                // Check if through smart pointer
                                if (is_arrow && obj_type->kind == CBM_TYPE_TEMPLATE &&
                                    is_smart_ptr(obj_type->data.template_type.template_name))
                                    strategy = "lsp_smart_ptr_dispatch";
                                c_emit_resolved_call(ctx, method->qualified_name, strategy, 0.95f);
                                goto recurse;
                            }
                        }

                        // TYPE_PARAM receiver: store as pending template call
                        if (base && base->kind == CBM_TYPE_TYPE_PARAM &&
                            ctx->enclosing_func_qn && ctx->in_template) {
                            int ac = 0;
                            c_extract_call_arg_types(ctx, node, &ac);
                            c_add_pending_template_call(ctx,
                                ctx->enclosing_func_qn,
                                base->data.type_param.name,
                                field_name, ac);
                        }

                        // Unresolved
                        if (cbm_type_is_unknown(obj_type)) {
                            char* arg_text = c_node_text(ctx, arg_node);
                            c_emit_unresolved_call(ctx,
                                cbm_arena_sprintf(ctx->arena, "%s.%s",
                                    arg_text ? arg_text : "?", field_name),
                                "unknown_receiver_type");
                        } else if (type_qn) {
                            c_emit_unresolved_call(ctx,
                                cbm_arena_sprintf(ctx->arena, "%s.%s", type_qn, field_name),
                                "method_not_found");
                        }
                    }
                }
                goto recurse;
            }

            // qualified_identifier: ns::func() or Class::static_method()
            if (strcmp(fk, "qualified_identifier") == 0 ||
                strcmp(fk, "scoped_identifier") == 0) {
                char* text = c_node_text(ctx, func_node);
                if (text) {
                    const char* qn = c_build_qn(ctx, text);
                    int arg_count = 0;
                    const CBMType** arg_types = c_extract_call_arg_types(ctx, node, &arg_count);
                    const CBMRegisteredFunc* f = cbm_registry_lookup_func(ctx->registry, qn);
                    if (!f && ctx->module_qn) {
                        const char* mod_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, qn);
                        f = cbm_registry_lookup_func(ctx->registry, mod_qn);
                    }
                    if (f) {
                        c_emit_resolved_call(ctx, f->qualified_name, "lsp_scoped", 0.95f);
                        goto recurse;
                    }
                    // Try as method (Class::method) with type-aware overload resolution
                    const char* dot = strrchr(qn, '.');
                    if (dot) {
                        size_t prefix_len = dot - qn;
                        char* class_qn = (char*)cbm_arena_alloc(ctx->arena, prefix_len + 1);
                        memcpy(class_qn, qn, prefix_len);
                        class_qn[prefix_len] = '\0';
                        const CBMRegisteredFunc* m = cbm_registry_lookup_method_by_types(
                            ctx->registry, class_qn, dot + 1, arg_types, arg_count);
                        // Try with module prefix
                        if (!m && ctx->module_qn) {
                            const char* mod_class = cbm_arena_sprintf(ctx->arena, "%s.%s",
                                ctx->module_qn, class_qn);
                            m = cbm_registry_lookup_method_by_types(
                                ctx->registry, mod_class, dot + 1, arg_types, arg_count);
                        }
                        if (m) {
                            c_emit_resolved_call(ctx, m->qualified_name, "lsp_scoped", 0.95f);
                            goto recurse;
                        }
                    }
                    c_emit_unresolved_call(ctx, qn, "scoped_not_in_registry");
                }
                goto recurse;
            }

            // template_function: func<T>(args) or ns::func<T>(args)
            if (strcmp(fk, "template_function") == 0) {
                TSNode name_node = ts_node_child_by_field_name(func_node, "name", 4);
                if (!ts_node_is_null(name_node)) {
                    char* name = c_node_text(ctx, name_node);
                    if (name) {
                        const char* nk = ts_node_type(name_node);
                        const CBMRegisteredFunc* f = NULL;
                        if (strcmp(nk, "qualified_identifier") == 0 ||
                            strcmp(nk, "scoped_identifier") == 0) {
                            const char* qn = c_build_qn(ctx, name);
                            f = cbm_registry_lookup_func(ctx->registry, qn);
                            if (!f && ctx->module_qn) {
                                const char* mod_qn = cbm_arena_sprintf(ctx->arena, "%s.%s",
                                    ctx->module_qn, qn);
                                f = cbm_registry_lookup_func(ctx->registry, mod_qn);
                            }
                            // Try as Class::method
                            if (!f) {
                                const char* dot = strrchr(qn, '.');
                                if (dot) {
                                    size_t plen = dot - qn;
                                    char* cls = (char*)cbm_arena_alloc(ctx->arena, plen + 1);
                                    memcpy(cls, qn, plen);
                                    cls[plen] = '\0';
                                    const CBMRegisteredFunc* m = cbm_registry_lookup_method(
                                        ctx->registry, cls, dot + 1);
                                    if (!m && ctx->module_qn) {
                                        const char* mc = cbm_arena_sprintf(ctx->arena, "%s.%s",
                                            ctx->module_qn, cls);
                                        m = cbm_registry_lookup_method(ctx->registry, mc, dot + 1);
                                    }
                                    if (m) f = m;
                                }
                            }
                        } else {
                            const char* fqn = c_resolve_name(ctx, name);
                            if (fqn) f = cbm_registry_lookup_func(ctx->registry, fqn);
                        }
                        if (f) {
                            c_emit_resolved_call(ctx, f->qualified_name, "lsp_template", 0.95f);
                            // Resolve pending template calls at this call site
                            if (ctx->pending_tc_count > 0 && f->type_param_names) {
                                int ac = 0;
                                const CBMType** at = c_extract_call_arg_types(ctx, node, &ac);
                                if (at) c_resolve_pending_template_calls(ctx, f, at, ac);
                            }
                        } else {
                            c_emit_unresolved_call(ctx, c_build_qn(ctx, name), "template_not_in_registry");
                        }
                    }
                }
                goto recurse;
            }

            // Direct identifier call: func()
            if (strcmp(fk, "identifier") == 0) {
                char* name = c_node_text(ctx, func_node);
                if (name && !is_c_builtin_func(name)) {
                    // Check function pointer target map FIRST (before scope type check)
                    // because C function pointer declarators like int (*fp)(int)
                    // parse as pointer(int) in scope, not as FUNC type.
                    const char* fp_target = c_lookup_fp_target(ctx, name);
                    if (fp_target) {
                        c_emit_resolved_call(ctx, fp_target, "lsp_func_ptr", 0.85f);
                        goto recurse;
                    }

                    // Check if it's a variable with callable type
                    const CBMType* var_type = cbm_scope_lookup(ctx->current_scope, name);
                    if (!cbm_type_is_unknown(var_type)) {
                        if (var_type->kind == CBM_TYPE_FUNC) {
                            // Function type variable without tracked target — can't resolve
                            goto recurse;
                        }
                        // Functor call: variable with operator()
                        const CBMType* base = c_simplify_type(ctx, var_type, false);
                        const char* type_qn = type_to_qn(base);
                        if (type_qn) {
                            const CBMRegisteredFunc* op = c_lookup_member(ctx, type_qn, "operator()");
                            if (op) {
                                c_emit_resolved_call(ctx, op->qualified_name, "lsp_operator", 0.90f);
                                goto recurse;
                            }
                        }
                    }

                    // Check if it's a type name (constructor call)
                    const CBMType* type = c_resolve_name_to_type(ctx, name);
                    if (type && type->kind == CBM_TYPE_NAMED) {
                        const char* type_qn_str = type->data.named.qualified_name;
                        const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, type_qn_str);
                        if (rt && !rt->is_interface) {
                            // Constructor call
                            const char* ctor_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", type_qn_str, name);
                            c_emit_resolved_call(ctx, ctor_qn, "lsp_constructor", 0.95f);
                            goto recurse;
                        }
                    }

                    // Regular function call
                    const char* fqn = c_resolve_name(ctx, name);
                    if (fqn) {
                        // Check if this is implicit 'this' call
                        const char* strategy = "lsp_direct";
                        if (ctx->enclosing_class_qn) {
                            const CBMRegisteredFunc* m = cbm_registry_lookup_method(ctx->registry,
                                ctx->enclosing_class_qn, name);
                            if (m && strcmp(fqn, m->qualified_name) == 0) {
                                strategy = "lsp_implicit_this";
                            }
                        }
                        c_emit_resolved_call(ctx, fqn, strategy, 0.95f);
                        // Resolve pending template calls at this call site
                        if (ctx->pending_tc_count > 0) {
                            const CBMRegisteredFunc* called = cbm_registry_lookup_func(ctx->registry, fqn);
                            if (called && called->type_param_names) {
                                int ac = 0;
                                const CBMType** at = c_extract_call_arg_types(ctx, node, &ac);
                                if (at) c_resolve_pending_template_calls(ctx, called, at, ac);
                            }
                        }
                    } else {
                        // ADL: search namespaces of argument types
                        const char* adl_qn = c_adl_resolve(ctx, name, node);
                        if (adl_qn) {
                            c_emit_resolved_call(ctx, adl_qn, "lsp_adl", 0.90f);
                        } else {
                            c_emit_unresolved_call(ctx, name, "function_not_in_registry");
                        }
                    }
                }
                goto recurse;
            }
        }
    }

    // --- Constructor calls from declarations ---
    if (strcmp(kind, "declaration") == 0 && ctx->cpp_mode) {
        // Check for Foo x(args) or Foo x{args} patterns
        uint32_t nc = ts_node_named_child_count(node);
        const CBMType* decl_type = cbm_type_unknown();
        bool has_type = false;
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_named_child(node, i);
            const char* ck = ts_node_type(child);
            if (!has_type && (strcmp(ck, "type_identifier") == 0 ||
                              strcmp(ck, "scoped_type_identifier") == 0 ||
                              strcmp(ck, "template_type") == 0)) {
                decl_type = c_parse_type_node(ctx, child);
                has_type = true;
            }
            if (has_type && strcmp(ck, "init_declarator") == 0) {
                // Check if value is argument_list (constructor with parens)
                TSNode value = ts_node_child_by_field_name(child, "value", 5);
                if (!ts_node_is_null(value)) {
                    const char* vk = ts_node_type(value);
                    if (strcmp(vk, "argument_list") == 0 || strcmp(vk, "initializer_list") == 0) {
                        const char* type_qn = type_to_qn(decl_type);
                        if (type_qn) {
                            const char* short_name = strrchr(type_qn, '.');
                            short_name = short_name ? short_name + 1 : type_qn;
                            const char* last_colon = strrchr(type_qn, ':');
                            if (last_colon) short_name = last_colon + 1;
                            const char* ctor_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", type_qn, short_name);
                            c_emit_resolved_call(ctx, ctor_qn, "lsp_constructor", 0.90f);
                        }
                    }
                }
            }
        }
    }

    // --- new_expression: emit constructor ---
    if (strcmp(kind, "new_expression") == 0) {
        TSNode type_node = ts_node_child_by_field_name(node, "type", 4);
        if (ts_node_is_null(type_node)) {
            uint32_t nc = ts_node_named_child_count(node);
            for (uint32_t i = 0; i < nc; i++) {
                TSNode child = ts_node_named_child(node, i);
                const char* ck = ts_node_type(child);
                if (strcmp(ck, "type_identifier") == 0 || strcmp(ck, "template_type") == 0 ||
                    strcmp(ck, "scoped_type_identifier") == 0) {
                    type_node = child;
                    break;
                }
            }
        }
        if (!ts_node_is_null(type_node)) {
            const CBMType* t = c_parse_type_node(ctx, type_node);
            const char* type_qn = type_to_qn(t);
            if (type_qn) {
                const char* short_name = strrchr(type_qn, '.');
                short_name = short_name ? short_name + 1 : type_qn;
                const char* ctor_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", type_qn, short_name);
                c_emit_resolved_call(ctx, ctor_qn, "lsp_constructor", 0.95f);
            }
        }
    }

    // --- delete_expression: emit destructor ---
    if (strcmp(kind, "delete_expression") == 0 && ctx->cpp_mode) {
        TSNode operand = ts_node_child_by_field_name(node, "argument", 8);
        if (ts_node_is_null(operand)) {
            if (ts_node_named_child_count(node) > 0)
                operand = ts_node_named_child(node, 0);
        }
        if (!ts_node_is_null(operand)) {
            const CBMType* ptr_type = c_eval_expr_type(ctx, operand);
            const CBMType* base = c_simplify_type(ctx, ptr_type, true);
            const char* type_qn = type_to_qn(base);
            if (type_qn) {
                const char* short_name = strrchr(type_qn, '.');
                short_name = short_name ? short_name + 1 : type_qn;
                const char* dtor_qn = cbm_arena_sprintf(ctx->arena, "%s.~%s", type_qn, short_name);
                c_emit_resolved_call(ctx, dtor_qn, "lsp_destructor", 0.90f);
            }
        }
    }

    // --- Operator calls (C++ only) ---
    if (ctx->cpp_mode && strcmp(kind, "binary_expression") == 0) {
        TSNode left = ts_node_child_by_field_name(node, "left", 4);
        if (!ts_node_is_null(left)) {
            const CBMType* lhs_type = c_eval_expr_type(ctx, left);
            const CBMType* base = c_simplify_type(ctx, lhs_type, false);
            if (base && base->kind != CBM_TYPE_BUILTIN && !cbm_type_is_unknown(base)) {
                const char* type_qn = type_to_qn(base);
                if (type_qn) {
                    // Extract operator
                    for (uint32_t i = 0; i < ts_node_child_count(node); i++) {
                        TSNode child = ts_node_child(node, i);
                        if (!ts_node_is_named(child)) {
                            char* op = c_node_text(ctx, child);
                            if (op) {
                                const char* op_name = cbm_arena_sprintf(ctx->arena, "operator%s", op);
                                const CBMRegisteredFunc* m = c_lookup_member(ctx, type_qn, op_name);
                                if (m) {
                                    c_emit_resolved_call(ctx, m->qualified_name, "lsp_operator", 0.90f);
                                }
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    // --- subscript_expression operator[] ---
    if (ctx->cpp_mode && strcmp(kind, "subscript_expression") == 0) {
        TSNode arg_node = ts_node_child_by_field_name(node, "argument", 8);
        if (!ts_node_is_null(arg_node)) {
            const CBMType* arr_type = c_eval_expr_type(ctx, arg_node);
            const CBMType* base = c_simplify_type(ctx, arr_type, false);
            if (base && base->kind != CBM_TYPE_BUILTIN && !cbm_type_is_unknown(base) &&
                base->kind != CBM_TYPE_POINTER && base->kind != CBM_TYPE_SLICE) {
                const char* type_qn = type_to_qn(base);
                if (type_qn) {
                    const CBMRegisteredFunc* m = c_lookup_member(ctx, type_qn, "operator[]");
                    if (m) {
                        c_emit_resolved_call(ctx, m->qualified_name, "lsp_operator", 0.90f);
                    }
                }
            }
        }
    }

    // --- unary_expression/pointer_expression: operator* / operator++ / operator-- on custom types ---
    if (ctx->cpp_mode && (strcmp(kind, "unary_expression") == 0 ||
                          strcmp(kind, "pointer_expression") == 0 ||
                          strcmp(kind, "update_expression") == 0)) {
        TSNode operand = ts_node_child_by_field_name(node, "argument", 8);
        if (ts_node_is_null(operand))
            operand = ts_node_child_by_field_name(node, "operand", 7);
        if (!ts_node_is_null(operand)) {
            const CBMType* op_type = c_eval_expr_type(ctx, operand);
            const CBMType* base = c_simplify_type(ctx, op_type, false);
            if (base && base->kind != CBM_TYPE_BUILTIN && !cbm_type_is_unknown(base) &&
                base->kind != CBM_TYPE_POINTER) {
                const char* type_qn = type_to_qn(base);
                if (type_qn) {
                    // Determine which operator
                    const char* op_name = NULL;
                    for (uint32_t ui = 0; ui < ts_node_child_count(node); ui++) {
                        TSNode ch = ts_node_child(node, ui);
                        if (!ts_node_is_named(ch)) {
                            char* op = c_node_text(ctx, ch);
                            if (!op) continue;
                            if (strcmp(op, "*") == 0) op_name = "operator*";
                            else if (strcmp(op, "++") == 0) op_name = "operator++";
                            else if (strcmp(op, "--") == 0) op_name = "operator--";
                            else if (strcmp(op, "!") == 0) op_name = "operator!";
                            break;
                        }
                    }
                    if (op_name) {
                        const CBMRegisteredFunc* m = c_lookup_member(ctx, type_qn, op_name);
                        if (m) {
                            c_emit_resolved_call(ctx, m->qualified_name, "lsp_operator", 0.90f);
                        }
                    }
                }
            }
        }
    }

    // --- Copy/move constructor: Foo a = expr; where expr has Foo type ---
    if (ctx->cpp_mode && strcmp(kind, "declaration") == 0) {
        const CBMType* decl_type = c_parse_declaration_type(ctx, node);
        if (decl_type && decl_type->kind == CBM_TYPE_NAMED) {
            uint32_t dnc = ts_node_named_child_count(node);
            for (uint32_t di = 0; di < dnc; di++) {
                TSNode dchild = ts_node_named_child(node, di);
                if (strcmp(ts_node_type(dchild), "init_declarator") == 0) {
                    TSNode val = ts_node_child_by_field_name(dchild, "value", 5);
                    if (!ts_node_is_null(val)) {
                        const char* vk = ts_node_type(val);
                        // Skip if it's argument_list (already handled as constructor above)
                        // or initializer_list (also handled)
                        if (strcmp(vk, "argument_list") != 0 && strcmp(vk, "initializer_list") != 0) {
                            const CBMType* val_type = c_eval_expr_type(ctx, val);
                            const CBMType* val_base = c_simplify_type(ctx, val_type, false);
                            // If assigning an object of the same type -> copy/move constructor
                            const char* type_qn = type_to_qn(decl_type);
                            const char* val_qn = type_to_qn(val_base);
                            if (type_qn && val_qn && strcmp(type_qn, val_qn) == 0) {
                                const char* short_name = strrchr(type_qn, '.');
                                short_name = short_name ? short_name + 1 : type_qn;
                                const char* ctor_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", type_qn, short_name);
                                c_emit_resolved_call(ctx, ctor_qn, "lsp_copy_constructor", 0.85f);
                            }
                        }
                    }
                }
            }
        }
    }

    // --- Conversion operator: implicit bool/int conversion in conditions ---
    if (ctx->cpp_mode && (strcmp(kind, "if_statement") == 0 ||
                          strcmp(kind, "while_statement") == 0 ||
                          strcmp(kind, "do_statement") == 0)) {
        TSNode cond = ts_node_child_by_field_name(node, "condition", 9);
        if (!ts_node_is_null(cond)) {
            // If condition is a single expression of a custom type with operator bool
            const CBMType* cond_type = c_eval_expr_type(ctx, cond);
            const CBMType* base = c_simplify_type(ctx, cond_type, false);
            if (base && base->kind != CBM_TYPE_BUILTIN && !cbm_type_is_unknown(base) &&
                base->kind != CBM_TYPE_POINTER) {
                const char* type_qn = type_to_qn(base);
                if (type_qn) {
                    const CBMRegisteredFunc* m = c_lookup_member(ctx, type_qn, "operator bool");
                    if (m) {
                        c_emit_resolved_call(ctx, m->qualified_name, "lsp_conversion", 0.85f);
                    }
                }
            }
        }
    }

    // --- Designated initializer: {.field = value} ---
    if (strcmp(kind, "initializer_pair") == 0 || strcmp(kind, "field_designator") == 0) {
        // These appear inside initializer_list for aggregate init
        // We don't emit CALLS for field access, but we could track which struct is being initialized
        // This is primarily for completeness — no CALLS edge needed for field designators
    }

recurse:;
    // Push scope for blocks and control structures
    bool push_scope = (strcmp(kind, "compound_statement") == 0 ||
                       strcmp(kind, "if_statement") == 0 ||
                       strcmp(kind, "for_statement") == 0 ||
                       strcmp(kind, "for_range_loop") == 0 ||
                       strcmp(kind, "while_statement") == 0 ||
                       strcmp(kind, "do_statement") == 0 ||
                       strcmp(kind, "switch_statement") == 0 ||
                       strcmp(kind, "catch_clause") == 0);

    if (push_scope) {
        ctx->current_scope = cbm_scope_push(ctx->arena, ctx->current_scope);
    }

    // Process catch clause parameter
    if (strcmp(kind, "catch_clause") == 0) {
        TSNode params = ts_node_child_by_field_name(node, "parameters", 10);
        if (!ts_node_is_null(params)) {
            uint32_t pnc = ts_node_named_child_count(params);
            for (uint32_t pi = 0; pi < pnc; pi++) {
                c_process_statement(ctx, ts_node_named_child(params, pi));
            }
        }
    }

    // Recurse into children
    uint32_t nc = ts_node_child_count(node);
    for (uint32_t i = 0; i < nc; i++) {
        c_resolve_calls_in_node(ctx, ts_node_child(node, i));
    }

    if (push_scope) {
        ctx->current_scope = cbm_scope_pop(ctx->current_scope);
    }
}

// ============================================================================
// Process function: set enclosing QN, bind params, walk body
// ============================================================================

static void c_process_function(CLSPContext* ctx, TSNode func_node) {
    TSNode decl = ts_node_child_by_field_name(func_node, "declarator", 10);
    if (ts_node_is_null(decl)) return;

    // Extract function name from declarator chain
    char* func_name = NULL;
    const char* saved_class_qn = ctx->enclosing_class_qn;
    TSNode params_node = (TSNode){0};

    // Navigate declarator to find name and parameters
    TSNode cur = decl;
    for (int depth = 0; depth < 10 && !ts_node_is_null(cur); depth++) {
        const char* dk = ts_node_type(cur);

        if (strcmp(dk, "function_declarator") == 0) {
            TSNode fdecl = ts_node_child_by_field_name(cur, "declarator", 10);
            params_node = ts_node_child_by_field_name(cur, "parameters", 10);
            cur = fdecl;
            continue;
        }
        if (strcmp(dk, "pointer_declarator") == 0 || strcmp(dk, "reference_declarator") == 0) {
            if (ts_node_named_child_count(cur) > 0)
                cur = ts_node_named_child(cur, ts_node_named_child_count(cur) - 1);
            else break;
            continue;
        }
        if (strcmp(dk, "qualified_identifier") == 0 || strcmp(dk, "scoped_identifier") == 0) {
            func_name = c_node_text(ctx, cur);
            // Check if this is a method (has Class:: prefix)
            TSNode scope_node = ts_node_child_by_field_name(cur, "scope", 5);
            if (!ts_node_is_null(scope_node)) {
                char* scope_text = c_node_text(ctx, scope_node);
                if (scope_text) {
                    const char* scope_qn = c_build_qn(ctx, scope_text);
                    // Try as a type for enclosing class
                    const CBMRegisteredType* rt = cbm_registry_lookup_type(ctx->registry, scope_qn);
                    if (rt) {
                        ctx->enclosing_class_qn = scope_qn;
                    } else if (ctx->module_qn) {
                        const char* fqn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, scope_qn);
                        rt = cbm_registry_lookup_type(ctx->registry, fqn);
                        if (rt) ctx->enclosing_class_qn = fqn;
                    }
                }
            }
            break;
        }
        if (strcmp(dk, "identifier") == 0) {
            func_name = c_node_text(ctx, cur);
            break;
        }
        if (strcmp(dk, "field_identifier") == 0) {
            func_name = c_node_text(ctx, cur);
            break;
        }
        // Destructor
        if (strcmp(dk, "destructor_name") == 0) {
            func_name = c_node_text(ctx, cur);
            break;
        }
        break;
    }

    if (!func_name || !func_name[0]) return;

    // Build enclosing function QN
    const char* func_qn = c_build_qn(ctx, func_name);
    if (ctx->module_qn && !strchr(func_qn, '.')) {
        func_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, func_qn);
    }
    ctx->enclosing_func_qn = func_qn;

    // If inside a template, attach type_param_names to the registered function
    // so pending template calls can be resolved at call sites.
    if (ctx->in_template && ctx->template_param_count > 0) {
        // Find the registered function and set type_param_names
        for (int ri = 0; ri < ((CBMTypeRegistry*)ctx->registry)->func_count; ri++) {
            CBMRegisteredFunc* rf = &((CBMTypeRegistry*)ctx->registry)->funcs[ri];
            if (strcmp(rf->qualified_name, func_qn) == 0 && !rf->type_param_names) {
                const char** tpn = (const char**)cbm_arena_alloc(ctx->arena,
                    (ctx->template_param_count + 1) * sizeof(const char*));
                for (int ti = 0; ti < ctx->template_param_count; ti++)
                    tpn[ti] = ctx->template_param_names[ti];
                tpn[ctx->template_param_count] = NULL;
                rf->type_param_names = tpn;
                break;
            }
        }
    }

    // Push function scope
    CBMScope* saved_scope = ctx->current_scope;
    ctx->current_scope = cbm_scope_push(ctx->arena, ctx->current_scope);

    // Bind 'this' if in a method
    if (ctx->enclosing_class_qn) {
        cbm_scope_bind(ctx->current_scope, "this",
            cbm_type_pointer(ctx->arena,
                cbm_type_named(ctx->arena, ctx->enclosing_class_qn)));
    }

    // Bind parameters
    if (!ts_node_is_null(params_node)) {
        uint32_t pnc = ts_node_named_child_count(params_node);
        for (uint32_t i = 0; i < pnc; i++) {
            TSNode param = ts_node_named_child(params_node, i);
            if (!ts_node_is_null(param)) {
                c_process_statement(ctx, param);
            }
        }
    }

    // Walk function body
    TSNode body = ts_node_child_by_field_name(func_node, "body", 4);
    if (!ts_node_is_null(body)) {
        c_resolve_calls_in_node(ctx, body);
    }

    // Restore
    ctx->current_scope = saved_scope;
    ctx->enclosing_class_qn = saved_class_qn;
}

// ============================================================================
// Process namespace
// ============================================================================

// Process a top-level or nested declaration within a namespace/class body,
// handling template_declaration wrapping.
static void c_process_body_child(CLSPContext* ctx, TSNode child) {
    if (ts_node_is_null(child)) return;
    const char* ck = ts_node_type(child);

    if (strcmp(ck, "function_definition") == 0) {
        c_process_function(ctx, child);
    } else if (strcmp(ck, "namespace_definition") == 0) {
        c_process_namespace(ctx, child);
    } else if (strcmp(ck, "class_specifier") == 0 || strcmp(ck, "struct_specifier") == 0) {
        c_process_class(ctx, child);
    } else if (strcmp(ck, "concept_definition") == 0) {
        // C++20 concept: concept Sortable = requires(T a) { a.sort(); };
        // No CALLS edges from concept definitions — they are constraints, not runtime calls.
        // Skip processing to avoid false positive CALLS from requires-expressions.
        return;
    } else if (strcmp(ck, "template_declaration") == 0) {
        // Save template state, parse params for defaults, set flag
        bool saved_template = ctx->in_template;
        const char** saved_tpn = ctx->template_param_names;
        const CBMType** saved_tpd = ctx->template_param_defaults;
        int saved_tpc = ctx->template_param_count;

        ctx->in_template = true;
        c_parse_template_params(ctx, child);

        uint32_t tnc = ts_node_named_child_count(child);
        for (uint32_t ti = 0; ti < tnc; ti++) {
            TSNode inner = ts_node_named_child(child, ti);
            c_process_body_child(ctx, inner);
        }

        ctx->in_template = saved_template;
        ctx->template_param_names = saved_tpn;
        ctx->template_param_defaults = saved_tpd;
        ctx->template_param_count = saved_tpc;
    } else {
        c_resolve_calls_in_node(ctx, child);
    }
}

static void c_process_namespace(CLSPContext* ctx, TSNode ns_node) {
    const char* saved_ns = ctx->current_namespace;

    TSNode name_node = ts_node_child_by_field_name(ns_node, "name", 4);
    if (!ts_node_is_null(name_node)) {
        char* ns_name = c_node_text(ctx, name_node);
        if (ns_name) {
            if (saved_ns) {
                ctx->current_namespace = cbm_arena_sprintf(ctx->arena, "%s.%s", saved_ns, ns_name);
            } else if (ctx->module_qn) {
                ctx->current_namespace = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, ns_name);
            } else {
                ctx->current_namespace = ns_name;
            }
        }
    }

    TSNode body = ts_node_child_by_field_name(ns_node, "body", 4);
    if (!ts_node_is_null(body)) {
        uint32_t nc = ts_node_child_count(body);
        for (uint32_t i = 0; i < nc; i++) {
            c_process_body_child(ctx, ts_node_child(body, i));
        }
    }

    ctx->current_namespace = saved_ns;
}

// ============================================================================
// Process class/struct: process method bodies
// ============================================================================

static void c_process_class(CLSPContext* ctx, TSNode class_node) {
    const char* saved_class = ctx->enclosing_class_qn;
    const char** saved_tpn = ctx->template_param_names;
    const CBMType** saved_tpd = ctx->template_param_defaults;
    int saved_tpc = ctx->template_param_count;

    char* class_name = NULL;
    TSNode name_node = ts_node_child_by_field_name(class_node, "name", 4);
    if (!ts_node_is_null(name_node)) {
        class_name = c_node_text(ctx, name_node);
        if (class_name) {
            const char* class_qn;
            if (ctx->current_namespace) {
                class_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->current_namespace, class_name);
            } else if (ctx->module_qn) {
                class_qn = cbm_arena_sprintf(ctx->arena, "%s.%s", ctx->module_qn, class_name);
            } else {
                class_qn = class_name;
            }
            ctx->enclosing_class_qn = class_qn;
        }
    }

    // CRTP detection: class Derived : Base<Derived>
    // When a base class template argument matches the class name,
    // bind that template parameter to the derived class type.
    if (class_name && ctx->enclosing_class_qn) {
        // Walk base_class_clause children looking for template base classes
        uint32_t cnc = ts_node_named_child_count(class_node);
        for (uint32_t ci = 0; ci < cnc; ci++) {
            TSNode child = ts_node_named_child(class_node, ci);
            if (ts_node_is_null(child)) continue;
            const char* ck = ts_node_type(child);
            if (strcmp(ck, "base_class_clause") != 0) continue;
            // Iterate base specifiers
            uint32_t bnc = ts_node_named_child_count(child);
            for (uint32_t bi = 0; bi < bnc; bi++) {
                TSNode base_spec = ts_node_named_child(child, bi);
                if (ts_node_is_null(base_spec)) continue;
                // Look for template_type as base: Base<Derived>
                TSNode type_node = base_spec;
                if (strcmp(ts_node_type(base_spec), "access_specifier") == 0) continue;
                // The base type might be directly a template_type or wrapped
                if (strcmp(ts_node_type(type_node), "template_type") != 0) {
                    // Try walking children for template_type
                    uint32_t snc = ts_node_named_child_count(type_node);
                    bool found = false;
                    for (uint32_t si = 0; si < snc; si++) {
                        TSNode sc = ts_node_named_child(type_node, si);
                        if (strcmp(ts_node_type(sc), "template_type") == 0) {
                            type_node = sc;
                            found = true;
                            break;
                        }
                    }
                    if (!found) continue;
                }
                // type_node is template_type: check arguments for CRTP
                TSNode targs = ts_node_child_by_field_name(type_node, "arguments", 9);
                if (ts_node_is_null(targs)) continue;
                // Check each template argument for CRTP pattern
                uint32_t tanc = ts_node_named_child_count(targs);
                for (uint32_t ti = 0; ti < tanc; ti++) {
                    TSNode ta = ts_node_named_child(targs, ti);
                    if (ts_node_is_null(ta)) continue;
                    TSNode ta_inner = ta;
                    // type_descriptor wraps the actual type
                    if (strcmp(ts_node_type(ta), "type_descriptor") == 0 &&
                        ts_node_named_child_count(ta) > 0) {
                        ta_inner = ts_node_named_child(ta, 0);
                    }
                    char* arg_text = c_node_text(ctx, ta_inner);
                    if (arg_text && strcmp(arg_text, class_name) == 0) {
                        // CRTP detected! Map template param at position ti to derived class
                        // For now, bind using positional names (T0, T1, ...)
                        // Also check existing template params
                        if (ctx->template_param_names) {
                            for (int pi = 0; pi < ctx->template_param_count; pi++) {
                                if (ctx->template_param_names[pi] &&
                                    ctx->template_param_defaults && !ctx->template_param_defaults[pi]) {
                                    // Bind unbound template param to derived class
                                    // Only bind the first unbound one at position ti
                                    if (pi == (int)ti) {
                                        ctx->template_param_defaults[pi] =
                                            cbm_type_named(ctx->arena, ctx->enclosing_class_qn);
                                        break;
                                    }
                                }
                            }
                        }
                        break; // found CRTP for this base
                    }
                }
            }
            break; // only one base_class_clause
        }
    }

    TSNode body = ts_node_child_by_field_name(class_node, "body", 4);
    if (!ts_node_is_null(body)) {
        uint32_t nc = ts_node_child_count(body);
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_child(body, i);
            if (ts_node_is_null(child) || !ts_node_is_named(child)) continue;
            c_process_body_child(ctx, child);
        }
    }

    ctx->enclosing_class_qn = saved_class;
    ctx->template_param_names = saved_tpn;
    ctx->template_param_defaults = saved_tpd;
    ctx->template_param_count = saved_tpc;
}

// Need forward declaration since c_process_namespace and c_process_class reference each other
// Already defined above via forward declaration pattern — both reference c_resolve_calls_in_node

// ============================================================================
// Process file: top-level walk
// ============================================================================

void c_lsp_process_file(CLSPContext* ctx, TSNode root) {
    if (ts_node_is_null(root)) return;

    uint32_t nc = ts_node_child_count(root);

    // Pass 1: process using declarations and global variables
    for (uint32_t i = 0; i < nc; i++) {
        TSNode child = ts_node_child(root, i);
        if (ts_node_is_null(child)) continue;
        const char* ck = ts_node_type(child);

        if (strcmp(ck, "using_declaration") == 0 ||
            strcmp(ck, "alias_declaration") == 0 ||
            strcmp(ck, "type_definition") == 0 ||
            strcmp(ck, "namespace_alias_definition") == 0) {
            c_process_statement(ctx, child);
        } else if (strcmp(ck, "declaration") == 0) {
            c_process_statement(ctx, child);
        }
    }

    // Pass 2: process functions, namespaces, classes, templates
    for (uint32_t i = 0; i < nc; i++) {
        TSNode child = ts_node_child(root, i);
        if (ts_node_is_null(child)) continue;
        c_process_body_child(ctx, child);
    }
}

// ============================================================================
// Parse C/C++ return type text into CBMType (for cross-file defs)
// ============================================================================

static const CBMType* c_parse_return_type_text(CBMArena* a, const char* text, const char* module_qn) {
    if (!text || !text[0]) return cbm_type_unknown();

    // Skip const/volatile qualifiers
    while (strncmp(text, "const ", 6) == 0) text += 6;
    while (strncmp(text, "volatile ", 9) == 0) text += 9;

    // Pointer
    size_t len = strlen(text);
    if (len > 0 && text[len - 1] == '*') {
        char* inner = cbm_arena_strndup(a, text, len - 1);
        // Trim trailing space
        size_t ilen = strlen(inner);
        while (ilen > 0 && inner[ilen - 1] == ' ') inner[--ilen] = '\0';
        return cbm_type_pointer(a, c_parse_return_type_text(a, inner, module_qn));
    }

    // Reference
    if (len > 0 && text[len - 1] == '&') {
        char* inner = cbm_arena_strndup(a, text, len - 1);
        size_t ilen = strlen(inner);
        while (ilen > 0 && inner[ilen - 1] == ' ') inner[--ilen] = '\0';
        // Check for rvalue ref
        if (ilen > 0 && inner[ilen - 1] == '&') {
            inner[ilen - 1] = '\0';
            while (ilen > 1 && inner[ilen - 2] == ' ') inner[--ilen - 1] = '\0';
            return cbm_type_rvalue_ref(a, c_parse_return_type_text(a, inner, module_qn));
        }
        return cbm_type_reference(a, c_parse_return_type_text(a, inner, module_qn));
    }

    // Builtins
    if (is_c_builtin_type(text)) return cbm_type_builtin(a, text);

    // Template type parameters: single uppercase letter or T1-T9
    // Recognized as TYPE_PARAM so template substitution works on method return types.
    if (len == 1 && text[0] >= 'A' && text[0] <= 'Z') {
        return cbm_type_type_param(a, text);
    }
    if (len == 2 && text[0] == 'T' && text[1] >= '1' && text[1] <= '9') {
        return cbm_type_type_param(a, text);
    }

    // Qualified name (has ::)
    if (strstr(text, "::")) {
        // Replace :: with .
        char* qn = cbm_arena_strdup(a, text);
        for (char* p = qn; *p; p++) {
            if (p[0] == ':' && p[1] == ':') { p[0] = '.'; memmove(p + 1, p + 2, strlen(p + 2) + 1); }
        }
        return cbm_type_named(a, qn);
    }

    // Named type: qualify with module
    if (module_qn && module_qn[0]) {
        return cbm_type_named(a, cbm_arena_sprintf(a, "%s.%s", module_qn, text));
    }
    return cbm_type_named(a, text);
}

// ============================================================================
// Entry point: single-file LSP
// ============================================================================

void cbm_run_c_lsp(CBMArena* arena, CBMFileResult* result,
    const char* source, int source_len, TSNode root, bool cpp_mode) {

    CBMTypeRegistry reg;
    cbm_registry_init(&reg, arena);

    // Register stdlib
    cbm_c_stdlib_register(&reg, arena);
    if (cpp_mode) cbm_cpp_stdlib_register(&reg, arena);

    const char* module_qn = result->module_qn;

    // Register file's own definitions
    for (int i = 0; i < result->defs.count; i++) {
        CBMDefinition* d = &result->defs.items[i];
        if (!d->qualified_name || !d->name) continue;

        if (d->label && (strcmp(d->label, "Class") == 0 || strcmp(d->label, "Type") == 0)) {
            CBMRegisteredType rt;
            memset(&rt, 0, sizeof(rt));
            rt.qualified_name = d->qualified_name;
            rt.short_name = d->name;

            // Base classes
            if (d->base_classes) {
                int bc_count = 0;
                while (d->base_classes[bc_count]) bc_count++;
                if (bc_count > 0) {
                    const char** embedded = (const char**)cbm_arena_alloc(arena, (bc_count + 1) * sizeof(const char*));
                    for (int j = 0; j < bc_count; j++) {
                        const char* bc = d->base_classes[j];
                        // Check if already qualified
                        if (strchr(bc, '.') || strstr(bc, "::")) {
                            embedded[j] = bc;
                        } else {
                            embedded[j] = cbm_arena_sprintf(arena, "%s.%s", module_qn, bc);
                        }
                    }
                    embedded[bc_count] = NULL;
                    rt.embedded_types = embedded;
                }
            }
            cbm_registry_add_type(&reg, rt);
        }

        if (d->label && (strcmp(d->label, "Function") == 0 || strcmp(d->label, "Method") == 0)) {
            CBMRegisteredFunc rf;
            memset(&rf, 0, sizeof(rf));
            rf.qualified_name = d->qualified_name;
            rf.short_name = d->name;

            // Build return type
            const CBMType** ret_types = NULL;
            if (d->return_types) {
                int count = 0;
                while (d->return_types[count]) count++;
                if (count > 0) {
                    ret_types = (const CBMType**)cbm_arena_alloc(arena, (count + 1) * sizeof(const CBMType*));
                    for (int j = 0; j < count; j++)
                        ret_types[j] = c_parse_return_type_text(arena, d->return_types[j], module_qn);
                    ret_types[count] = NULL;
                }
            } else if (d->return_type && d->return_type[0]) {
                ret_types = (const CBMType**)cbm_arena_alloc(arena, 2 * sizeof(const CBMType*));
                ret_types[0] = c_parse_return_type_text(arena, d->return_type, module_qn);
                ret_types[1] = NULL;
            }

            // Build param types
            const CBMType** param_types_arr = NULL;
            if (d->param_types) {
                int count = 0;
                while (d->param_types[count]) count++;
                if (count > 0) {
                    param_types_arr = (const CBMType**)cbm_arena_alloc(arena, (count + 1) * sizeof(const CBMType*));
                    for (int j = 0; j < count; j++)
                        param_types_arr[j] = c_parse_return_type_text(arena, d->param_types[j], module_qn);
                    param_types_arr[count] = NULL;
                }
            }

            rf.signature = cbm_type_func(arena, d->param_names, param_types_arr, ret_types);

            // Method receiver
            if (strcmp(d->label, "Method") == 0 && d->parent_class) {
                rf.receiver_type = d->parent_class;
                // Auto-create type if needed
                if (!cbm_registry_lookup_type(&reg, d->parent_class)) {
                    CBMRegisteredType auto_type;
                    memset(&auto_type, 0, sizeof(auto_type));
                    auto_type.qualified_name = d->parent_class;
                    // Extract short name
                    const char* dot = strrchr(d->parent_class, '.');
                    auto_type.short_name = dot ? dot + 1 : d->parent_class;
                    cbm_registry_add_type(&reg, auto_type);
                }
            }

            cbm_registry_add_func(&reg, rf);
        }
    }

    // Initialize context and run
    CLSPContext ctx;
    c_lsp_init(&ctx, arena, source, source_len, &reg, module_qn, cpp_mode, &result->resolved_calls);

    c_lsp_process_file(&ctx, root);
}

// ============================================================================
// Entry point: cross-file LSP
// ============================================================================

void cbm_run_c_lsp_cross(
    CBMArena* arena,
    const char* source, int source_len,
    const char* module_qn,
    bool cpp_mode,
    CBMLSPDef* defs, int def_count,
    const char** include_paths, const char** include_ns_qns, int include_count,
    CBMResolvedCallArray* out) {

    if (!source || source_len == 0 || !out) return;

    CBMTypeRegistry reg;
    cbm_registry_init(&reg, arena);

    // Register stdlib
    cbm_c_stdlib_register(&reg, arena);
    if (cpp_mode) cbm_cpp_stdlib_register(&reg, arena);

    // Register all defs
    for (int i = 0; i < def_count; i++) {
        CBMLSPDef* d = &defs[i];
        if (!d->qualified_name || !d->short_name) continue;

        if (d->label && (strcmp(d->label, "Class") == 0 || strcmp(d->label, "Type") == 0 ||
                         strcmp(d->label, "Interface") == 0)) {
            CBMRegisteredType rt;
            memset(&rt, 0, sizeof(rt));
            rt.qualified_name = cbm_arena_strdup(arena, d->qualified_name);
            rt.short_name = cbm_arena_strdup(arena, d->short_name);
            rt.is_interface = d->is_interface;

            // Embedded/base types
            if (d->embedded_types) {
                // Parse "|"-separated list
                const char* src = d->embedded_types;
                const char* embeds[32];
                int embed_count = 0;
                while (*src && embed_count < 31) {
                    const char* sep = strchr(src, '|');
                    if (sep) {
                        embeds[embed_count++] = cbm_arena_strndup(arena, src, sep - src);
                        src = sep + 1;
                    } else {
                        embeds[embed_count++] = cbm_arena_strdup(arena, src);
                        break;
                    }
                }
                if (embed_count > 0) {
                    const char** arr = (const char**)cbm_arena_alloc(arena, (embed_count + 1) * sizeof(const char*));
                    for (int j = 0; j < embed_count; j++) arr[j] = embeds[j];
                    arr[embed_count] = NULL;
                    rt.embedded_types = arr;
                }
            }

            // Field defs
            if (d->field_defs) {
                const char* fsrc = d->field_defs;
                const char* fnames[64];
                const CBMType* ftypes[64];
                int fcount = 0;
                while (*fsrc && fcount < 63) {
                    const char* sep = strchr(fsrc, '|');
                    const char* end = sep ? sep : fsrc + strlen(fsrc);
                    char* pair = cbm_arena_strndup(arena, fsrc, end - fsrc);
                    char* colon = strchr(pair, ':');
                    if (colon) {
                        *colon = '\0';
                        fnames[fcount] = pair;
                        ftypes[fcount] = c_parse_return_type_text(arena, colon + 1,
                            d->def_module_qn ? d->def_module_qn : module_qn);
                        fcount++;
                    }
                    if (!sep) break;
                    fsrc = sep + 1;
                }
                if (fcount > 0) {
                    const char** fnarr = (const char**)cbm_arena_alloc(arena, (fcount + 1) * sizeof(const char*));
                    const CBMType** ftarr = (const CBMType**)cbm_arena_alloc(arena, (fcount + 1) * sizeof(const CBMType*));
                    for (int j = 0; j < fcount; j++) { fnarr[j] = fnames[j]; ftarr[j] = ftypes[j]; }
                    fnarr[fcount] = NULL;
                    ftarr[fcount] = NULL;
                    rt.field_names = fnarr;
                    rt.field_types = ftarr;
                }
            }

            cbm_registry_add_type(&reg, rt);
        }

        if (d->label && (strcmp(d->label, "Function") == 0 || strcmp(d->label, "Method") == 0)) {
            CBMRegisteredFunc rf;
            memset(&rf, 0, sizeof(rf));
            rf.qualified_name = cbm_arena_strdup(arena, d->qualified_name);
            rf.short_name = cbm_arena_strdup(arena, d->short_name);

            const char* def_module = d->def_module_qn ? d->def_module_qn : module_qn;

            // Return types
            if (d->return_types) {
                // Parse "|"-separated
                const char* rsrc = d->return_types;
                const CBMType* rets[16];
                int rcount = 0;
                while (*rsrc && rcount < 15) {
                    const char* sep = strchr(rsrc, '|');
                    const char* end = sep ? sep : rsrc + strlen(rsrc);
                    char* rt_text = cbm_arena_strndup(arena, rsrc, end - rsrc);
                    rets[rcount++] = c_parse_return_type_text(arena, rt_text, def_module);
                    if (!sep) break;
                    rsrc = sep + 1;
                }
                if (rcount > 0) {
                    const CBMType** rarr = (const CBMType**)cbm_arena_alloc(arena, (rcount + 1) * sizeof(const CBMType*));
                    for (int j = 0; j < rcount; j++) rarr[j] = rets[j];
                    rarr[rcount] = NULL;
                    rf.signature = cbm_type_func(arena, NULL, NULL, rarr);
                }
            }
            if (!rf.signature) rf.signature = cbm_type_func(arena, NULL, NULL, NULL);

            if (d->receiver_type) {
                rf.receiver_type = cbm_arena_strdup(arena, d->receiver_type);
            }

            cbm_registry_add_func(&reg, rf);
        }
    }

    // Parse the source with tree-sitter
    TSParser* parser = ts_parser_new();
    if (!parser) return;

    const TSLanguage* ts_lang = cpp_mode ?
        tree_sitter_cpp() : tree_sitter_c();
    ts_parser_set_language(parser, ts_lang);

    TSTree* tree = ts_parser_parse_string(parser, NULL, source, source_len);
    ts_parser_delete(parser);
    if (!tree) return;

    TSNode root = ts_tree_root_node(tree);

    // Initialize context and run
    CLSPContext ctx;
    c_lsp_init(&ctx, arena, source, source_len, &reg, module_qn, cpp_mode, out);

    // Add include mappings
    for (int i = 0; i < include_count; i++) {
        c_lsp_add_include(&ctx, include_paths[i], include_ns_qns[i]);
    }

    c_lsp_process_file(&ctx, root);

    ts_tree_delete(tree);
}

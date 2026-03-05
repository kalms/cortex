#include "cbm.h"
#include "helpers.h"
#include "lang_specs.h"
#include "extract_unified.h"
#include <string.h>
#include <ctype.h>

// Forward declarations
static void walk_calls(CBMExtractCtx* ctx, TSNode node, const CBMLangSpec* spec);
static char* extract_callee_name(CBMArena* a, TSNode node, const char* source, CBMLanguage lang);
static void extract_jsx_refs(CBMExtractCtx* ctx, TSNode node);

// Extract callee name from a call node
static char* extract_callee_name(CBMArena* a, TSNode node, const char* source, CBMLanguage lang) {
    // Try "function" field (most languages: call_expression, etc.)
    TSNode func_node = ts_node_child_by_field_name(node, "function", 8);
    if (!ts_node_is_null(func_node)) {
        const char* fk = ts_node_type(func_node);
        if (strcmp(fk, "identifier") == 0 ||
            strcmp(fk, "simple_identifier") == 0 ||
            strcmp(fk, "selector_expression") == 0 ||
            strcmp(fk, "attribute") == 0 ||
            strcmp(fk, "member_expression") == 0 ||
            strcmp(fk, "field_expression") == 0 ||
            strcmp(fk, "dot") == 0 ||
            strcmp(fk, "function") == 0 ||
            strcmp(fk, "dotted_identifier") == 0 ||
            strcmp(fk, "member_access_expression") == 0 ||
            strcmp(fk, "scoped_identifier") == 0 ||
            strcmp(fk, "qualified_identifier") == 0) {
            return cbm_node_text(a, func_node, source);
        }
    }

    // Try "name" field (Java method_invocation)
    TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
    if (!ts_node_is_null(name_node)) {
        char* name = cbm_node_text(a, name_node, source);
        // For Java: prepend object if present
        TSNode obj = ts_node_child_by_field_name(node, "object", 6);
        if (!ts_node_is_null(obj) && name) {
            char* obj_text = cbm_node_text(a, obj, source);
            if (obj_text && obj_text[0]) {
                return cbm_arena_sprintf(a, "%s.%s", obj_text, name);
            }
        }
        return name;
    }

    // Ruby: "method" + "receiver" fields
    TSNode method_node = ts_node_child_by_field_name(node, "method", 6);
    if (!ts_node_is_null(method_node)) {
        char* method = cbm_node_text(a, method_node, source);
        TSNode recv = ts_node_child_by_field_name(node, "receiver", 8);
        if (!ts_node_is_null(recv) && method) {
            char* recv_text = cbm_node_text(a, recv, source);
            if (recv_text && recv_text[0]) {
                return cbm_arena_sprintf(a, "%s.%s", recv_text, method);
            }
        }
        return method;
    }

    // ObjC message_expression: [receiver message]
    if (lang == CBM_LANG_OBJC && strcmp(ts_node_type(node), "message_expression") == 0) {
        TSNode selector = ts_node_child_by_field_name(node, "selector", 8);
        if (!ts_node_is_null(selector)) {
            return cbm_node_text(a, selector, source);
        }
    }

    // Erlang: call -> first child is module:function or just function
    if (lang == CBM_LANG_ERLANG && strcmp(ts_node_type(node), "call") == 0) {
        if (ts_node_child_count(node) > 0) {
            return cbm_node_text(a, ts_node_child(node, 0), source);
        }
    }

    // Haskell/OCaml: application_expression, infix, apply
    if (lang == CBM_LANG_HASKELL || lang == CBM_LANG_OCAML) {
        const char* nk = ts_node_type(node);
        if (strcmp(nk, "apply") == 0 || strcmp(nk, "application_expression") == 0) {
            if (ts_node_child_count(node) > 0) {
                TSNode callee = ts_node_child(node, 0);
                if (strcmp(ts_node_type(callee), "identifier") == 0 ||
                    strcmp(ts_node_type(callee), "variable") == 0 ||
                    strcmp(ts_node_type(callee), "constructor") == 0 ||
                    strcmp(ts_node_type(callee), "value_path") == 0) {
                    return cbm_node_text(a, callee, source);
                }
            }
        }
        if (strcmp(nk, "infix") == 0 || strcmp(nk, "infix_expression") == 0) {
            TSNode op = ts_node_child_by_field_name(node, "operator", 8);
            if (!ts_node_is_null(op)) {
                return cbm_node_text(a, op, source);
            }
            // Fallback: second child is usually the operator
            if (ts_node_child_count(node) >= 3) {
                return cbm_node_text(a, ts_node_child(node, 1), source);
            }
        }
    }

    // Elixir: first child of call is the function name
    if (lang == CBM_LANG_ELIXIR && strcmp(ts_node_type(node), "call") == 0) {
        if (ts_node_child_count(node) > 0) {
            TSNode first = ts_node_child(node, 0);
            const char* fk = ts_node_type(first);
            if (strcmp(fk, "identifier") == 0 || strcmp(fk, "dot") == 0) {
                return cbm_node_text(a, first, source);
            }
        }
    }

    // Perl: various call expression types
    if (lang == CBM_LANG_PERL) {
        if (ts_node_child_count(node) > 0) {
            return cbm_node_text(a, ts_node_child(node, 0), source);
        }
    }

    // PHP: function_call_expression, member_call_expression, etc.
    if (lang == CBM_LANG_PHP) {
        func_node = ts_node_child_by_field_name(node, "function", 8);
        if (ts_node_is_null(func_node)) {
            func_node = ts_node_child_by_field_name(node, "name", 4);
        }
        if (!ts_node_is_null(func_node)) {
            return cbm_node_text(a, func_node, source);
        }
    }

    // Kotlin: navigation_expression, call_expression
    if (lang == CBM_LANG_KOTLIN) {
        if (ts_node_child_count(node) > 0) {
            return cbm_node_text(a, ts_node_child(node, 0), source);
        }
    }

    // Generic fallback: first child
    if (ts_node_child_count(node) > 0) {
        TSNode first = ts_node_child(node, 0);
        if (strcmp(ts_node_type(first), "identifier") == 0) {
            return cbm_node_text(a, first, source);
        }
    }

    return NULL;
}

// Walk AST for call nodes
static void walk_calls(CBMExtractCtx* ctx, TSNode node, const CBMLangSpec* spec) {
    const char* kind = ts_node_type(node);

    if (cbm_kind_in_set(node, spec->call_node_types)) {
        char* callee = extract_callee_name(ctx->arena, node, ctx->source, ctx->language);
        if (callee && callee[0]) {
            // Skip keywords
            if (!cbm_is_keyword(callee, ctx->language)) {
                CBMCall call;
                call.callee_name = callee;
                call.enclosing_func_qn = cbm_enclosing_func_qn_cached(ctx, node);
                cbm_calls_push(&ctx->result->calls, ctx->arena, call);
            }
        }
        // Don't recurse into call arguments for nested calls — the walk handles that
    }

    // JSX component refs (TSX/JSX)
    if (ctx->language == CBM_LANG_TSX || ctx->language == CBM_LANG_JAVASCRIPT) {
        if (strcmp(kind, "jsx_self_closing_element") == 0 ||
            strcmp(kind, "jsx_opening_element") == 0) {
            extract_jsx_refs(ctx, node);
        }
    }

    // Recurse
    uint32_t count = ts_node_child_count(node);
    for (uint32_t i = 0; i < count; i++) {
        walk_calls(ctx, ts_node_child(node, i), spec);
    }
}

// Extract JSX component references (uppercase = component, lowercase = HTML)
static void extract_jsx_refs(CBMExtractCtx* ctx, TSNode node) {
    TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
    if (ts_node_is_null(name_node)) return;

    char* name = cbm_node_text(ctx->arena, name_node, ctx->source);
    if (!name || !name[0]) return;

    // Only uppercase names are components
    if (name[0] < 'A' || name[0] > 'Z') return;

    CBMCall call;
    call.callee_name = name;
    call.enclosing_func_qn = cbm_enclosing_func_qn_cached(ctx, node);
    cbm_calls_push(&ctx->result->calls, ctx->arena, call);
}

void cbm_extract_calls(CBMExtractCtx* ctx) {
    const CBMLangSpec* spec = cbm_lang_spec(ctx->language);
    if (!spec || !spec->call_node_types || !spec->call_node_types[0]) return;

    walk_calls(ctx, ctx->root, spec);
}

// --- Unified handler: called once per node by the cursor walk ---

void handle_calls(CBMExtractCtx* ctx, TSNode node, const CBMLangSpec* spec, WalkState* state) {
    if (!spec->call_node_types || !spec->call_node_types[0]) return;

    const char* kind = ts_node_type(node);

    if (cbm_kind_in_set(node, spec->call_node_types)) {
        char* callee = extract_callee_name(ctx->arena, node, ctx->source, ctx->language);
        if (callee && callee[0] && !cbm_is_keyword(callee, ctx->language)) {
            CBMCall call;
            call.callee_name = callee;
            call.enclosing_func_qn = state->enclosing_func_qn;
            cbm_calls_push(&ctx->result->calls, ctx->arena, call);
        }
    }

    // JSX component refs (TSX/JSX)
    if (ctx->language == CBM_LANG_TSX || ctx->language == CBM_LANG_JAVASCRIPT) {
        if (strcmp(kind, "jsx_self_closing_element") == 0 ||
            strcmp(kind, "jsx_opening_element") == 0) {
            TSNode name_node = ts_node_child_by_field_name(node, "name", 4);
            if (!ts_node_is_null(name_node)) {
                char* name = cbm_node_text(ctx->arena, name_node, ctx->source);
                if (name && name[0] >= 'A' && name[0] <= 'Z') {
                    CBMCall call;
                    call.callee_name = name;
                    call.enclosing_func_qn = state->enclosing_func_qn;
                    cbm_calls_push(&ctx->result->calls, ctx->arena, call);
                }
            }
        }
    }
}

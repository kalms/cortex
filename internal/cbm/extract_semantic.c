#include "cbm.h"
#include "helpers.h"
#include "lang_specs.h"
#include "extract_unified.h"
#include <string.h>
#include <ctype.h>

// --- Throw/Raise extraction ---

static void walk_throws(CBMExtractCtx* ctx, TSNode node, const CBMLangSpec* spec) {
    const char* kind = ts_node_type(node);

    if (cbm_kind_in_set(node, spec->throw_node_types)) {
        // Extract the exception name
        char* exc_name = NULL;

        // Python raise: raise_statement -> first child is the exception
        // Java throw: throw_statement -> first expression child
        // JS throw: throw_statement -> first expression child
        uint32_t nc = ts_node_child_count(node);
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_child(node, i);
            const char* ck = ts_node_type(child);
            // Skip keywords
            if (strcmp(ck, "raise") == 0 || strcmp(ck, "throw") == 0) continue;
            // Skip semicolons and other punctuation
            if (ck[0] == ';' || ck[0] == '(' || ck[0] == ')') continue;

            if (strcmp(ck, "identifier") == 0 || strcmp(ck, "type_identifier") == 0) {
                exc_name = cbm_node_text(ctx->arena, child, ctx->source);
            } else if (strcmp(ck, "call") == 0 || strcmp(ck, "call_expression") == 0 ||
                       strcmp(ck, "new_expression") == 0 || strcmp(ck, "object_creation_expression") == 0 ||
                       strcmp(ck, "instance_expression") == 0) {
                // Call/new: get the function/type name
                TSNode fn = ts_node_child_by_field_name(child, "function", 8);
                if (ts_node_is_null(fn)) fn = ts_node_child_by_field_name(child, "constructor", 11);
                if (ts_node_is_null(fn)) fn = ts_node_child_by_field_name(child, "type", 4);
                // Fallback: first named child (skips 'new' keyword)
                if (ts_node_is_null(fn) && ts_node_named_child_count(child) > 0) {
                    fn = ts_node_named_child(child, 0);
                }
                if (!ts_node_is_null(fn)) {
                    exc_name = cbm_node_text(ctx->arena, fn, ctx->source);
                }
            } else {
                // Fallback: use full expression text
                exc_name = cbm_node_text(ctx->arena, child, ctx->source);
            }
            break;
        }

        if (exc_name && exc_name[0]) {
            // Truncate long exception names
            if (strlen(exc_name) > 100) exc_name[100] = '\0';

            CBMThrow thr;
            thr.exception_name = exc_name;
            thr.enclosing_func_qn = cbm_enclosing_func_qn_cached(ctx, node);
            cbm_throws_push(&ctx->result->throws, ctx->arena, thr);
        }
    }

    // Java: check for throws clause on function declarations
    if (spec->throws_clause_field && spec->throws_clause_field[0]) {
        if (strcmp(kind, "method_declaration") == 0 || strcmp(kind, "constructor_declaration") == 0) {
            TSNode throws_clause = ts_node_child_by_field_name(node, spec->throws_clause_field,
                (uint32_t)strlen(spec->throws_clause_field));
            if (!ts_node_is_null(throws_clause)) {
                // Extract each exception type from the throws clause
                uint32_t nc = ts_node_child_count(throws_clause);
                for (uint32_t i = 0; i < nc; i++) {
                    TSNode child = ts_node_child(throws_clause, i);
                    const char* ck = ts_node_type(child);
                    if (strcmp(ck, "type_identifier") == 0 || strcmp(ck, "identifier") == 0 ||
                        strcmp(ck, "scoped_type_identifier") == 0) {
                        char* exc = cbm_node_text(ctx->arena, child, ctx->source);
                        if (exc && exc[0]) {
                            const char* func_qn = cbm_enclosing_func_qn_cached(ctx, node);
                            CBMThrow thr = {.exception_name = exc, .enclosing_func_qn = func_qn};
                            cbm_throws_push(&ctx->result->throws, ctx->arena, thr);
                        }
                    }
                }
            }
        }
    }

    // Recurse
    uint32_t count = ts_node_child_count(node);
    for (uint32_t i = 0; i < count; i++) {
        walk_throws(ctx, ts_node_child(node, i), spec);
    }
}

// --- Read/Write detection ---

static void walk_readwrites(CBMExtractCtx* ctx, TSNode node, const CBMLangSpec* spec) {
    // Check if this is an assignment node
    if (cbm_kind_in_set(node, spec->assignment_node_types)) {
        // Left side is a write, right side contains reads
        TSNode left = ts_node_child_by_field_name(node, "left", 4);
        if (ts_node_is_null(left)) {
            // Try first child as left-hand side
            if (ts_node_child_count(node) > 0) left = ts_node_child(node, 0);
        }

        if (!ts_node_is_null(left)) {
            const char* lk = ts_node_type(left);
            if (strcmp(lk, "identifier") == 0 || strcmp(lk, "simple_identifier") == 0) {
                char* name = cbm_node_text(ctx->arena, left, ctx->source);
                if (name && name[0] && !cbm_is_keyword(name, ctx->language)) {
                    CBMReadWrite rw;
                    rw.var_name = name;
                    rw.is_write = true;
                    rw.enclosing_func_qn = cbm_enclosing_func_qn_cached(ctx, node);
                    cbm_rw_push(&ctx->result->rw, ctx->arena, rw);
                }
            }
        }
    }

    // Recurse
    uint32_t count = ts_node_child_count(node);
    for (uint32_t i = 0; i < count; i++) {
        walk_readwrites(ctx, ts_node_child(node, i), spec);
    }
}

void cbm_extract_semantic(CBMExtractCtx* ctx) {
    const CBMLangSpec* spec = cbm_lang_spec(ctx->language);
    if (!spec) return;

    // Throws
    if (spec->throw_node_types && spec->throw_node_types[0]) {
        walk_throws(ctx, ctx->root, spec);
    } else if (spec->throws_clause_field && spec->throws_clause_field[0]) {
        walk_throws(ctx, ctx->root, spec);
    }

    // Reads/Writes
    if (spec->assignment_node_types && spec->assignment_node_types[0]) {
        walk_readwrites(ctx, ctx->root, spec);
    }
}

// --- Unified handlers ---

void handle_throws(CBMExtractCtx* ctx, TSNode node, const CBMLangSpec* spec, WalkState* state) {
    bool has_throws = spec->throw_node_types && spec->throw_node_types[0];
    bool has_clause = spec->throws_clause_field && spec->throws_clause_field[0];
    if (!has_throws && !has_clause) return;

    const char* kind = ts_node_type(node);

    if (has_throws && cbm_kind_in_set(node, spec->throw_node_types)) {
        char* exc_name = NULL;
        uint32_t nc = ts_node_child_count(node);
        for (uint32_t i = 0; i < nc; i++) {
            TSNode child = ts_node_child(node, i);
            const char* ck = ts_node_type(child);
            if (strcmp(ck, "raise") == 0 || strcmp(ck, "throw") == 0) continue;
            if (ck[0] == ';' || ck[0] == '(' || ck[0] == ')') continue;

            if (strcmp(ck, "identifier") == 0 || strcmp(ck, "type_identifier") == 0) {
                exc_name = cbm_node_text(ctx->arena, child, ctx->source);
            } else if (strcmp(ck, "call") == 0 || strcmp(ck, "call_expression") == 0 ||
                       strcmp(ck, "new_expression") == 0 || strcmp(ck, "object_creation_expression") == 0 ||
                       strcmp(ck, "instance_expression") == 0) {
                TSNode fn = ts_node_child_by_field_name(child, "function", 8);
                if (ts_node_is_null(fn)) fn = ts_node_child_by_field_name(child, "constructor", 11);
                if (ts_node_is_null(fn)) fn = ts_node_child_by_field_name(child, "type", 4);
                if (ts_node_is_null(fn) && ts_node_named_child_count(child) > 0) {
                    fn = ts_node_named_child(child, 0);
                }
                if (!ts_node_is_null(fn)) {
                    exc_name = cbm_node_text(ctx->arena, fn, ctx->source);
                }
            } else {
                exc_name = cbm_node_text(ctx->arena, child, ctx->source);
            }
            break;
        }

        if (exc_name && exc_name[0]) {
            if (strlen(exc_name) > 100) exc_name[100] = '\0';
            CBMThrow thr;
            thr.exception_name = exc_name;
            thr.enclosing_func_qn = state->enclosing_func_qn;
            cbm_throws_push(&ctx->result->throws, ctx->arena, thr);
        }
    }

    // Java: throws clause on method/constructor declarations
    if (has_clause) {
        if (strcmp(kind, "method_declaration") == 0 || strcmp(kind, "constructor_declaration") == 0) {
            TSNode throws_clause = ts_node_child_by_field_name(node, spec->throws_clause_field,
                (uint32_t)strlen(spec->throws_clause_field));
            if (!ts_node_is_null(throws_clause)) {
                uint32_t nc = ts_node_child_count(throws_clause);
                for (uint32_t i = 0; i < nc; i++) {
                    TSNode child = ts_node_child(throws_clause, i);
                    const char* ck = ts_node_type(child);
                    if (strcmp(ck, "type_identifier") == 0 || strcmp(ck, "identifier") == 0 ||
                        strcmp(ck, "scoped_type_identifier") == 0) {
                        char* exc = cbm_node_text(ctx->arena, child, ctx->source);
                        if (exc && exc[0]) {
                            CBMThrow thr = {.exception_name = exc,
                                            .enclosing_func_qn = state->enclosing_func_qn};
                            cbm_throws_push(&ctx->result->throws, ctx->arena, thr);
                        }
                    }
                }
            }
        }
    }
}

void handle_readwrites(CBMExtractCtx* ctx, TSNode node, const CBMLangSpec* spec, WalkState* state) {
    if (!spec->assignment_node_types || !spec->assignment_node_types[0]) return;

    if (cbm_kind_in_set(node, spec->assignment_node_types)) {
        TSNode left = ts_node_child_by_field_name(node, "left", 4);
        if (ts_node_is_null(left)) {
            if (ts_node_child_count(node) > 0) left = ts_node_child(node, 0);
        }

        if (!ts_node_is_null(left)) {
            const char* lk = ts_node_type(left);
            if (strcmp(lk, "identifier") == 0 || strcmp(lk, "simple_identifier") == 0) {
                char* name = cbm_node_text(ctx->arena, left, ctx->source);
                if (name && name[0] && !cbm_is_keyword(name, ctx->language)) {
                    CBMReadWrite rw;
                    rw.var_name = name;
                    rw.is_write = true;
                    rw.enclosing_func_qn = state->enclosing_func_qn;
                    cbm_rw_push(&ctx->result->rw, ctx->arena, rw);
                }
            }
        }
    }
}

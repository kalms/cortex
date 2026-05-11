#include "type_registry.h"
#include <string.h>
#include <stdlib.h>

void ctx_registry_init(CtxTypeRegistry* reg, CtxArena* arena) {
    memset(reg, 0, sizeof(CtxTypeRegistry));
    reg->arena = arena;
}

void ctx_registry_add_func(CtxTypeRegistry* reg, CtxRegisteredFunc func) {
    if (reg->func_count >= reg->func_cap) {
        int new_cap = reg->func_cap == 0 ? 64 : reg->func_cap * 2;
        CtxRegisteredFunc* new_items = (CtxRegisteredFunc*)ctx_arena_alloc(reg->arena,
            (size_t)new_cap * sizeof(CtxRegisteredFunc));
        if (!new_items) return;
        if (reg->funcs && reg->func_count > 0) {
            memcpy(new_items, reg->funcs, (size_t)reg->func_count * sizeof(CtxRegisteredFunc));
        }
        reg->funcs = new_items;
        reg->func_cap = new_cap;
    }
    reg->funcs[reg->func_count++] = func;
}

void ctx_registry_add_type(CtxTypeRegistry* reg, CtxRegisteredType type) {
    if (reg->type_count >= reg->type_cap) {
        int new_cap = reg->type_cap == 0 ? 64 : reg->type_cap * 2;
        CtxRegisteredType* new_items = (CtxRegisteredType*)ctx_arena_alloc(reg->arena,
            (size_t)new_cap * sizeof(CtxRegisteredType));
        if (!new_items) return;
        if (reg->types && reg->type_count > 0) {
            memcpy(new_items, reg->types, (size_t)reg->type_count * sizeof(CtxRegisteredType));
        }
        reg->types = new_items;
        reg->type_cap = new_cap;
    }
    reg->types[reg->type_count++] = type;
}

const CtxRegisteredFunc* ctx_registry_lookup_method(const CtxTypeRegistry* reg,
    const char* receiver_qn, const char* method_name) {
    if (!reg || !receiver_qn || !method_name) return NULL;

    for (int i = 0; i < reg->func_count; i++) {
        const CtxRegisteredFunc* f = &reg->funcs[i];
        if (f->receiver_type && f->short_name &&
            strcmp(f->receiver_type, receiver_qn) == 0 &&
            strcmp(f->short_name, method_name) == 0) {
            return f;
        }
    }
    return NULL;
}

const CtxRegisteredType* ctx_registry_lookup_type(const CtxTypeRegistry* reg,
    const char* qualified_name) {
    if (!reg || !qualified_name) return NULL;

    for (int i = 0; i < reg->type_count; i++) {
        if (strcmp(reg->types[i].qualified_name, qualified_name) == 0) {
            return &reg->types[i];
        }
    }
    return NULL;
}

const CtxRegisteredFunc* ctx_registry_lookup_func(const CtxTypeRegistry* reg,
    const char* qualified_name) {
    if (!reg || !qualified_name) return NULL;

    for (int i = 0; i < reg->func_count; i++) {
        if (strcmp(reg->funcs[i].qualified_name, qualified_name) == 0) {
            return &reg->funcs[i];
        }
    }
    return NULL;
}

const CtxRegisteredType* ctx_registry_resolve_alias(const CtxTypeRegistry* reg, const char* type_qn) {
    if (!reg || !type_qn) return NULL;
    const CtxRegisteredType* rt = ctx_registry_lookup_type(reg, type_qn);
    for (int i = 0; i < 16 && rt && rt->alias_of; i++) {
        const CtxRegisteredType* next = ctx_registry_lookup_type(reg, rt->alias_of);
        if (!next) return rt;
        rt = next;
    }
    return rt;
}

const CtxRegisteredFunc* ctx_registry_lookup_method_aliased(const CtxTypeRegistry* reg,
    const char* receiver_qn, const char* method_name) {
    if (!reg || !receiver_qn || !method_name) return NULL;

    // Direct lookup first
    const CtxRegisteredFunc* f = ctx_registry_lookup_method(reg, receiver_qn, method_name);
    if (f) return f;

    // Follow alias chain
    const CtxRegisteredType* rt = ctx_registry_lookup_type(reg, receiver_qn);
    for (int i = 0; i < 16 && rt && rt->alias_of; i++) {
        f = ctx_registry_lookup_method(reg, rt->alias_of, method_name);
        if (f) return f;
        rt = ctx_registry_lookup_type(reg, rt->alias_of);
    }
    return NULL;
}

const CtxRegisteredFunc* ctx_registry_lookup_symbol(const CtxTypeRegistry* reg,
    const char* package_qn, const char* name) {
    if (!reg || !package_qn || !name) return NULL;

    // Build expected QN: package_qn.name
    size_t pkg_len = strlen(package_qn);
    size_t name_len = strlen(name);
    size_t total_len = pkg_len + 1 + name_len;

    char buf[512];
    if (total_len >= sizeof(buf)) return NULL;

    memcpy(buf, package_qn, pkg_len);
    buf[pkg_len] = '.';
    memcpy(buf + pkg_len + 1, name, name_len);
    buf[total_len] = '\0';

    return ctx_registry_lookup_func(reg, buf);
}

// Count parameters in a FUNC signature.
static int count_func_params(const CtxRegisteredFunc* f) {
    if (!f || !f->signature || f->signature->kind != CTX_TYPE_FUNC) return -1;
    if (!f->signature->data.func.param_types) return 0;
    int count = 0;
    while (f->signature->data.func.param_types[count]) count++;
    return count;
}

const CtxRegisteredFunc* ctx_registry_lookup_method_by_args(const CtxTypeRegistry* reg,
    const char* receiver_qn, const char* method_name, int arg_count) {
    if (!reg || !receiver_qn || !method_name) return NULL;

    const CtxRegisteredFunc* first_match = NULL;
    const CtxRegisteredFunc* range_match = NULL;
    for (int i = 0; i < reg->func_count; i++) {
        const CtxRegisteredFunc* f = &reg->funcs[i];
        if (f->receiver_type && f->short_name &&
            strcmp(f->receiver_type, receiver_qn) == 0 &&
            strcmp(f->short_name, method_name) == 0) {
            if (!first_match) first_match = f;
            int pc = count_func_params(f);
            if (pc == arg_count) return f;  // exact match
            // Accept if arg_count is in [min_params, pc] (default args)
            int min_pc = (f->min_params >= 0) ? f->min_params : pc;
            if (!range_match && arg_count >= min_pc && arg_count <= pc) {
                range_match = f;
            }
        }
    }
    return range_match ? range_match : first_match;
}

// --- Overload scoring by parameter type ---

// Unwrap pointer/reference to get the core QN for comparison.
static const char* type_to_qn_simple(const CtxType* t) {
    if (!t) return NULL;
    // Unwrap references and pointers
    while (t) {
        switch (t->kind) {
        case CTX_TYPE_POINTER:   t = t->data.pointer.elem; continue;
        case CTX_TYPE_REFERENCE: t = t->data.reference.elem; continue;
        case CTX_TYPE_RVALUE_REF: t = t->data.reference.elem; continue;
        case CTX_TYPE_NAMED:     return t->data.named.qualified_name;
        case CTX_TYPE_TEMPLATE:  return t->data.template_type.template_name;
        case CTX_TYPE_BUILTIN:   return t->data.builtin.name;
        default: return NULL;
        }
    }
    return NULL;
}

// Check if two types are compatible via implicit conversion.
static bool c_types_compatible(const char* expected_qn, const char* actual_qn) {
    if (!expected_qn || !actual_qn) return false;
    // const char* / char* -> std::string, std::string_view
    if (strcmp(actual_qn, "char") == 0) {
        if (strcmp(expected_qn, "std.string") == 0 ||
            strcmp(expected_qn, "std.basic_string") == 0 ||
            strcmp(expected_qn, "std.string_view") == 0 ||
            strcmp(expected_qn, "std.basic_string_view") == 0 ||
            strcmp(expected_qn, "absl.string_view") == 0) return true;
    }
    // Numeric promotions: all numeric builtins are interconvertible
    static const char* numerics[] = {"int", "long", "short", "float", "double",
        "unsigned", "size_t", "int8_t", "int16_t", "int32_t", "int64_t",
        "uint8_t", "uint16_t", "uint32_t", "uint64_t", "ptrdiff_t", NULL};
    bool exp_numeric = false, act_numeric = false;
    for (int i = 0; numerics[i]; i++) {
        if (strcmp(expected_qn, numerics[i]) == 0) exp_numeric = true;
        if (strcmp(actual_qn, numerics[i]) == 0) act_numeric = true;
    }
    if (exp_numeric && act_numeric) return true;
    // bool <-> int
    if ((strcmp(expected_qn, "bool") == 0 && act_numeric) ||
        (exp_numeric && strcmp(actual_qn, "bool") == 0)) return true;
    return false;
}

// Score an overload match: higher = better. 0 = wrong arg count (no match).
static int score_overload_match(const CtxRegisteredFunc* f, const CtxType** arg_types, int arg_count) {
    int pc = count_func_params(f);
    int min_pc = (f->min_params >= 0) ? f->min_params : pc;
    if (arg_count < min_pc || arg_count > pc) return 0;  // out of range
    if (!arg_types || !f->signature || !f->signature->data.func.param_types) return 50;
    int score = 50;
    for (int i = 0; i < arg_count; i++) {
        const CtxType* expected = f->signature->data.func.param_types[i];
        const CtxType* actual = arg_types[i];
        if (!expected || !actual || ctx_type_is_unknown(actual)) continue; // neutral
        const char* exp_qn = type_to_qn_simple(expected);
        const char* act_qn = type_to_qn_simple(actual);
        if (!exp_qn || !act_qn) continue;
        if (strcmp(exp_qn, act_qn) == 0) {
            score += 10; // exact type match
        } else if (c_types_compatible(exp_qn, act_qn)) {
            score += 5;  // implicit conversion
        }
    }
    return score;
}

const CtxRegisteredFunc* ctx_registry_lookup_method_by_types(const CtxTypeRegistry* reg,
    const char* receiver_qn, const char* method_name,
    const CtxType** arg_types, int arg_count) {
    if (!reg || !receiver_qn || !method_name) return NULL;
    // If no type info, fall back to arg-count matching
    if (!arg_types) return ctx_registry_lookup_method_by_args(reg, receiver_qn, method_name, arg_count);

    const CtxRegisteredFunc* best = NULL;
    int best_score = 0;
    const CtxRegisteredFunc* first_match = NULL;

    for (int i = 0; i < reg->func_count; i++) {
        const CtxRegisteredFunc* f = &reg->funcs[i];
        if (f->receiver_type && f->short_name &&
            strcmp(f->receiver_type, receiver_qn) == 0 &&
            strcmp(f->short_name, method_name) == 0) {
            if (!first_match) first_match = f;
            int s = score_overload_match(f, arg_types, arg_count);
            if (s > best_score) { best_score = s; best = f; }
        }
    }
    return best ? best : first_match;
}

const CtxRegisteredFunc* ctx_registry_lookup_symbol_by_types(const CtxTypeRegistry* reg,
    const char* package_qn, const char* name,
    const CtxType** arg_types, int arg_count) {
    if (!reg || !package_qn || !name) return NULL;
    if (!arg_types) return ctx_registry_lookup_symbol_by_args(reg, package_qn, name, arg_count);

    size_t pkg_len = strlen(package_qn);
    size_t name_len = strlen(name);
    size_t total_len = pkg_len + 1 + name_len;
    char buf[512];
    if (total_len >= sizeof(buf)) return NULL;
    memcpy(buf, package_qn, pkg_len);
    buf[pkg_len] = '.';
    memcpy(buf + pkg_len + 1, name, name_len);
    buf[total_len] = '\0';

    const CtxRegisteredFunc* best = NULL;
    int best_score = 0;
    const CtxRegisteredFunc* first_match = NULL;

    for (int i = 0; i < reg->func_count; i++) {
        const CtxRegisteredFunc* f = &reg->funcs[i];
        if (strcmp(f->qualified_name, buf) == 0) {
            if (!first_match) first_match = f;
            int s = score_overload_match(f, arg_types, arg_count);
            if (s > best_score) { best_score = s; best = f; }
        }
    }
    return best ? best : first_match;
}

const CtxRegisteredFunc* ctx_registry_lookup_symbol_by_args(const CtxTypeRegistry* reg,
    const char* package_qn, const char* name, int arg_count) {
    if (!reg || !package_qn || !name) return NULL;

    size_t pkg_len = strlen(package_qn);
    size_t name_len = strlen(name);
    size_t total_len = pkg_len + 1 + name_len;
    char buf[512];
    if (total_len >= sizeof(buf)) return NULL;
    memcpy(buf, package_qn, pkg_len);
    buf[pkg_len] = '.';
    memcpy(buf + pkg_len + 1, name, name_len);
    buf[total_len] = '\0';

    const CtxRegisteredFunc* first_match = NULL;
    const CtxRegisteredFunc* range_match = NULL;
    for (int i = 0; i < reg->func_count; i++) {
        const CtxRegisteredFunc* f = &reg->funcs[i];
        if (strcmp(f->qualified_name, buf) == 0) {
            if (!first_match) first_match = f;
            int pc = count_func_params(f);
            if (pc == arg_count) return f;
            int min_pc = (f->min_params >= 0) ? f->min_params : pc;
            if (!range_match && arg_count >= min_pc && arg_count <= pc) {
                range_match = f;
            }
        }
    }
    return range_match ? range_match : first_match;
}

#include "type_registry.h"
#include <string.h>
#include <stdlib.h>

void cbm_registry_init(CBMTypeRegistry* reg, CBMArena* arena) {
    memset(reg, 0, sizeof(CBMTypeRegistry));
    reg->arena = arena;
}

void cbm_registry_add_func(CBMTypeRegistry* reg, CBMRegisteredFunc func) {
    if (reg->func_count >= reg->func_cap) {
        int new_cap = reg->func_cap == 0 ? 64 : reg->func_cap * 2;
        CBMRegisteredFunc* new_items = (CBMRegisteredFunc*)cbm_arena_alloc(reg->arena,
            (size_t)new_cap * sizeof(CBMRegisteredFunc));
        if (!new_items) return;
        if (reg->funcs && reg->func_count > 0) {
            memcpy(new_items, reg->funcs, (size_t)reg->func_count * sizeof(CBMRegisteredFunc));
        }
        reg->funcs = new_items;
        reg->func_cap = new_cap;
    }
    reg->funcs[reg->func_count++] = func;
}

void cbm_registry_add_type(CBMTypeRegistry* reg, CBMRegisteredType type) {
    if (reg->type_count >= reg->type_cap) {
        int new_cap = reg->type_cap == 0 ? 64 : reg->type_cap * 2;
        CBMRegisteredType* new_items = (CBMRegisteredType*)cbm_arena_alloc(reg->arena,
            (size_t)new_cap * sizeof(CBMRegisteredType));
        if (!new_items) return;
        if (reg->types && reg->type_count > 0) {
            memcpy(new_items, reg->types, (size_t)reg->type_count * sizeof(CBMRegisteredType));
        }
        reg->types = new_items;
        reg->type_cap = new_cap;
    }
    reg->types[reg->type_count++] = type;
}

const CBMRegisteredFunc* cbm_registry_lookup_method(const CBMTypeRegistry* reg,
    const char* receiver_qn, const char* method_name) {
    if (!reg || !receiver_qn || !method_name) return NULL;

    for (int i = 0; i < reg->func_count; i++) {
        const CBMRegisteredFunc* f = &reg->funcs[i];
        if (f->receiver_type && f->short_name &&
            strcmp(f->receiver_type, receiver_qn) == 0 &&
            strcmp(f->short_name, method_name) == 0) {
            return f;
        }
    }
    return NULL;
}

const CBMRegisteredType* cbm_registry_lookup_type(const CBMTypeRegistry* reg,
    const char* qualified_name) {
    if (!reg || !qualified_name) return NULL;

    for (int i = 0; i < reg->type_count; i++) {
        if (strcmp(reg->types[i].qualified_name, qualified_name) == 0) {
            return &reg->types[i];
        }
    }
    return NULL;
}

const CBMRegisteredFunc* cbm_registry_lookup_func(const CBMTypeRegistry* reg,
    const char* qualified_name) {
    if (!reg || !qualified_name) return NULL;

    for (int i = 0; i < reg->func_count; i++) {
        if (strcmp(reg->funcs[i].qualified_name, qualified_name) == 0) {
            return &reg->funcs[i];
        }
    }
    return NULL;
}

const CBMRegisteredType* cbm_registry_resolve_alias(const CBMTypeRegistry* reg, const char* type_qn) {
    if (!reg || !type_qn) return NULL;
    const CBMRegisteredType* rt = cbm_registry_lookup_type(reg, type_qn);
    for (int i = 0; i < 16 && rt && rt->alias_of; i++) {
        const CBMRegisteredType* next = cbm_registry_lookup_type(reg, rt->alias_of);
        if (!next) return rt;
        rt = next;
    }
    return rt;
}

const CBMRegisteredFunc* cbm_registry_lookup_method_aliased(const CBMTypeRegistry* reg,
    const char* receiver_qn, const char* method_name) {
    if (!reg || !receiver_qn || !method_name) return NULL;

    // Direct lookup first
    const CBMRegisteredFunc* f = cbm_registry_lookup_method(reg, receiver_qn, method_name);
    if (f) return f;

    // Follow alias chain
    const CBMRegisteredType* rt = cbm_registry_lookup_type(reg, receiver_qn);
    for (int i = 0; i < 16 && rt && rt->alias_of; i++) {
        f = cbm_registry_lookup_method(reg, rt->alias_of, method_name);
        if (f) return f;
        rt = cbm_registry_lookup_type(reg, rt->alias_of);
    }
    return NULL;
}

const CBMRegisteredFunc* cbm_registry_lookup_symbol(const CBMTypeRegistry* reg,
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

    return cbm_registry_lookup_func(reg, buf);
}

// Count parameters in a FUNC signature.
static int count_func_params(const CBMRegisteredFunc* f) {
    if (!f || !f->signature || f->signature->kind != CBM_TYPE_FUNC) return -1;
    if (!f->signature->data.func.param_types) return 0;
    int count = 0;
    while (f->signature->data.func.param_types[count]) count++;
    return count;
}

const CBMRegisteredFunc* cbm_registry_lookup_method_by_args(const CBMTypeRegistry* reg,
    const char* receiver_qn, const char* method_name, int arg_count) {
    if (!reg || !receiver_qn || !method_name) return NULL;

    const CBMRegisteredFunc* first_match = NULL;
    for (int i = 0; i < reg->func_count; i++) {
        const CBMRegisteredFunc* f = &reg->funcs[i];
        if (f->receiver_type && f->short_name &&
            strcmp(f->receiver_type, receiver_qn) == 0 &&
            strcmp(f->short_name, method_name) == 0) {
            if (!first_match) first_match = f;
            int pc = count_func_params(f);
            if (pc == arg_count) return f;  // exact match
        }
    }
    return first_match;  // fallback to first match
}

// --- Overload scoring by parameter type ---

// Unwrap pointer/reference to get the core QN for comparison.
static const char* type_to_qn_simple(const CBMType* t) {
    if (!t) return NULL;
    // Unwrap references and pointers
    while (t) {
        switch (t->kind) {
        case CBM_TYPE_POINTER:   t = t->data.pointer.elem; continue;
        case CBM_TYPE_REFERENCE: t = t->data.reference.elem; continue;
        case CBM_TYPE_RVALUE_REF: t = t->data.reference.elem; continue;
        case CBM_TYPE_NAMED:     return t->data.named.qualified_name;
        case CBM_TYPE_TEMPLATE:  return t->data.template_type.template_name;
        case CBM_TYPE_BUILTIN:   return t->data.builtin.name;
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
static int score_overload_match(const CBMRegisteredFunc* f, const CBMType** arg_types, int arg_count) {
    int pc = count_func_params(f);
    if (pc != arg_count) return 0;  // wrong count = no match
    if (!arg_types || !f->signature || !f->signature->data.func.param_types) return 50;
    int score = 50;
    for (int i = 0; i < arg_count; i++) {
        const CBMType* expected = f->signature->data.func.param_types[i];
        const CBMType* actual = arg_types[i];
        if (!expected || !actual || cbm_type_is_unknown(actual)) continue; // neutral
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

const CBMRegisteredFunc* cbm_registry_lookup_method_by_types(const CBMTypeRegistry* reg,
    const char* receiver_qn, const char* method_name,
    const CBMType** arg_types, int arg_count) {
    if (!reg || !receiver_qn || !method_name) return NULL;
    // If no type info, fall back to arg-count matching
    if (!arg_types) return cbm_registry_lookup_method_by_args(reg, receiver_qn, method_name, arg_count);

    const CBMRegisteredFunc* best = NULL;
    int best_score = 0;
    const CBMRegisteredFunc* first_match = NULL;

    for (int i = 0; i < reg->func_count; i++) {
        const CBMRegisteredFunc* f = &reg->funcs[i];
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

const CBMRegisteredFunc* cbm_registry_lookup_symbol_by_types(const CBMTypeRegistry* reg,
    const char* package_qn, const char* name,
    const CBMType** arg_types, int arg_count) {
    if (!reg || !package_qn || !name) return NULL;
    if (!arg_types) return cbm_registry_lookup_symbol_by_args(reg, package_qn, name, arg_count);

    size_t pkg_len = strlen(package_qn);
    size_t name_len = strlen(name);
    size_t total_len = pkg_len + 1 + name_len;
    char buf[512];
    if (total_len >= sizeof(buf)) return NULL;
    memcpy(buf, package_qn, pkg_len);
    buf[pkg_len] = '.';
    memcpy(buf + pkg_len + 1, name, name_len);
    buf[total_len] = '\0';

    const CBMRegisteredFunc* best = NULL;
    int best_score = 0;
    const CBMRegisteredFunc* first_match = NULL;

    for (int i = 0; i < reg->func_count; i++) {
        const CBMRegisteredFunc* f = &reg->funcs[i];
        if (strcmp(f->qualified_name, buf) == 0) {
            if (!first_match) first_match = f;
            int s = score_overload_match(f, arg_types, arg_count);
            if (s > best_score) { best_score = s; best = f; }
        }
    }
    return best ? best : first_match;
}

const CBMRegisteredFunc* cbm_registry_lookup_symbol_by_args(const CBMTypeRegistry* reg,
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

    const CBMRegisteredFunc* first_match = NULL;
    for (int i = 0; i < reg->func_count; i++) {
        const CBMRegisteredFunc* f = &reg->funcs[i];
        if (strcmp(f->qualified_name, buf) == 0) {
            if (!first_match) first_match = f;
            int pc = count_func_params(f);
            if (pc == arg_count) return f;
        }
    }
    return first_match;
}

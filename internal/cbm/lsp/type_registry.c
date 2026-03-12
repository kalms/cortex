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

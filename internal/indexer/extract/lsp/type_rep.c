#include "type_rep.h"
#include <stdint.h>
#include <string.h>

// Singleton UNKNOWN type (no allocation needed).
static const CtxType unknown_singleton = { .kind = CTX_TYPE_UNKNOWN };

const CtxType* ctx_type_unknown(void) {
    return &unknown_singleton;
}

const CtxType* ctx_type_named(CtxArena* a, const char* qualified_name) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_NAMED;
    t->data.named.qualified_name = ctx_arena_strdup(a, qualified_name);
    return t;
}

const CtxType* ctx_type_pointer(CtxArena* a, const CtxType* elem) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_POINTER;
    t->data.pointer.elem = elem;
    return t;
}

const CtxType* ctx_type_slice(CtxArena* a, const CtxType* elem) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_SLICE;
    t->data.slice.elem = elem;
    return t;
}

const CtxType* ctx_type_map(CtxArena* a, const CtxType* key, const CtxType* value) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_MAP;
    t->data.map.key = key;
    t->data.map.value = value;
    return t;
}

const CtxType* ctx_type_channel(CtxArena* a, const CtxType* elem, int direction) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_CHANNEL;
    t->data.channel.elem = elem;
    t->data.channel.direction = direction;
    return t;
}

const CtxType* ctx_type_func(CtxArena* a, const char** param_names,
                              const CtxType** param_types, const CtxType** return_types) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_FUNC;

    // Copy all arrays into arena memory to avoid dangling stack pointers.
    if (return_types) {
        int count = 0;
        while (return_types[count]) count++;
        const CtxType** arr = (const CtxType**)ctx_arena_alloc(a, (count + 1) * sizeof(const CtxType*));
        if (arr) {
            for (int i = 0; i < count; i++) arr[i] = return_types[i];
            arr[count] = NULL;
            t->data.func.return_types = arr;
        }
    }
    if (param_types) {
        int count = 0;
        while (param_types[count]) count++;
        const CtxType** arr = (const CtxType**)ctx_arena_alloc(a, (count + 1) * sizeof(const CtxType*));
        if (arr) {
            for (int i = 0; i < count; i++) arr[i] = param_types[i];
            arr[count] = NULL;
            t->data.func.param_types = arr;
        }
    }
    if (param_names) {
        int count = 0;
        while (param_names[count]) count++;
        const char** arr = (const char**)ctx_arena_alloc(a, (count + 1) * sizeof(const char*));
        if (arr) {
            for (int i = 0; i < count; i++) arr[i] = param_names[i];
            arr[count] = NULL;
            t->data.func.param_names = arr;
        }
    }
    return t;
}

const CtxType* ctx_type_builtin(CtxArena* a, const char* name) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_BUILTIN;
    t->data.builtin.name = ctx_arena_strdup(a, name);
    return t;
}

const CtxType* ctx_type_tuple(CtxArena* a, const CtxType** elems, int count) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_TUPLE;
    // Copy elems array
    const CtxType** arr = (const CtxType**)ctx_arena_alloc(a, (count + 1) * sizeof(const CtxType*));
    if (!arr) return &unknown_singleton;
    for (int i = 0; i < count; i++) arr[i] = elems[i];
    arr[count] = NULL;
    t->data.tuple.elems = arr;
    t->data.tuple.count = count;
    return t;
}

const CtxType* ctx_type_type_param(CtxArena* a, const char* name) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_TYPE_PARAM;
    t->data.type_param.name = ctx_arena_strdup(a, name);
    return t;
}

const CtxType* ctx_type_reference(CtxArena* a, const CtxType* elem) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_REFERENCE;
    t->data.reference.elem = elem;
    return t;
}

const CtxType* ctx_type_rvalue_ref(CtxArena* a, const CtxType* elem) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_RVALUE_REF;
    t->data.reference.elem = elem;
    return t;
}

const CtxType* ctx_type_template(CtxArena* a, const char* name, const CtxType** args, int arg_count) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_TEMPLATE;
    t->data.template_type.template_name = ctx_arena_strdup(a, name);
    if (args && arg_count > 0) {
        const CtxType** arr = (const CtxType**)ctx_arena_alloc(a, (arg_count + 1) * sizeof(const CtxType*));
        if (arr) {
            for (int i = 0; i < arg_count; i++) arr[i] = args[i];
            arr[arg_count] = NULL;
            t->data.template_type.template_args = arr;
        }
    }
    t->data.template_type.arg_count = arg_count;
    return t;
}

const CtxType* ctx_type_alias(CtxArena* a, const char* alias_qn, const CtxType* underlying) {
    CtxType* t = (CtxType*)ctx_arena_alloc(a, sizeof(CtxType));
    if (!t) return &unknown_singleton;
    memset(t, 0, sizeof(CtxType));
    t->kind = CTX_TYPE_ALIAS;
    t->data.alias.alias_qn = ctx_arena_strdup(a, alias_qn);
    t->data.alias.underlying = underlying;
    return t;
}

// Operations

const CtxType* ctx_type_deref(const CtxType* t) {
    if (!t) return t;
    // Unwrap references transparently (C++ member access through refs)
    if (t->kind == CTX_TYPE_REFERENCE || t->kind == CTX_TYPE_RVALUE_REF)
        return t->data.reference.elem;
    if (t->kind != CTX_TYPE_POINTER) return t;
    return t->data.pointer.elem;
}

const CtxType* ctx_type_elem(const CtxType* t) {
    if (!t) return ctx_type_unknown();
    switch (t->kind) {
    case CTX_TYPE_POINTER:   return t->data.pointer.elem;
    case CTX_TYPE_SLICE:     return t->data.slice.elem;
    case CTX_TYPE_CHANNEL:   return t->data.channel.elem;
    case CTX_TYPE_REFERENCE: return t->data.reference.elem;
    case CTX_TYPE_RVALUE_REF: return t->data.reference.elem;
    default: return ctx_type_unknown();
    }
}

bool ctx_type_is_unknown(const CtxType* t) {
    if (!t) return true;
    /* Guard against dangling pointers from stale field_types entries.
     * Check alignment before dereferencing — misaligned pointer means garbage. */
    if (((uintptr_t)t & (_Alignof(CtxType) - 1)) != 0) return true;
    return t->kind == CTX_TYPE_UNKNOWN;
}

bool ctx_type_is_interface(const CtxType* t) {
    return t && t->kind == CTX_TYPE_INTERFACE;
}

bool ctx_type_is_pointer(const CtxType* t) {
    return t && t->kind == CTX_TYPE_POINTER;
}

bool ctx_type_is_reference(const CtxType* t) {
    return t && (t->kind == CTX_TYPE_REFERENCE || t->kind == CTX_TYPE_RVALUE_REF);
}

const CtxType* ctx_type_resolve_alias(const CtxType* t) {
    for (int i = 0; i < 16 && t; i++) {
        if (t->kind != CTX_TYPE_ALIAS) return t;
        if (!t->data.alias.underlying) return t;
        t = t->data.alias.underlying;
    }
    return t;
}

// Generic substitution: recursively replace TYPE_PARAM with concrete types.
const CtxType* ctx_type_substitute(CtxArena* a, const CtxType* t,
    const char** type_params, const CtxType** type_args) {
    if (!t) return ctx_type_unknown();
    if (!type_params || !type_args) return t;

    switch (t->kind) {
    case CTX_TYPE_TYPE_PARAM: {
        for (int i = 0; type_params[i]; i++) {
            if (strcmp(t->data.type_param.name, type_params[i]) == 0) {
                return type_args[i];
            }
        }
        return t; // unmatched param stays as-is
    }
    case CTX_TYPE_NAMED: {
        // Also substitute NAMED types matching template param names.
        // c_parse_return_type_text may parse "A" as NAMED("test.main.A")
        // instead of TYPE_PARAM("A") — check both full QN and short name.
        const char* qn = t->data.named.qualified_name;
        if (qn) {
            const char* short_name = strrchr(qn, '.');
            short_name = short_name ? short_name + 1 : qn;
            for (int i = 0; type_params[i]; i++) {
                if (strcmp(qn, type_params[i]) == 0 ||
                    strcmp(short_name, type_params[i]) == 0) {
                    return type_args[i];
                }
            }
        }
        return t;
    }
    case CTX_TYPE_POINTER:
        return ctx_type_pointer(a, ctx_type_substitute(a, t->data.pointer.elem, type_params, type_args));
    case CTX_TYPE_REFERENCE:
        return ctx_type_reference(a, ctx_type_substitute(a, t->data.reference.elem, type_params, type_args));
    case CTX_TYPE_RVALUE_REF:
        return ctx_type_rvalue_ref(a, ctx_type_substitute(a, t->data.reference.elem, type_params, type_args));
    case CTX_TYPE_SLICE:
        return ctx_type_slice(a, ctx_type_substitute(a, t->data.slice.elem, type_params, type_args));
    case CTX_TYPE_MAP:
        return ctx_type_map(a,
            ctx_type_substitute(a, t->data.map.key, type_params, type_args),
            ctx_type_substitute(a, t->data.map.value, type_params, type_args));
    case CTX_TYPE_CHANNEL:
        return ctx_type_channel(a, ctx_type_substitute(a, t->data.channel.elem, type_params, type_args), t->data.channel.direction);
    case CTX_TYPE_TUPLE: {
        int count = t->data.tuple.count;
        const CtxType** elems = (const CtxType**)ctx_arena_alloc(a, (count + 1) * sizeof(const CtxType*));
        if (!elems) return t;
        for (int i = 0; i < count; i++) {
            elems[i] = ctx_type_substitute(a, t->data.tuple.elems[i], type_params, type_args);
        }
        elems[count] = NULL;
        return ctx_type_tuple(a, elems, count);
    }
    default:
        return t; // NAMED, BUILTIN, FUNC, etc. — no type params to substitute
    }
}

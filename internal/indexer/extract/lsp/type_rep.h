#ifndef CTX_LSP_TYPE_REP_H
#define CTX_LSP_TYPE_REP_H

#include "../arena.h"
#include <stdbool.h>
#include <stdint.h>

// CtxTypeKind enumerates all type representations.
typedef enum {
    CTX_TYPE_UNKNOWN = 0,
    CTX_TYPE_NAMED,       // named type: "Database", "http.Request"
    CTX_TYPE_POINTER,     // *T
    CTX_TYPE_SLICE,       // []T
    CTX_TYPE_MAP,         // map[K]V
    CTX_TYPE_CHANNEL,     // chan T
    CTX_TYPE_FUNC,        // func(params) returns
    CTX_TYPE_INTERFACE,   // interface{...}
    CTX_TYPE_STRUCT,      // struct{...}
    CTX_TYPE_BUILTIN,     // int, string, bool, error, etc.
    CTX_TYPE_TUPLE,       // multi-return (T1, T2)
    CTX_TYPE_TYPE_PARAM,  // generic type parameter: T, K, V
    CTX_TYPE_REFERENCE,   // T& (C++ lvalue reference)
    CTX_TYPE_RVALUE_REF,  // T&& (C++ rvalue reference)
    CTX_TYPE_TEMPLATE,    // Parameterized type: vector<T> — stores template name + args
    CTX_TYPE_ALIAS,       // Type alias: using/typedef — stores alias name + underlying type
} CtxTypeKind;

// Forward declaration
typedef struct CtxType CtxType;

// CtxTypeParam represents a generic type parameter with optional constraint.
typedef struct {
    const char* name;        // "T", "K", "V"
    const CtxType* constraint; // interface constraint, or NULL for "any"
} CtxTypeParam;

// CtxType is a tagged union representing Go types.
struct CtxType {
    CtxTypeKind kind;
    union {
        struct { const char* qualified_name; } named;      // NAMED
        struct { const CtxType* elem; } pointer;            // POINTER
        struct { const CtxType* elem; } slice;              // SLICE
        struct { const CtxType* key; const CtxType* value; } map;  // MAP
        struct { const CtxType* elem; int direction; } channel;    // CHANNEL (0=bidi, 1=send, 2=recv)
        struct {
            const char** param_names;  // NULL-terminated
            const CtxType** param_types; // NULL-terminated
            const CtxType** return_types; // NULL-terminated
        } func;                                             // FUNC
        struct {
            const char** method_names;  // NULL-terminated
            const CtxType** method_sigs; // NULL-terminated (each is FUNC)
        } interface_type;                                   // INTERFACE
        struct {
            const char** field_names;   // NULL-terminated
            const CtxType** field_types; // NULL-terminated
        } struct_type;                                      // STRUCT
        struct { const char* name; } builtin;               // BUILTIN
        struct {
            const CtxType** elems;      // NULL-terminated
            int count;
        } tuple;                                            // TUPLE
        struct { const char* name; } type_param;            // TYPE_PARAM
        struct { const CtxType* elem; } reference;            // REFERENCE / RVALUE_REF
        struct {
            const char* template_name;      // "std::vector", "std::map"
            const CtxType** template_args;  // NULL-terminated
            int arg_count;
        } template_type;                                      // TEMPLATE
        struct {
            const char* alias_qn;          // "proj.ns.MyAlias"
            const CtxType* underlying;     // the actual type it aliases
        } alias;                                              // ALIAS
    } data;
};

// Constructors (arena-allocated)
const CtxType* ctx_type_unknown(void);
const CtxType* ctx_type_named(CtxArena* a, const char* qualified_name);
const CtxType* ctx_type_pointer(CtxArena* a, const CtxType* elem);
const CtxType* ctx_type_slice(CtxArena* a, const CtxType* elem);
const CtxType* ctx_type_map(CtxArena* a, const CtxType* key, const CtxType* value);
const CtxType* ctx_type_channel(CtxArena* a, const CtxType* elem, int direction);
const CtxType* ctx_type_func(CtxArena* a, const char** param_names, const CtxType** param_types, const CtxType** return_types);
const CtxType* ctx_type_builtin(CtxArena* a, const char* name);
const CtxType* ctx_type_tuple(CtxArena* a, const CtxType** elems, int count);
const CtxType* ctx_type_type_param(CtxArena* a, const char* name);
const CtxType* ctx_type_reference(CtxArena* a, const CtxType* elem);
const CtxType* ctx_type_rvalue_ref(CtxArena* a, const CtxType* elem);
const CtxType* ctx_type_template(CtxArena* a, const char* name, const CtxType** args, int arg_count);
const CtxType* ctx_type_alias(CtxArena* a, const char* alias_qn, const CtxType* underlying);

// Operations
const CtxType* ctx_type_deref(const CtxType* t);         // remove one pointer level
const CtxType* ctx_type_elem(const CtxType* t);           // get element type (slice/chan/pointer)
bool ctx_type_is_unknown(const CtxType* t);
bool ctx_type_is_interface(const CtxType* t);
bool ctx_type_is_pointer(const CtxType* t);
bool ctx_type_is_reference(const CtxType* t);

// Follow alias chain with cycle detection (max 16 levels).
const CtxType* ctx_type_resolve_alias(const CtxType* t);

// Generic type substitution: replace type params in t with concrete types.
// type_params: NULL-terminated array of param names
// type_args: corresponding concrete types
const CtxType* ctx_type_substitute(CtxArena* a, const CtxType* t,
    const char** type_params, const CtxType** type_args);

#endif // CTX_LSP_TYPE_REP_H

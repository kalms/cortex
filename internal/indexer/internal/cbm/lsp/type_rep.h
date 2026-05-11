#ifndef CBM_LSP_TYPE_REP_H
#define CBM_LSP_TYPE_REP_H

#include "../arena.h"
#include <stdbool.h>
#include <stdint.h>

// CBMTypeKind enumerates all type representations.
typedef enum {
    CBM_TYPE_UNKNOWN = 0,
    CBM_TYPE_NAMED,       // named type: "Database", "http.Request"
    CBM_TYPE_POINTER,     // *T
    CBM_TYPE_SLICE,       // []T
    CBM_TYPE_MAP,         // map[K]V
    CBM_TYPE_CHANNEL,     // chan T
    CBM_TYPE_FUNC,        // func(params) returns
    CBM_TYPE_INTERFACE,   // interface{...}
    CBM_TYPE_STRUCT,      // struct{...}
    CBM_TYPE_BUILTIN,     // int, string, bool, error, etc.
    CBM_TYPE_TUPLE,       // multi-return (T1, T2)
    CBM_TYPE_TYPE_PARAM,  // generic type parameter: T, K, V
    CBM_TYPE_REFERENCE,   // T& (C++ lvalue reference)
    CBM_TYPE_RVALUE_REF,  // T&& (C++ rvalue reference)
    CBM_TYPE_TEMPLATE,    // Parameterized type: vector<T> — stores template name + args
    CBM_TYPE_ALIAS,       // Type alias: using/typedef — stores alias name + underlying type
} CBMTypeKind;

// Forward declaration
typedef struct CBMType CBMType;

// CBMTypeParam represents a generic type parameter with optional constraint.
typedef struct {
    const char* name;        // "T", "K", "V"
    const CBMType* constraint; // interface constraint, or NULL for "any"
} CBMTypeParam;

// CBMType is a tagged union representing Go types.
struct CBMType {
    CBMTypeKind kind;
    union {
        struct { const char* qualified_name; } named;      // NAMED
        struct { const CBMType* elem; } pointer;            // POINTER
        struct { const CBMType* elem; } slice;              // SLICE
        struct { const CBMType* key; const CBMType* value; } map;  // MAP
        struct { const CBMType* elem; int direction; } channel;    // CHANNEL (0=bidi, 1=send, 2=recv)
        struct {
            const char** param_names;  // NULL-terminated
            const CBMType** param_types; // NULL-terminated
            const CBMType** return_types; // NULL-terminated
        } func;                                             // FUNC
        struct {
            const char** method_names;  // NULL-terminated
            const CBMType** method_sigs; // NULL-terminated (each is FUNC)
        } interface_type;                                   // INTERFACE
        struct {
            const char** field_names;   // NULL-terminated
            const CBMType** field_types; // NULL-terminated
        } struct_type;                                      // STRUCT
        struct { const char* name; } builtin;               // BUILTIN
        struct {
            const CBMType** elems;      // NULL-terminated
            int count;
        } tuple;                                            // TUPLE
        struct { const char* name; } type_param;            // TYPE_PARAM
        struct { const CBMType* elem; } reference;            // REFERENCE / RVALUE_REF
        struct {
            const char* template_name;      // "std::vector", "std::map"
            const CBMType** template_args;  // NULL-terminated
            int arg_count;
        } template_type;                                      // TEMPLATE
        struct {
            const char* alias_qn;          // "proj.ns.MyAlias"
            const CBMType* underlying;     // the actual type it aliases
        } alias;                                              // ALIAS
    } data;
};

// Constructors (arena-allocated)
const CBMType* cbm_type_unknown(void);
const CBMType* cbm_type_named(CBMArena* a, const char* qualified_name);
const CBMType* cbm_type_pointer(CBMArena* a, const CBMType* elem);
const CBMType* cbm_type_slice(CBMArena* a, const CBMType* elem);
const CBMType* cbm_type_map(CBMArena* a, const CBMType* key, const CBMType* value);
const CBMType* cbm_type_channel(CBMArena* a, const CBMType* elem, int direction);
const CBMType* cbm_type_func(CBMArena* a, const char** param_names, const CBMType** param_types, const CBMType** return_types);
const CBMType* cbm_type_builtin(CBMArena* a, const char* name);
const CBMType* cbm_type_tuple(CBMArena* a, const CBMType** elems, int count);
const CBMType* cbm_type_type_param(CBMArena* a, const char* name);
const CBMType* cbm_type_reference(CBMArena* a, const CBMType* elem);
const CBMType* cbm_type_rvalue_ref(CBMArena* a, const CBMType* elem);
const CBMType* cbm_type_template(CBMArena* a, const char* name, const CBMType** args, int arg_count);
const CBMType* cbm_type_alias(CBMArena* a, const char* alias_qn, const CBMType* underlying);

// Operations
const CBMType* cbm_type_deref(const CBMType* t);         // remove one pointer level
const CBMType* cbm_type_elem(const CBMType* t);           // get element type (slice/chan/pointer)
bool cbm_type_is_unknown(const CBMType* t);
bool cbm_type_is_interface(const CBMType* t);
bool cbm_type_is_pointer(const CBMType* t);
bool cbm_type_is_reference(const CBMType* t);

// Follow alias chain with cycle detection (max 16 levels).
const CBMType* cbm_type_resolve_alias(const CBMType* t);

// Generic type substitution: replace type params in t with concrete types.
// type_params: NULL-terminated array of param names
// type_args: corresponding concrete types
const CBMType* cbm_type_substitute(CBMArena* a, const CBMType* t,
    const char** type_params, const CBMType** type_args);

#endif // CBM_LSP_TYPE_REP_H

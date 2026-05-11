#ifndef CTX_LSP_TYPE_REGISTRY_H
#define CTX_LSP_TYPE_REGISTRY_H

#include "type_rep.h"
#include "../arena.h"

// Registered function/method with full type signature.
typedef struct {
    const char* qualified_name;  // e.g., "proj.pkg.TypeName.MethodName"
    const char* receiver_type;   // e.g., "proj.pkg.TypeName" (NULL for functions)
    const char* short_name;      // e.g., "MethodName"
    const CtxType* signature;    // FUNC type with param/return types
    const char** type_param_names; // NULL-terminated, e.g., ["T", "R", NULL] for generics
    int min_params;               // Minimum required params (excluding defaulted). -1 = unknown.
} CtxRegisteredFunc;

// Registered type with fields and method names.
typedef struct {
    const char* qualified_name;  // e.g., "proj.pkg.TypeName"
    const char* short_name;      // e.g., "TypeName"
    const char** field_names;    // NULL-terminated
    const CtxType** field_types; // NULL-terminated (parallel to field_names)
    const char** method_names;   // NULL-terminated (short names)
    const char** method_qns;     // NULL-terminated (qualified names, parallel)
    const char** embedded_types; // NULL-terminated (embedded/anonymous field type QNs)
    const char* alias_of;       // QN of aliased type (type Foo = Bar), NULL if not alias
    const char** type_param_names; // NULL-terminated, e.g., ["T", "K", NULL] for template classes
    bool is_interface;
} CtxRegisteredType;

// Cross-file type/function registry.
typedef struct {
    CtxRegisteredFunc* funcs;
    int func_count;
    int func_cap;

    CtxRegisteredType* types;
    int type_count;
    int type_cap;

    CtxArena* arena;  // owns all string data
} CtxTypeRegistry;

// Initialize a registry.
void ctx_registry_init(CtxTypeRegistry* reg, CtxArena* arena);

// Register a function/method.
void ctx_registry_add_func(CtxTypeRegistry* reg, CtxRegisteredFunc func);

// Register a type.
void ctx_registry_add_type(CtxTypeRegistry* reg, CtxRegisteredType type);

// Look up a method by receiver type QN + method name.
const CtxRegisteredFunc* ctx_registry_lookup_method(const CtxTypeRegistry* reg,
    const char* receiver_qn, const char* method_name);

// Look up a type by qualified name.
const CtxRegisteredType* ctx_registry_lookup_type(const CtxTypeRegistry* reg,
    const char* qualified_name);

// Look up a function by qualified name.
const CtxRegisteredFunc* ctx_registry_lookup_func(const CtxTypeRegistry* reg,
    const char* qualified_name);

// Look up a symbol (type or function) in a package by short name.
// package_qn is the package prefix (e.g., "proj.pkg").
const CtxRegisteredFunc* ctx_registry_lookup_symbol(const CtxTypeRegistry* reg,
    const char* package_qn, const char* name);

// Resolve type alias chain: follow alias_of until concrete type found (max 16 levels).
const CtxRegisteredType* ctx_registry_resolve_alias(const CtxTypeRegistry* reg, const char* type_qn);

// Look up a method by receiver type QN + method name, following alias chains.
const CtxRegisteredFunc* ctx_registry_lookup_method_aliased(const CtxTypeRegistry* reg,
    const char* receiver_qn, const char* method_name);

// Look up a method by receiver type + name, preferring the overload with matching arg count.
// Falls back to any match if no exact arg count match found.
const CtxRegisteredFunc* ctx_registry_lookup_method_by_args(const CtxTypeRegistry* reg,
    const char* receiver_qn, const char* method_name, int arg_count);

// Look up a free function by package + name, preferring matching arg count.
const CtxRegisteredFunc* ctx_registry_lookup_symbol_by_args(const CtxTypeRegistry* reg,
    const char* package_qn, const char* name, int arg_count);

// Look up a method by receiver type + name, scoring overloads by parameter type match.
// arg_types may contain NULL entries for unknown types. Falls back to arg-count matching.
const CtxRegisteredFunc* ctx_registry_lookup_method_by_types(const CtxTypeRegistry* reg,
    const char* receiver_qn, const char* method_name,
    const CtxType** arg_types, int arg_count);

// Look up a free function by package + name, scoring overloads by parameter type match.
const CtxRegisteredFunc* ctx_registry_lookup_symbol_by_types(const CtxTypeRegistry* reg,
    const char* package_qn, const char* name,
    const CtxType** arg_types, int arg_count);

#endif // CTX_LSP_TYPE_REGISTRY_H

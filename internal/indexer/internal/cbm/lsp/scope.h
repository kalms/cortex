#ifndef CTX_LSP_SCOPE_H
#define CTX_LSP_SCOPE_H

#include "type_rep.h"
#include "../arena.h"

// Variable binding in a scope.
typedef struct {
    const char* name;
    const CtxType* type;
} CtxVarBinding;

// Lexical scope with variable bindings and parent chain.
#define CTX_SCOPE_MAX_BINDINGS 64

typedef struct CtxScope {
    struct CtxScope* parent;
    CtxVarBinding bindings[CTX_SCOPE_MAX_BINDINGS];
    int count;
} CtxScope;

// Push a new scope (child of current). Returns the new scope.
CtxScope* ctx_scope_push(CtxArena* a, CtxScope* current);

// Pop scope: returns parent. Does NOT free (arena-allocated).
CtxScope* ctx_scope_pop(CtxScope* scope);

// Bind a variable in the current scope.
void ctx_scope_bind(CtxScope* scope, const char* name, const CtxType* type);

// Look up a variable by name, walking the parent chain.
const CtxType* ctx_scope_lookup(const CtxScope* scope, const char* name);

#endif // CTX_LSP_SCOPE_H

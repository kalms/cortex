#ifndef CBM_LSP_SCOPE_H
#define CBM_LSP_SCOPE_H

#include "type_rep.h"
#include "../arena.h"

// Variable binding in a scope.
typedef struct {
    const char* name;
    const CBMType* type;
} CBMVarBinding;

// Lexical scope with variable bindings and parent chain.
#define CBM_SCOPE_MAX_BINDINGS 64

typedef struct CBMScope {
    struct CBMScope* parent;
    CBMVarBinding bindings[CBM_SCOPE_MAX_BINDINGS];
    int count;
} CBMScope;

// Push a new scope (child of current). Returns the new scope.
CBMScope* cbm_scope_push(CBMArena* a, CBMScope* current);

// Pop scope: returns parent. Does NOT free (arena-allocated).
CBMScope* cbm_scope_pop(CBMScope* scope);

// Bind a variable in the current scope.
void cbm_scope_bind(CBMScope* scope, const char* name, const CBMType* type);

// Look up a variable by name, walking the parent chain.
const CBMType* cbm_scope_lookup(const CBMScope* scope, const char* name);

#endif // CBM_LSP_SCOPE_H

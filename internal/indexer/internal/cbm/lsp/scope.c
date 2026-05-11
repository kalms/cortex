#include "scope.h"
#include <string.h>

CBMScope* cbm_scope_push(CBMArena* a, CBMScope* current) {
    CBMScope* scope = (CBMScope*)cbm_arena_alloc(a, sizeof(CBMScope));
    if (!scope) return current;
    memset(scope, 0, sizeof(CBMScope));
    scope->parent = current;
    return scope;
}

CBMScope* cbm_scope_pop(CBMScope* scope) {
    if (!scope) return NULL;
    return scope->parent;
}

void cbm_scope_bind(CBMScope* scope, const char* name, const CBMType* type) {
    if (!scope || !name || scope->count >= CBM_SCOPE_MAX_BINDINGS) return;

    // Overwrite existing binding in same scope if present
    for (int i = 0; i < scope->count; i++) {
        if (strcmp(scope->bindings[i].name, name) == 0) {
            scope->bindings[i].type = type;
            return;
        }
    }

    scope->bindings[scope->count].name = name;
    scope->bindings[scope->count].type = type;
    scope->count++;
}

const CBMType* cbm_scope_lookup(const CBMScope* scope, const char* name) {
    if (!name) return cbm_type_unknown();

    for (const CBMScope* s = scope; s != NULL; s = s->parent) {
        for (int i = 0; i < s->count; i++) {
            if (strcmp(s->bindings[i].name, name) == 0) {
                return s->bindings[i].type;
            }
        }
    }
    return cbm_type_unknown();
}

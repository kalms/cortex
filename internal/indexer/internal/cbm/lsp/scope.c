#include "scope.h"
#include <string.h>

CtxScope* ctx_scope_push(CtxArena* a, CtxScope* current) {
    CtxScope* scope = (CtxScope*)ctx_arena_alloc(a, sizeof(CtxScope));
    if (!scope) return current;
    memset(scope, 0, sizeof(CtxScope));
    scope->parent = current;
    return scope;
}

CtxScope* ctx_scope_pop(CtxScope* scope) {
    if (!scope) return NULL;
    return scope->parent;
}

void ctx_scope_bind(CtxScope* scope, const char* name, const CtxType* type) {
    if (!scope || !name || scope->count >= CTX_SCOPE_MAX_BINDINGS) return;

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

const CtxType* ctx_scope_lookup(const CtxScope* scope, const char* name) {
    if (!name) return ctx_type_unknown();

    for (const CtxScope* s = scope; s != NULL; s = s->parent) {
        for (int i = 0; i < s->count; i++) {
            if (strcmp(s->bindings[i].name, name) == 0) {
                return s->bindings[i].type;
            }
        }
    }
    return ctx_type_unknown();
}

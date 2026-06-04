/*
 * extract_nuxt_routes.h — Derive route path + HTTP method from a Nuxt
 * file-based API route file path.
 *
 * Nuxt uses file-based routing under `server/api/`. The file path encodes
 * both the HTTP path and the method:
 *
 *   server/api/orgs/index.get.ts        → /api/orgs           GET
 *   server/api/auth/update-name.patch.ts → /api/auth/update-name PATCH
 *   apps/x/server/api/items/[id].get.ts → /api/items/:id      GET
 *   server/api/items/[...slug].get.ts   -> /api/items/(asterisk) GET  ([...x] catch-all → asterisk char)
 *   server/api/health.ts                → /api/health         ANY
 *
 * Dynamic segments:
 *   [x]     → :x   (named parameter)
 *   [...x]  → *    (catch-all)
 *
 * Files without a `server/api/` component in their path are not Nuxt API
 * routes and return false.
 */
#ifndef EXTRACT_NUXT_ROUTES_H
#define EXTRACT_NUXT_ROUTES_H

#include "arena.h" /* CtxArena, ctx_arena_alloc */
#include "extract.h" /* CtxExtractCtx, CtxDefinition, ctx_defs_push */
#include "tree_sitter/api.h" /* TSNode */
#include <stdbool.h>

/*
 * ctx_nuxt_route_from_path — Derive route path and HTTP method from a
 * relative file path.
 *
 * Parameters:
 *   a          — arena for allocating the output strings
 *   rel_path   — relative file path (e.g. "server/api/orgs/index.get.ts")
 *   out_path   — on success, set to arena-allocated route path (e.g. "/api/orgs")
 *   out_method — on success, set to arena-allocated HTTP method (e.g. "GET")
 *                or literal "ANY" for files without a method suffix
 *
 * Returns true iff rel_path contains "server/api/" and is a .ts file
 * (i.e. looks like a Nuxt API route). On false return, *out_path and
 * *out_method are undefined.
 */
bool ctx_nuxt_route_from_path(CtxArena *a, const char *rel_path,
                              const char **out_path, const char **out_method);

/*
 * ctx_try_extract_nuxt_handler — Capture a Nuxt file-based-route handler arrow
 * (or function expression) as a Function CtxDefinition tagged with route_path
 * and route_method, derived from the file path.
 *
 * Recognizes `export default <wrapper>(<arrow|fn-expr>)` where <wrapper> is one
 * of defineEventHandler / eventHandler / defineCachedEventHandler /
 * defineLazyEventHandler — the Nuxt/Nitro handler convention. Keying on the
 * `value` field of the export_statement restricts matching to `export default`
 * (named exports use a `declaration` field, leaving `value` NULL).
 *
 * Parameters:
 *   ctx         — extraction context (provides arena, rel_path, source,
 *                 project, result)
 *   export_stmt — an `export_statement` TSNode to inspect; a null node
 *                 is safe and returns false immediately
 *
 * Returns true iff the file path resolves to a Nuxt API route AND the export
 * matches the handler shape; in that case a Function def is pushed to
 * ctx->result->defs. Returns false otherwise (nothing pushed).
 */
bool ctx_try_extract_nuxt_handler(CtxExtractCtx *ctx, TSNode export_stmt);

#endif /* EXTRACT_NUXT_ROUTES_H */

/*
 * service_patterns.h — Allowlists for HTTP clients, async dispatch, and config accessors.
 *
 * Used during call resolution to classify CALLS edges as:
 *   HTTP_CALLS  — synchronous HTTP client calls
 *   ASYNC_CALLS — async message/task dispatch
 *   CONFIGURES  — config/env access
 *
 * Lookup is O(1) via hash table initialized once at startup.
 */
#ifndef CTX_SERVICE_PATTERNS_H
#define CTX_SERVICE_PATTERNS_H

#include <stdbool.h>

/* Edge type returned by pattern match. */
typedef enum {
    CTX_SVC_NONE = 0,      /* Not a service pattern — use normal CALLS */
    CTX_SVC_HTTP = 1,      /* Synchronous HTTP client call */
    CTX_SVC_ASYNC = 2,     /* Async dispatch (message broker, task queue) */
    CTX_SVC_CONFIG = 3,    /* Config/env accessor */
    CTX_SVC_ROUTE_REG = 4, /* Route registration (router.GET, app.get, Route::post) */
} ctx_svc_kind_t;

/* Initialize the pattern lookup tables. Call once at startup. Thread-safe after init. */
void ctx_service_patterns_init(void);

/* Check if a resolved QN contains a known service library identifier.
 * Returns the pattern kind, or CTX_SVC_NONE if no match.
 * Matches on library name substrings in the QN (e.g., "requests" in
 * "project.venv.requests.api.get"). Import-alias transparent. */
ctx_svc_kind_t ctx_service_pattern_match(const char *resolved_qn);

/* Get the HTTP method from the callee name suffix (e.g., ".get" → "GET").
 * Returns NULL if method cannot be inferred. */
const char *ctx_service_pattern_http_method(const char *callee_name);

/* Check if a bare callee name is a known global HTTP-client function.
 * These are auto-imported (Nuxt $fetch / useFetch / useLazyFetch) or
 * platform globals (browser/Node fetch) that never appear in an
 * IMPORTS edge, so call resolution can't reach them via QN substring
 * matching. Use this in the unresolved-call branch of pass_calls.
 * Returns true on exact full-callee match. */
bool ctx_service_pattern_is_global_http(const char *callee_name);

/* Heuristic: does this string look like an HTTP URL/path rather than a
 * filesystem path or a source-file path? Used to gate "first-string-arg
 * starts with /" detections in pass_calls. Rejects:
 *   - filesystem prefixes (/tmp/, /Users/, /usr/, /var/, /etc/, …)
 *   - source-file extensions (.ts, .go, .py, .c, …)
 *   - empty / NULL input
 * Accepts everything else that starts with "/" or contains "://".
 * False-positive resistant, false-negative tolerant — when in doubt
 * about a generic-looking path, the caller can apply tighter rules. */
bool ctx_service_pattern_looks_like_http_url(const char *path);

/* Get the HTTP method from a route registration callee name suffix
 * (e.g., "router.GET" → "GET", "app.post" → "POST").
 * Returns NULL if not a known route registration method. */
const char *ctx_service_pattern_route_method(const char *callee_name);

/* Get the broker name for an async QN (e.g., "pubsub" from a Pub/Sub QN).
 * Returns NULL if not an async pattern. */
const char *ctx_service_pattern_broker(const char *resolved_qn);

#endif /* CTX_SERVICE_PATTERNS_H */

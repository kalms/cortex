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

/* Get the HTTP method from a route registration callee name suffix
 * (e.g., "router.GET" → "GET", "app.post" → "POST").
 * Returns NULL if not a known route registration method. */
const char *ctx_service_pattern_route_method(const char *callee_name);

/* Get the broker name for an async QN (e.g., "pubsub" from a Pub/Sub QN).
 * Returns NULL if not an async pattern. */
const char *ctx_service_pattern_broker(const char *resolved_qn);

#endif /* CTX_SERVICE_PATTERNS_H */

/*
 * traces.h — OTLP trace processing helpers.
 *
 * Pure helper functions for extracting data from OpenTelemetry spans.
 * Used by the MCP ingest_traces handler.
 */
#ifndef CTX_TRACES_H
#define CTX_TRACES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ── Attribute key-value pair ─────────────────────────────────────── */

typedef struct {
    const char *key;
    const char *string_value;
} ctx_trace_attr_t;

/* ── Resource (service-level info) ────────────────────────────────── */

typedef struct {
    ctx_trace_attr_t *attributes;
    int attr_count;
} ctx_trace_resource_t;

/* ── Span ─────────────────────────────────────────────────────────── */

typedef struct {
    int kind; /* 1=internal, 2=server, 3=client */
    ctx_trace_attr_t *attributes;
    int attr_count;
    const char *start_time; /* nanosecond timestamp string */
    const char *end_time;   /* nanosecond timestamp string */
} ctx_trace_span_t;

/* ── HTTP span info (result of extractHTTPInfo) ───────────────────── */

typedef struct {
    const char *service_name;
    const char *method;
    const char *path;
    const char *status_code;
    int span_kind;
    int64_t duration_ns;
} ctx_http_span_info_t;

/* ── Helper functions ─────────────────────────────────────────────── */

/* Extract "service.name" from resource attributes. Returns "" if absent. */
const char *ctx_extract_service_name(const ctx_trace_resource_t *r);

/* Extract HTTP info from a span. Returns true if HTTP span, false otherwise.
 * Fills out with method, path, status, duration. Caller owns string pointers
 * (they point to data within the span's attribute strings — NOT heap-allocated). */
bool ctx_extract_http_info(const ctx_trace_span_t *span, const char *service_name,
                           ctx_http_span_info_t *out);

/* Extract path component from a full URL.
 * E.g. "https://example.com/api/orders?q=1" → "/api/orders"
 * Writes to buf (up to buf_sz). Returns buf, or "" if not a valid URL. */
const char *ctx_extract_path_from_url(const char *url, char *buf, size_t buf_sz);

/* Parse nanosecond timestamp strings and return duration. */
int64_t ctx_parse_duration(const char *start_nano, const char *end_nano);

/* Calculate P99 from an array of int64_t values.
 * Sorts values in-place. Returns 0 for empty array. */
int64_t ctx_calculate_p99(int64_t *values, int count);

#endif /* CTX_TRACES_H */

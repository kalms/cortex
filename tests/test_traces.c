/*
 * test_traces.c — Tests for OTLP trace processing helpers.
 *
 * Ported from internal/traces/traces_test.go (5 pure helper tests).
 * The TestIngestOTLPJSON integration test is deferred (needs full MCP pipeline).
 */
#include "test_framework.h"
#include <traces/traces.h>
#include <string.h>

/* ── TestExtractServiceName ─────────────────────────────────────── */

TEST(traces_extract_service_name) {
    cbm_trace_attr_t attrs[] = {
        {.key = "service.name", .string_value = "order-service"},
    };
    cbm_trace_resource_t r = {.attributes = attrs, .attr_count = 1};

    const char *name = cbm_extract_service_name(&r);
    ASSERT_STR_EQ(name, "order-service");
    PASS();
}

TEST(traces_extract_service_name_missing) {
    cbm_trace_attr_t attrs[] = {
        {.key = "other.attr", .string_value = "value"},
    };
    cbm_trace_resource_t r = {.attributes = attrs, .attr_count = 1};

    const char *name = cbm_extract_service_name(&r);
    ASSERT_STR_EQ(name, "");
    PASS();
}

TEST(traces_extract_service_name_null) {
    const char *name = cbm_extract_service_name(NULL);
    ASSERT_STR_EQ(name, "");
    PASS();
}

/* ── TestExtractHTTPInfo ────────────────────────────────────────── */

TEST(traces_extract_http_info) {
    cbm_trace_attr_t attrs[] = {
        {.key = "http.method", .string_value = "GET"},
        {.key = "http.route", .string_value = "/api/orders"},
        {.key = "http.status_code", .string_value = "200"},
    };
    cbm_trace_span_t span = {
        .kind = 2,
        .attributes = attrs,
        .attr_count = 3,
        .start_time = "1000000000",
        .end_time = "1050000000",
    };

    cbm_http_span_info_t info;
    bool ok = cbm_extract_http_info(&span, "svc", &info);
    ASSERT(ok);
    ASSERT_STR_EQ(info.method, "GET");
    ASSERT_STR_EQ(info.path, "/api/orders");
    ASSERT_EQ(info.duration_ns, 50000000);
    ASSERT_EQ(info.span_kind, 2);
    PASS();
}

/* ── TestExtractHTTPInfoNonHTTPSpan ─────────────────────────────── */

TEST(traces_extract_http_info_non_http) {
    cbm_trace_attr_t attrs[] = {
        {.key = "db.system", .string_value = "postgresql"},
    };
    cbm_trace_span_t span = {
        .kind = 1,
        .attributes = attrs,
        .attr_count = 1,
    };

    cbm_http_span_info_t info;
    bool ok = cbm_extract_http_info(&span, "svc", &info);
    ASSERT(!ok);
    PASS();
}

/* ── TestExtractHTTPInfo with url.full ──────────────────────────── */

TEST(traces_extract_http_info_url_full) {
    cbm_trace_attr_t attrs[] = {
        {.key = "http.method", .string_value = "GET"},
        {.key = "url.full", .string_value = "https://example.com/api/items?page=1"},
    };
    cbm_trace_span_t span = {
        .kind = 2,
        .attributes = attrs,
        .attr_count = 2,
        .start_time = "2000000000",
        .end_time = "2100000000",
    };

    cbm_http_span_info_t info;
    bool ok = cbm_extract_http_info(&span, "svc", &info);
    ASSERT(ok);
    ASSERT_STR_EQ(info.path, "/api/items");
    ASSERT_EQ(info.duration_ns, 100000000);
    PASS();
}

/* ── TestExtractPathFromURL ─────────────────────────────────────── */

TEST(traces_extract_path_from_url) {
    char buf[256];

    cbm_extract_path_from_url("https://example.com/api/orders", buf, sizeof(buf));
    ASSERT_STR_EQ(buf, "/api/orders");

    cbm_extract_path_from_url("http://localhost:8080/health?check=true", buf, sizeof(buf));
    ASSERT_STR_EQ(buf, "/health");

    cbm_extract_path_from_url("not-a-url", buf, sizeof(buf));
    ASSERT_STR_EQ(buf, "");

    cbm_extract_path_from_url("https://example.com/", buf, sizeof(buf));
    ASSERT_STR_EQ(buf, "/");

    PASS();
}

/* ── TestCalculateP99 ───────────────────────────────────────────── */

TEST(traces_calculate_p99) {
    int64_t values[] = {10, 20, 30, 40, 50, 60, 70, 80, 90, 100};
    int64_t p99 = cbm_calculate_p99(values, 10);
    ASSERT_EQ(p99, 100);
    PASS();
}

TEST(traces_calculate_p99_single) {
    int64_t values[] = {42};
    int64_t p99 = cbm_calculate_p99(values, 1);
    ASSERT_EQ(p99, 42);
    PASS();
}

TEST(traces_calculate_p99_empty) {
    int64_t p99 = cbm_calculate_p99(NULL, 0);
    ASSERT_EQ(p99, 0);
    PASS();
}

/* ── TestParseDuration ──────────────────────────────────────────── */

TEST(traces_parse_duration) {
    int64_t d = cbm_parse_duration("1000000000", "1050000000");
    ASSERT_EQ(d, 50000000);
    PASS();
}

TEST(traces_parse_duration_zero) {
    int64_t d = cbm_parse_duration("1000", "500");
    ASSERT_EQ(d, 0); /* end < start → 0 */
    PASS();
}

SUITE(traces) {
    RUN_TEST(traces_extract_service_name);
    RUN_TEST(traces_extract_service_name_missing);
    RUN_TEST(traces_extract_service_name_null);
    RUN_TEST(traces_extract_http_info);
    RUN_TEST(traces_extract_http_info_non_http);
    RUN_TEST(traces_extract_http_info_url_full);
    RUN_TEST(traces_extract_path_from_url);
    RUN_TEST(traces_calculate_p99);
    RUN_TEST(traces_calculate_p99_single);
    RUN_TEST(traces_calculate_p99_empty);
    RUN_TEST(traces_parse_duration);
    RUN_TEST(traces_parse_duration_zero);
}

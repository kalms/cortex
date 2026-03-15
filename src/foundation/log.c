/*
 * log.c — Structured key-value logging to stderr.
 */
#include "log.h"
#include <stdio.h>
#include <stdarg.h>
#include <inttypes.h>

static CBMLogLevel g_log_level = CBM_LOG_INFO;

void cbm_log_set_level(CBMLogLevel level) {
    g_log_level = level;
}

CBMLogLevel cbm_log_get_level(void) {
    return g_log_level;
}

static const char *level_str(CBMLogLevel level) {
    switch (level) {
    case CBM_LOG_DEBUG:
        return "debug";
    case CBM_LOG_INFO:
        return "info";
    case CBM_LOG_WARN:
        return "warn";
    case CBM_LOG_ERROR:
        return "error";
    default:
        return "unknown";
    }
}

void cbm_log(CBMLogLevel level, const char *msg, ...) {
    if (level < g_log_level)
        return;

    fprintf(stderr, "level=%s msg=%s", level_str(level), msg ? msg : "");

    va_list args;
    va_start(args, msg);
    for (;;) {
        const char *key = va_arg(args, const char *);
        if (!key)
            break;
        const char *val = va_arg(args, const char *);
        if (!val)
            val = "";
        fprintf(stderr, " %s=%s", key, val);
    }
    va_end(args);

    fputc('\n', stderr);
}

void cbm_log_int(CBMLogLevel level, const char *msg, const char *key, int64_t value) {
    if (level < g_log_level)
        return;
    fprintf(stderr, "level=%s msg=%s %s=%" PRId64 "\n", level_str(level), msg ? msg : "",
            key ? key : "?", value);
}

/*
 * log.h — Structured key-value logging to stderr.
 *
 * Design:
 *   - All output goes to stderr (stdout is reserved for MCP JSON-RPC)
 *   - Structured format: "level=info msg=pass.timing pass=defs elapsed_ms=42"
 *   - Levels: DEBUG, INFO, WARN, ERROR
 *   - Level filtering at compile time (CTX_LOG_MIN_LEVEL) and runtime
 *   - Thread-safe (each fprintf is atomic on POSIX for lines < PIPE_BUF)
 */
#ifndef CTX_LOG_H
#define CTX_LOG_H

#include <stdint.h>

typedef enum {
    CTX_LOG_DEBUG = 0,
    CTX_LOG_INFO = 1,
    CTX_LOG_WARN = 2,
    CTX_LOG_ERROR = 3,
    CTX_LOG_NONE = 4 /* disable all logging */
} CBMLogLevel;

/* Set minimum log level (default: INFO). */
void ctx_log_set_level(CBMLogLevel level);

/* Get current log level. */
CBMLogLevel ctx_log_get_level(void);

/* Core logging function. msg is a short semantic tag.
 * Variadic args are key-value pairs: (const char *key, const char *value)...
 * Terminated by NULL key.
 *
 * Example:
 *   ctx_log(CTX_LOG_INFO, "pass.timing",
 *           "pass", "defs", "elapsed_ms", "42", NULL);
 *
 * Output:
 *   level=info msg=pass.timing pass=defs elapsed_ms=42
 */
void ctx_log(CBMLogLevel level, const char *msg, ...);

/* Convenience macros. */
#define ctx_log_debug(msg, ...) ctx_log(CTX_LOG_DEBUG, msg, ##__VA_ARGS__, NULL)
#define ctx_log_info(msg, ...) ctx_log(CTX_LOG_INFO, msg, ##__VA_ARGS__, NULL)
#define ctx_log_warn(msg, ...) ctx_log(CTX_LOG_WARN, msg, ##__VA_ARGS__, NULL)
#define ctx_log_error(msg, ...) ctx_log(CTX_LOG_ERROR, msg, ##__VA_ARGS__, NULL)

/* Log with integer value (avoids sprintf for common case). */
void ctx_log_int(CBMLogLevel level, const char *msg, const char *key, int64_t value);

/* Optional log sink callback — called with the formatted log line. */
typedef void (*ctx_log_sink_fn)(const char *line);
void ctx_log_set_sink(ctx_log_sink_fn fn);

#endif /* CTX_LOG_H */

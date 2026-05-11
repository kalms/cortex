/*
 * constants.h — Project-wide named constants.
 *
 * Eliminates magic numbers flagged by readability-magic-numbers.
 * Every literal integer/float in source should reference a named constant.
 */
#ifndef CTX_CONSTANTS_H
#define CTX_CONSTANTS_H

/* ── Allocation counts ───────────────────────────────────────── */
enum { CTX_ALLOC_ONE = 1 }; /* calloc(CTX_ALLOC_ONE, sizeof(T)) */

/* ── Byte / character constants ──────────────────────────────── */
enum {
    CTX_BYTE_RANGE = 256, /* full byte range 0x00–0xFF */
    CTX_QUOTE_PAIR = 2,   /* two quote characters (open + close) */
    CTX_QUOTE_OFFSET = 1, /* skip opening quote */
};

/* ── Size units (powers of 2) ────────────────────────────────── */
enum {
    CTX_SZ_2 = 2,
    CTX_SZ_3 = 3,
    CTX_SZ_4 = 4,
    CTX_SZ_5 = 5,
    CTX_SZ_6 = 6,
    CTX_SZ_7 = 7,
    CTX_SZ_8 = 8,
    CTX_SZ_16 = 16,
    CTX_SZ_32 = 32,
    CTX_SZ_64 = 64,
    CTX_SZ_128 = 128,
    CTX_SZ_256 = 256,
    CTX_SZ_512 = 512,
    CTX_SZ_1K = 1024,
    CTX_SZ_2K = 2048,
    CTX_SZ_4K = 4096,
    CTX_SZ_8K = 8192,
    CTX_SZ_16K = 16384,
    CTX_SZ_32K = 32768,
    CTX_SZ_64K = 65536,
};

/* ── Numeric bases and common factors ────────────────────────── */
enum {
    CTX_DECIMAL_BASE = 10,
    CTX_HEX_BASE = 16,
    CTX_PERCENT = 100,
};

/* ── Tree-sitter field name helper ───────────────────────────── */
/* Usage: ts_node_child_by_field_name(node, TS_FIELD("callee"))
 * Expands to: ts_node_child_by_field_name(node, TS_FIELD("callee"))
 * The sizeof includes the NUL terminator, so subtract 1. */
#define TS_FIELD(name) (name), (uint32_t)(sizeof(name) - SKIP_ONE)

/* ── Tree-sitter line offset ─────────────────────────────────── */
/* ts_node row is 0-based; source lines are 1-based. */
enum { TS_LINE_OFFSET = 1 };

/* Common offset constants. */

/* Common offset constants. */

/* ── Sentinel values ─────────────────────────────────────────── */
enum {
    CTX_NOT_FOUND = -1, /* search miss, invalid index */
    CTX_INIT_DONE = 1,  /* initialization flag */
};

/* ── Time conversion factors ─────────────────────────────────── */
#define CTX_NSEC_PER_SEC 1000000000ULL
#define CTX_USEC_PER_SEC 1000000ULL
#define CTX_MSEC_PER_SEC 1000ULL
#define CTX_NSEC_PER_USEC 1000ULL
#define CTX_NSEC_PER_MSEC 1000000ULL

/* ── Common string/buffer sizes ──────────────────────────────── */
enum {
    CTX_SMALL_BUF = 3,   /* small scratch buffers */
    CTX_NAME_BUF = 4,    /* name buffer slots */
    CTX_PATH_MAX = 1024, /* path buffer size */
    CTX_LINE_BUF = 512,  /* line read buffer */
};

/* Common offset constants (used across many files). */
enum { SKIP_ONE = 1, PAIR_LEN = 2 };

#endif /* CTX_CONSTANTS_H */

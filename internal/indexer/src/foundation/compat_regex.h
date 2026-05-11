/*
 * compat_regex.h — Portable regular expression API.
 *
 * POSIX: direct wrappers around <regex.h> (regcomp, regexec, regfree).
 * Windows: TODO — vendor TRE regex or use a C++ wrapper around <regex>.
 *
 * Uses our own types so callers never include <regex.h> directly.
 */
#ifndef CTX_COMPAT_REGEX_H
#define CTX_COMPAT_REGEX_H

#include "foundation/constants.h"
#include <stddef.h>

/* ── Flags ────────────────────────────────────────────────────── */

#define CTX_REG_EXTENDED 1
#define CTX_REG_ICASE 2
#define CTX_REG_NOSUB 4
#define CTX_REG_NEWLINE 8

/* ── Error codes ──────────────────────────────────────────────── */

#define CTX_REG_OK 0
#define CTX_REG_NOMATCH (-1)

/* ── Types ────────────────────────────────────────────────────── */

/* Opaque regex handle — sized to hold the platform's regex_t. */
typedef struct {
    /* CTX_SZ_256 bytes should be large enough for any platform's regex_t.
     * POSIX regex_t is typically 48-CTX_SZ_64 bytes; TRE is ~80 bytes. */
    char opaque[CTX_SZ_256];
} ctx_regex_t;

typedef struct {
    int rm_so; /* byte offset of match start, -1 if no match */
    int rm_eo; /* byte offset past match end */
} ctx_regmatch_t;

/* ── Functions ────────────────────────────────────────────────── */

/* Compile a regular expression. Returns CTX_REG_OK on success, non-zero on error. */
int ctx_regcomp(ctx_regex_t *r, const char *pattern, int flags);

/* Execute compiled regex against str. nmatch/matches may be 0/NULL.
 * eflags: 0 or combination of platform-specific exec flags.
 * Returns CTX_REG_OK on match, CTX_REG_NOMATCH on no match. */
int ctx_regexec(const ctx_regex_t *r, const char *str, int nmatch, ctx_regmatch_t *matches,
                int eflags);

/* Free compiled regex. */
void ctx_regfree(ctx_regex_t *r);

#endif /* CTX_COMPAT_REGEX_H */

/*
 * compat.c — Implementations for Windows-only shims.
 *
 * On POSIX, these functions are provided by the standard library via
 * macros in compat.h. On Windows, we implement them here.
 */
#include "foundation/compat.h"

#include <stdlib.h>
#include <string.h>

/* ── strndup (Windows lacks it) ───────────────────────────────── */

#ifdef _WIN32
char *cbm_strndup(const char *s, size_t n) {
    if (!s) {
        return NULL;
    }
    size_t len = 0;
    while (len < n && s[len]) {
        len++;
    }
    char *d = (char *)malloc(len + 1);
    if (d) {
        memcpy(d, s, len);
        d[len] = '\0';
    }
    return d;
}
#endif

/* ── strcasestr (Windows lacks it) ────────────────────────────── */

#ifdef _WIN32
char *cbm_strcasestr(const char *haystack, const char *needle) {
    if (!needle[0])
        return (char *)haystack;
    size_t nlen = strlen(needle);
    for (; *haystack; haystack++) {
        if (_strnicmp(haystack, needle, nlen) == 0)
            return (char *)haystack;
    }
    return NULL;
}
#endif

/* ── mkdtemp (Windows lacks it) ───────────────────────────────── */

#ifdef _WIN32
#include <direct.h>
char *cbm_mkdtemp(char *tmpl) {
    /* On Windows, /tmp doesn't exist. Replace /tmp/ prefix with %TEMP%\ */
    if (strncmp(tmpl, "/tmp/", 5) == 0) {
        const char *tmp = getenv("TEMP");
        if (!tmp)
            tmp = getenv("TMP");
        if (!tmp)
            tmp = ".";
        char buf[512];
        snprintf(buf, sizeof(buf), "%s\\%s", tmp, tmpl + 5);
        /* Copy back (template buffer must be large enough) */
        size_t len = strlen(buf);
        memcpy(tmpl, buf, len + 1);
    }
    /* _mktemp modifies template in place, then we mkdir */
    if (!_mktemp(tmpl))
        return NULL;
    if (_mkdir(tmpl) != 0)
        return NULL;
    return tmpl;
}
#endif

/* ── clock_gettime (Windows lacks it) ─────────────────────────── */

#ifdef _WIN32
int cbm_clock_gettime(int clk_id, struct timespec *tp) {
    (void)clk_id;
    LARGE_INTEGER freq, count;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&count);
    tp->tv_sec = (time_t)(count.QuadPart / freq.QuadPart);
    tp->tv_nsec = (long)((count.QuadPart % freq.QuadPart) * 1000000000LL / freq.QuadPart);
    return 0;
}
#endif

/* ── getline (Windows lacks it) ───────────────────────────────── */

#ifdef _WIN32
ssize_t cbm_getline(char **lineptr, size_t *n, FILE *stream) {
    if (!lineptr || !n || !stream) {
        return -1;
    }
    if (!*lineptr || *n == 0) {
        *n = 128;
        *lineptr = (char *)malloc(*n);
        if (!*lineptr) {
            return -1;
        }
    }
    size_t pos = 0;
    int c;
    while ((c = fgetc(stream)) != EOF) {
        if (pos + 1 >= *n) {
            size_t new_n = *n * 2;
            char *tmp = (char *)realloc(*lineptr, new_n);
            if (!tmp) {
                return -1;
            }
            *lineptr = tmp;
            *n = new_n;
        }
        (*lineptr)[pos++] = (char)c;
        if (c == '\n') {
            break;
        }
    }
    if (pos == 0 && c == EOF) {
        return -1;
    }
    (*lineptr)[pos] = '\0';
    return (ssize_t)pos;
}
#endif

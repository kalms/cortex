/*
 * compat.h — Cross-platform compatibility macros and shims.
 *
 * Provides portable TLS, sleep, strdup/strndup, and getline across
 * POSIX (macOS/Linux) and Windows. Include this instead of using
 * platform-specific macros directly.
 */
#ifndef CBM_COMPAT_H
#define CBM_COMPAT_H

#include <stddef.h>
#include <stdio.h>

/* ── Thread-local storage ─────────────────────────────────────── */
/* _Thread_local is C11 standard — works on GCC, Clang, and MSVC (2019+).
 * __declspec(thread) is MSVC-only and doesn't work on MinGW GCC. */
#define CBM_TLS _Thread_local

/* ── Sleep ────────────────────────────────────────────────────── */
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#define cbm_usleep(us) Sleep((DWORD)((us) / 1000))
#else
#include <unistd.h>
#define cbm_usleep(us) usleep((useconds_t)(us))
#endif

/* ── strdup / strndup ─────────────────────────────────────────── */
#ifdef _WIN32
#define cbm_strdup _strdup
/* Implemented in compat.c */
char *cbm_strndup(const char *s, size_t n);
#else
#define cbm_strdup strdup
#define cbm_strndup strndup
#endif

/* ── getline (Windows lacks it) ───────────────────────────────── */
#ifdef _WIN32
/* Implemented in compat.c */
ssize_t cbm_getline(char **lineptr, size_t *n, FILE *stream);
#else
#define cbm_getline getline
#endif

/* ── fileno ───────────────────────────────────────────────────── */
#ifdef _WIN32
#define cbm_fileno _fileno
#else
#define cbm_fileno fileno
#endif

/* ── Signal handling ──────────────────────────────────────────── */
/* Windows doesn't have sigaction; provide macro to select signal API. */
#ifdef _WIN32
#define CBM_HAS_SIGACTION 0
#else
#define CBM_HAS_SIGACTION 1
#endif

#endif /* CBM_COMPAT_H */

/*
 * compat_thread.h — Portable threading: pthreads on POSIX, Win32 threads on Windows.
 *
 * Provides: thread create/join, mutex, aligned allocation.
 * All have zero overhead on POSIX (thin inlines or macros).
 */
#ifndef CTX_COMPAT_THREAD_H
#define CTX_COMPAT_THREAD_H

#include <stddef.h>

/* ── Thread ───────────────────────────────────────────────────── */

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

typedef struct {
    HANDLE handle;
} ctx_thread_t;

#else /* POSIX */

#include <pthread.h>

typedef struct {
    pthread_t handle;
} ctx_thread_t;

#endif

/* Create a thread with the given stack size (0 = OS default).
 * fn receives arg. Returns 0 on success. */
int ctx_thread_create(ctx_thread_t *t, size_t stack_size, void *(*fn)(void *), void *arg);

/* Wait for thread to finish. Returns 0 on success. */
int ctx_thread_join(ctx_thread_t *t);

/* ── Mutex ────────────────────────────────────────────────────── */

#ifdef _WIN32

typedef struct {
    CRITICAL_SECTION cs;
} ctx_mutex_t;

#else

typedef struct {
    pthread_mutex_t mtx;
} ctx_mutex_t;

#endif

void ctx_mutex_init(ctx_mutex_t *m);
void ctx_mutex_lock(ctx_mutex_t *m);
void ctx_mutex_unlock(ctx_mutex_t *m);
void ctx_mutex_destroy(ctx_mutex_t *m);

/* ── Aligned allocation ───────────────────────────────────────── */

/* Allocate size bytes aligned to alignment boundary.
 * Returns 0 on success, non-zero on failure. *ptr receives the allocation. */
int ctx_aligned_alloc(void **ptr, size_t alignment, size_t size);

/* Free memory from ctx_aligned_alloc. */
void ctx_aligned_free(void *ptr);

#endif /* CTX_COMPAT_THREAD_H */

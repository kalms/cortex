/*
 * worker_pool.c — Parallel-for dispatch with GCD (macOS) and pthreads (Linux).
 *
 * GCD: dispatch_apply_f on a concurrent queue with QOS_CLASS_USER_INITIATED.
 *      Avoids blocks — uses function pointer variant for portability + TSan.
 *
 * pthreads: N threads, each pulling work from a shared atomic counter.
 *           Zero contention — each thread increments once per file.
 */
#include "pipeline/worker_pool.h"
#include "foundation/platform.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>

/* TSan detection: GCD has known TSan issues, fall back to pthreads */
#ifndef __has_feature
#define __has_feature(x) 0
#endif
#if defined(__SANITIZE_THREAD__) || __has_feature(thread_sanitizer)
#define CBM_TSAN 1
#else
#define CBM_TSAN 0
#endif

/* ── Serial fallback ─────────────────────────────────────────────── */

static void run_serial(int count, cbm_parallel_fn fn, void *ctx) {
    for (int i = 0; i < count; i++) {
        fn(i, ctx);
    }
}

/* ── pthreads backend ────────────────────────────────────────────── */

#include <pthread.h>

typedef struct {
    cbm_parallel_fn fn;
    void *ctx;
    _Atomic int *next_idx;
    int count;
} pthread_worker_arg_t;

static void *pthread_worker(void *arg) {
    pthread_worker_arg_t *wa = arg;
    while (1) {
        int idx = atomic_fetch_add_explicit(wa->next_idx, 1, memory_order_relaxed);
        if (idx >= wa->count) {
            break;
        }
        wa->fn(idx, wa->ctx);
    }
    return NULL;
}

static void run_pthreads(int count, cbm_parallel_fn fn, void *ctx, int nworkers) {
    _Atomic int next_idx = 0;

    pthread_worker_arg_t wa = {
        .fn = fn,
        .ctx = ctx,
        .next_idx = &next_idx,
        .count = count,
    };

    // NOLINTNEXTLINE(misc-include-cleaner)
    pthread_t *threads = (pthread_t *)malloc((size_t)nworkers * sizeof(pthread_t));
    if (!threads) {
        run_serial(count, fn, ctx);
        return;
    }

    for (int i = 0; i < nworkers; i++) {
        if (pthread_create(&threads[i], NULL, pthread_worker, &wa) != 0) {
            /* Failed to create thread — let remaining work run in main thread */
            nworkers = i;
            break;
        }
    }

    /* Main thread also participates */
    while (1) {
        int idx = atomic_fetch_add_explicit(&next_idx, 1, memory_order_relaxed);
        if (idx >= count) {
            break;
        }
        fn(idx, ctx);
    }

    for (int i = 0; i < nworkers; i++) {
        pthread_join(threads[i], NULL);
    }

    // NOLINTNEXTLINE(bugprone-multi-level-implicit-pointer-conversion)
    free(threads);
}

/* ── GCD backend (macOS only) ────────────────────────────────────── */

#if defined(__APPLE__) && !CBM_TSAN

#include <dispatch/dispatch.h>

typedef struct {
    cbm_parallel_fn fn;
    void *ctx;
} dispatch_wrapper_ctx_t;

static void dispatch_wrapper(void *wrapper_ctx, size_t idx) {
    dispatch_wrapper_ctx_t *wc = wrapper_ctx;
    wc->fn((int)idx, wc->ctx);
}

static void run_gcd(int count, cbm_parallel_fn fn, void *ctx, int nworkers) {
    (void)nworkers;

    /* Create a concurrent queue with USER_INITIATED QoS
     * to ensure P-core eligibility on Apple Silicon */
    dispatch_queue_attr_t attr = dispatch_queue_attr_make_with_qos_class(
        // NOLINTNEXTLINE(misc-include-cleaner)
        DISPATCH_QUEUE_CONCURRENT, QOS_CLASS_USER_INITIATED, 0);
    dispatch_queue_t queue = dispatch_queue_create("cbm.parallel", attr);

    dispatch_wrapper_ctx_t wc = {.fn = fn, .ctx = ctx};
    dispatch_apply_f((size_t)count, queue, &wc, dispatch_wrapper);

    dispatch_release(queue);
}

#endif /* __APPLE__ && !CBM_TSAN */

/* ── Public API ──────────────────────────────────────────────────── */

void cbm_parallel_for(int count, cbm_parallel_fn fn, void *ctx, cbm_parallel_for_opts_t opts) {
    if (count <= 0 || !fn) {
        return;
    }

    /* Determine worker count */
    int nworkers = opts.max_workers;
    if (nworkers <= 0) {
        nworkers = cbm_default_worker_count(true);
    }
    if (nworkers < 1) {
        nworkers = 1;
    }

    /* Small workload threshold: serial is cheaper than dispatch overhead */
    if (count < 2 * nworkers || nworkers <= 1) {
        run_serial(count, fn, ctx);
        return;
    }

#if defined(__APPLE__) && !CBM_TSAN
    if (!opts.force_pthreads) {
        run_gcd(count, fn, ctx, nworkers);
        return;
    }
#endif

    run_pthreads(count, fn, ctx, nworkers);
}

/*
 * worker_pool.h — Generic parallel-for dispatch.
 *
 * Platform backends:
 *   macOS:       GCD dispatch_apply_f (default) with QOS_CLASS_USER_INITIATED
 *   macOS TSan:  pthreads fallback (TSan has known GCD issues)
 *   Linux:       pthreads with atomic work index
 *
 * Threshold: if count < 2 * workers, runs single-threaded (dispatch overhead
 * exceeds parallel gain for small workloads).
 */
#ifndef CBM_WORKER_POOL_H
#define CBM_WORKER_POOL_H

#include <stdbool.h>

/* Worker callback: called once per iteration with index [0..count-1]. */
typedef void (*cbm_parallel_fn)(int idx, void *ctx);

/* Options for parallel dispatch. */
typedef struct {
    int max_workers;     /* 0 = auto-detect from cbm_default_worker_count */
    bool force_pthreads; /* bypass GCD on macOS (for TSan or testing) */
} cbm_parallel_for_opts_t;

/* Dispatch `count` iterations of `fn(idx, ctx)` across worker threads.
 * Each index [0..count-1] is visited exactly once.
 * Blocks until all iterations complete.
 *
 * If count <= 0, this is a no-op.
 * If count < 2 * workers, runs single-threaded (avoids dispatch overhead). */
void cbm_parallel_for(int count, cbm_parallel_fn fn, void *ctx, cbm_parallel_for_opts_t opts);

#endif /* CBM_WORKER_POOL_H */

/*
 * mem.h — Unified memory management via mimalloc.
 *
 * Provides budget tracking based on actual RSS (not partial vmem tracking).
 * Uses mi_process_info() as the single source of truth for memory pressure.
 * Replaces the old vmem.h budget-tracked virtual memory allocator.
 */
#ifndef CTX_MEM_H
#define CTX_MEM_H

#include <stdbool.h>
#include <stddef.h>

/* Initialize memory budget = ram_fraction * total_physical_ram.
 * Thread-safe: only the first call takes effect.
 * Configures mimalloc options for reduced upfront memory. */
void ctx_mem_init(double ram_fraction);

/* Current RSS in bytes via mi_process_info().
 * Falls back to OS-specific queries when MI_OVERRIDE=0 (ASan builds). */
size_t ctx_mem_rss(void);

/* Peak RSS in bytes. */
size_t ctx_mem_peak_rss(void);

/* Total budget in bytes. */
size_t ctx_mem_budget(void);

/* Returns true if current RSS exceeds the budget. */
bool ctx_mem_over_budget(void);

/* Per-worker budget hint: budget / num_workers. */
size_t ctx_mem_worker_budget(int num_workers);

/* Return unused pages to the OS. Call between files to bound per-file peak. */
void ctx_mem_collect(void);

/* Block until RSS drops below a safe fraction of the budget (back-pressure).
 *
 * Behavior:
 *   - If RSS is under the enter-threshold (~85% of budget), returns immediately.
 *   - Otherwise spins on `usleep`+`mi_collect` until RSS falls under the
 *     exit-threshold (~75% of budget, hysteresis).
 *   - Bounded total wait (~30s); on timeout returns anyway to avoid deadlock
 *     when every worker is simultaneously over budget (better to OOM than hang).
 *
 * Designed to be called from worker threads at end-of-file boundaries, after
 * per-file cleanup (parser destroy, slab reclaim, mi_collect). Serializes
 * workers under pressure while keeping them parallel when there is headroom.
 *
 * Logs:
 *   mem.pressure.wait     — entered the wait (once per worker per episode)
 *   mem.pressure.resume   — successfully dropped under exit-threshold
 *   mem.pressure.timeout  — gave up after the bounded wait
 */
void ctx_mem_wait_for_headroom(void);

#endif /* CTX_MEM_H */

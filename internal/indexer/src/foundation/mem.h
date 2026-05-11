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

#endif /* CTX_MEM_H */

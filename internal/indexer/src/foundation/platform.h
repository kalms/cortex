/*
 * platform.h — OS abstractions.
 *
 * Provides cross-platform wrappers for:
 *   - Memory-mapped files (mmap / VirtualAlloc)
 *   - High-resolution monotonic clock
 *   - CPU core count
 *   - File existence check
 */
#ifndef CTX_PLATFORM_H
#define CTX_PLATFORM_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>

/* ── Safe memory ──────────────────────────────────────────────── */

/* Safe realloc: frees old pointer on failure instead of leaking it.
 * Returns NULL on allocation failure (old memory is freed). */
static inline void *safe_realloc(void *ptr, size_t size) {
    enum { SAFE_REALLOC_MIN = 1 };
    if (size == 0) {
        size = SAFE_REALLOC_MIN;
    }
    void *tmp = realloc(ptr, size);
    if (!tmp) {
        free(ptr);
    }
    return tmp;
}

/* ── Memory mapping ────────────────────────────────────────────── */

/* Map a file read-only into memory. Returns NULL on error.
 * *out_size is set to the file size. */
void *ctx_mmap_read(const char *path, size_t *out_size);

/* Unmap a previously mapped region. */
void ctx_munmap(void *addr, size_t size);

/* ── Timing ────────────────────────────────────────────────────── */

/* Monotonic nanosecond timestamp (for elapsed time measurement). */
uint64_t ctx_now_ns(void);

/* Monotonic millisecond timestamp. */
uint64_t ctx_now_ms(void);

/* ── System info ───────────────────────────────────────────────── */

/* Number of available CPU cores. */
int ctx_nprocs(void);

/* System topology: core types and RAM (only fields with production consumers). */
typedef struct {
    int total_cores;  /* hw.ncpu (all cores) */
    int perf_cores;   /* P-cores (Apple) or total_cores (others) */
    size_t total_ram; /* total physical RAM in bytes */
} ctx_system_info_t;

/* Query system information. Results are cached after first call. */
ctx_system_info_t ctx_system_info(void);

/* Recommended worker count for parallel indexing.
 * initial=true:  all cores (user is waiting for initial index)
 * initial=false: max(1, perf_cores-1) (leave headroom for user apps) */
int ctx_default_worker_count(bool initial);

/* ── Environment variables ──────────────────────────────────────── */

/* Thread-safe getenv: copies the value into a caller-provided buffer.
 * Returns buf on success, or fallback if the variable is unset.
 * Returns NULL when the variable is unset and fallback is NULL. */
const char *ctx_safe_getenv(const char *name, char *buf, size_t buf_sz, const char *fallback);

/* ── Home directory ─────────────────────────────────────────────── */

/* Cross-platform home directory: tries HOME first, then USERPROFILE (Windows).
 * Returns NULL when neither is set. */
const char *ctx_get_home_dir(void);

/* ── App config directories ────────────────────────────────────── */

/* Cross-platform app config directory (static buffer, not thread-safe).
 * Windows: %APPDATA% (e.g. C:/Users/.../AppData/Roaming)
 * macOS:   $HOME (callers append Library/Application Support/...)
 * Linux:   $XDG_CONFIG_HOME or ~/.config */
const char *ctx_app_config_dir(void);

/* Windows: %LOCALAPPDATA% (e.g. C:/Users/.../AppData/Local)
 * macOS/Linux: same as ctx_app_config_dir(). */
const char *ctx_app_local_dir(void);

/* ── Cache directory ────────────────────────────────────────────── */

/* Resolve the database cache directory. All project indexes are stored here.
 * Priority: CTX_CACHE_DIR env var > ~/.cache/codebase-memory-mcp (default).
 * Returns static buffer or NULL if home is unavailable. */
const char *ctx_resolve_cache_dir(void);

/* Resolve the SQLite database path to use for indexing.
 *
 * Priority:
 *   1. CORTEX_DB env var if set — used verbatim, ignores `project`.
 *   2. Per-project file at <cache_dir>/<project>.db (existing default).
 *
 * Writes the resolved path into `buf` (size `bufsz`) and returns it on success.
 * Returns NULL when CORTEX_DB is unset AND `project` is NULL — caller error.
 *
 * Used by the pipeline (write path) and resolve_store (read path) so both
 * honor the CORTEX_DB unification when set.
 */
const char *ctx_resolve_db_path(const char *project, char *buf, size_t bufsz);

/* ── File system ───────────────────────────────────────────────── */

/* Check if a path exists. */
bool ctx_file_exists(const char *path);

/* Check if path is a directory. */
bool ctx_is_dir(const char *path);

/* Get file size. Returns -1 on error. */
int64_t ctx_file_size(const char *path);

/* Normalize path separators to forward slashes (in-place).
 * On Windows, converts backslashes to forward slashes.
 * On POSIX, this is a no-op. Returns the input pointer. */
char *ctx_normalize_path_sep(char *path);

#endif /* CTX_PLATFORM_H */

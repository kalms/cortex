/*
 * system_info.c — CPU core count and RAM detection.
 *
 * macOS: sysctlbyname for core counts, hw.memsize for RAM.
 * Linux: sysconf + sysinfo().
 * Windows: GetSystemInfo + GlobalMemoryStatusEx.
 *
 * Results are cached after first call (immutable hardware properties).
 */
#include "foundation/constants.h"

enum {
    DEFAULT_CORES = 1,
    MIN_WORKERS = 1,
    /* Each worker holds ~one file's parser state + slab arenas; treat
     * ~2 GB as a conservative per-worker memory ceiling so we don't
     * launch more workers than the host has RAM for. */
    WORKER_RAM_GB_PER_WORKER = 2,
    /* Clamp user-supplied CTX_WORKERS to (logical cores * this factor)
     * to defend against typos like CTX_WORKERS=1000. */
    WORKER_OVERRIDE_MAX_MULT = 2,
};
#include "foundation/platform.h"
#include <stdint.h> // uint64_t
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#elif defined(__APPLE__)
#include <sys/sysctl.h>
#elif !defined(_WIN32) /* Linux */
#include <unistd.h>
#include <sys/sysinfo.h>

#endif

/* ── macOS detection ─────────────────────────────────────────────── */

#ifdef __APPLE__

static int sysctl_int(const char *name, int fallback) {
    int val = 0;
    size_t len = sizeof(val);
    if (sysctlbyname(name, &val, &len, NULL, 0) == 0 && val > 0) {
        return val;
    }
    return fallback;
}

static size_t sysctl_size(const char *name, size_t fallback) {
    size_t val = 0;
    size_t len = sizeof(val);
    if (sysctlbyname(name, &val, &len, NULL, 0) == 0 && val > 0) {
        return val;
    }
    /* Try CTX_SZ_64-bit variant */
    uint64_t val64 = 0;
    len = sizeof(val64);
    if (sysctlbyname(name, &val64, &len, NULL, 0) == 0 && val64 > 0) {
        return (size_t)val64;
    }
    return fallback;
}

static ctx_system_info_t detect_system_macos(void) {
    ctx_system_info_t info;
    memset(&info, 0, sizeof(info));

    info.total_cores = sysctl_int("hw.ncpu", DEFAULT_CORES);
    info.perf_cores = sysctl_int("hw.perflevel0.physicalcpu", info.total_cores);

    /* If perflevel sysctls fail (Intel Mac), perf = total */
    int eff = sysctl_int("hw.perflevel1.physicalcpu", 0);
    if (info.perf_cores + eff > info.total_cores) {
        info.perf_cores = info.total_cores;
    }

    info.total_ram = sysctl_size("hw.memsize", 0);
    return info;
}

#elif !defined(_WIN32) /* Linux */

static ctx_system_info_t detect_system_linux(void) {
    ctx_system_info_t info;
    memset(&info, 0, sizeof(info));

    long nprocs = sysconf(_SC_NPROCESSORS_ONLN);
    info.total_cores = nprocs > 0 ? (int)nprocs : 1;
    info.perf_cores = info.total_cores; /* Linux doesn't distinguish P/E */

    struct sysinfo si;
    if (sysinfo(&si) == 0) {
        info.total_ram = (size_t)si.totalram * (size_t)si.mem_unit;
    }

    return info;
}

#endif /* __APPLE__ / Linux */

/* ── Windows detection ───────────────────────────────────────────── */

#ifdef _WIN32
static ctx_system_info_t detect_system_windows(void) {
    ctx_system_info_t info;
    memset(&info, 0, sizeof(info));

    SYSTEM_INFO si;
    GetSystemInfo(&si);
    info.total_cores = (int)si.dwNumberOfProcessors;
    if (info.total_cores < 1) {
        info.total_cores = SKIP_ONE;
    }
    info.perf_cores = info.total_cores;

    MEMORYSTATUSEX ms;
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        info.total_ram = (size_t)ms.ullTotalPhys;
    }

    return info;
}
#endif

/* ── Public API ──────────────────────────────────────────────────── */

static int info_cached = 0;
static ctx_system_info_t cached_info;

ctx_system_info_t ctx_system_info(void) {
    if (!info_cached) {
#ifdef _WIN32
        cached_info = detect_system_windows();
#elif defined(__APPLE__)
        cached_info = detect_system_macos();
#else
        cached_info = detect_system_linux();
#endif
        info_cached = SKIP_ONE;
    }
    return cached_info;
}

int ctx_default_worker_count(bool initial) {
    ctx_system_info_t info = ctx_system_info();

    /* CTX_WORKERS env override (applies to both initial and incremental).
     * Clamped to a sane max to defend against typos like CTX_WORKERS=1000. */
    char buf[CTX_SZ_32];
    const char *env_val = ctx_safe_getenv("CTX_WORKERS", buf, sizeof(buf), NULL);
    if (env_val && env_val[0]) {
        char *end = NULL;
        long parsed = strtol(env_val, &end, CTX_DECIMAL_BASE);
        if (end && end != env_val && parsed > 0) {
            int max_workers = info.total_cores * WORKER_OVERRIDE_MAX_MULT;
            int requested = (int)parsed;
            int clamped = requested > max_workers ? max_workers : requested;
            return clamped > 0 ? clamped : MIN_WORKERS;
        }
    }

    if (initial) {
        /* Use cores for initial indexing — but cap by RAM headroom so we
         * don't launch 14 workers on a 24 GB machine and OOM. Assume each
         * worker needs ~2 GB of headroom for parser + arena state. */
        size_t ram_gb = info.total_ram /
                        ((size_t)CTX_SZ_1K * CTX_SZ_1K * CTX_SZ_1K);
        int by_ram = (int)(ram_gb / WORKER_RAM_GB_PER_WORKER);
        int workers = info.total_cores < by_ram ? info.total_cores : by_ram;
        return workers > 0 ? workers : MIN_WORKERS;
    }

    /* Incremental: leave headroom for user's apps */
    int workers = info.perf_cores - SKIP_ONE;
    return workers > 0 ? workers : MIN_WORKERS;
}

/*
 * system_info.c — CPU topology, cache, and RAM detection.
 *
 * macOS: sysctlbyname for core counts + cache, vm_statistics64 for free RAM.
 * Linux: sysconf + /proc/meminfo + sysinfo().
 * Windows: GetSystemInfo + GlobalMemoryStatusEx.
 *
 * Results are cached after first call (immutable hardware properties).
 */
#include "foundation/platform.h"
#include <stdint.h> // uint64_t
#include <string.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#elif defined(__APPLE__)
#include <sys/sysctl.h>
#include <mach/mach_host.h> // host_info64_t, host_page_size, HOST_VM_INFO64, mach_host_self, mach_port_t
#include <mach/mach_init.h>     // mach_host_self (direct provider)
#include <mach/kern_return.h>   // KERN_SUCCESS
// NOLINTNEXTLINE(misc-include-cleaner) — vm_types.h included for interface contract
#include <mach/vm_types.h>      // vm_size_t
// NOLINTNEXTLINE(misc-include-cleaner) — mach_types.h included for interface contract
#include <mach/mach_types.h>    // mach_msg_type_number_t
#include <mach/vm_statistics.h> // vm_statistics64_data_t, HOST_VM_INFO64_COUNT
#else                           /* Linux */
#include <unistd.h>
#include <sys/sysinfo.h>
#include <stdio.h>
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
    /* Try 64-bit variant */
    uint64_t val64 = 0;
    len = sizeof(val64);
    if (sysctlbyname(name, &val64, &len, NULL, 0) == 0 && val64 > 0) {
        return (size_t)val64;
    }
    return fallback;
}

static size_t get_free_ram_macos(void) {
    // NOLINTNEXTLINE(misc-include-cleaner) — mach_port_t provided by standard header
    mach_port_t host = mach_host_self();
    vm_statistics64_data_t stats = {0};
    // NOLINTNEXTLINE(misc-include-cleaner) — mach_msg_type_number_t provided by standard header
    mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
    // NOLINTNEXTLINE(misc-include-cleaner) — HOST_VM_INFO64 provided by standard header
    if (host_statistics64(host, HOST_VM_INFO64, (host_info64_t)&stats, &count) != KERN_SUCCESS) {
        return 0;
    }
    // NOLINTNEXTLINE(misc-include-cleaner) — vm_size_t provided by standard header
    vm_size_t page_size = 0;
    host_page_size(host, &page_size);
    return (size_t)(stats.free_count + stats.inactive_count) * (size_t)page_size;
}

static cbm_system_info_t detect_system_macos(void) {
    cbm_system_info_t info;
    memset(&info, 0, sizeof(info));

    info.total_cores = sysctl_int("hw.ncpu", 1);
    info.perf_cores = sysctl_int("hw.perflevel0.physicalcpu", info.total_cores);
    info.efficiency_cores = sysctl_int("hw.perflevel1.physicalcpu", 0);

    /* If perflevel sysctls fail (Intel Mac), perf = total, eff = 0 */
    if (info.perf_cores + info.efficiency_cores > info.total_cores) {
        info.perf_cores = info.total_cores;
        info.efficiency_cores = 0;
    }

    info.cache_line_size = sysctl_int("hw.cachelinesize", 64);
    info.total_ram = sysctl_size("hw.memsize", 0);
    info.free_ram = get_free_ram_macos();

    /* L2 cache per cluster */
    info.l2_cache_perf = sysctl_size("hw.perflevel0.l2cachesize", sysctl_size("hw.l2cachesize", 0));
    info.l2_cache_eff = sysctl_size("hw.perflevel1.l2cachesize", 0);

    return info;
}

#else /* Linux */

static size_t parse_meminfo_field(const char *field) {
    FILE *f = fopen("/proc/meminfo", "r");
    if (!f)
        return 0;
    char line[256];
    size_t val = 0;
    size_t field_len = strlen(field);
    while (fgets(line, sizeof(line), f)) {
        if (strncmp(line, field, field_len) == 0) {
            /* Format: "MemFree:       12345 kB" */
            const char *p = line + field_len;
            while (*p == ' ' || *p == ':')
                p++;
            val = (size_t)strtoull(p, NULL, 10) * 1024ULL; /* kB → bytes */
            break;
        }
    }
    fclose(f);
    return val;
}

static cbm_system_info_t detect_system_linux(void) {
    cbm_system_info_t info;
    memset(&info, 0, sizeof(info));

    long nprocs = sysconf(_SC_NPROCESSORS_ONLN);
    info.total_cores = nprocs > 0 ? (int)nprocs : 1;
    info.perf_cores = info.total_cores; /* Linux doesn't distinguish P/E */
    info.efficiency_cores = 0;

    info.cache_line_size = 64; /* Standard for x86-64 */
    long cls = sysconf(_SC_LEVEL1_DCACHE_LINESIZE);
    if (cls > 0)
        info.cache_line_size = (int)cls;

    /* RAM via sysinfo */
    struct sysinfo si;
    if (sysinfo(&si) == 0) {
        info.total_ram = (size_t)si.totalram * (size_t)si.mem_unit;
        info.free_ram = (size_t)(si.freeram + si.bufferram) * (size_t)si.mem_unit;
    }

    /* More accurate free RAM from /proc/meminfo (includes cached) */
    size_t avail = parse_meminfo_field("MemAvailable");
    if (avail > 0)
        info.free_ram = avail;

    /* L2 cache */
    long l2 = sysconf(_SC_LEVEL2_CACHE_SIZE);
    info.l2_cache_perf = l2 > 0 ? (size_t)l2 : 0;
    info.l2_cache_eff = 0;

    return info;
}

#endif /* __APPLE__ / Linux */

/* ── Windows detection ───────────────────────────────────────────── */

#ifdef _WIN32
static cbm_system_info_t detect_system_windows(void) {
    cbm_system_info_t info;
    memset(&info, 0, sizeof(info));

    SYSTEM_INFO si;
    GetSystemInfo(&si);
    info.total_cores = (int)si.dwNumberOfProcessors;
    if (info.total_cores < 1) {
        info.total_cores = 1;
    }
    info.perf_cores = info.total_cores; /* Windows doesn't expose P/E cores */
    info.efficiency_cores = 0;

    MEMORYSTATUSEX ms;
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        info.total_ram = (size_t)ms.ullTotalPhys;
        info.free_ram = (size_t)ms.ullAvailPhys;
    }

    info.cache_line_size = 64; /* Standard for x86-64 */
    info.l2_cache_perf = 0;    /* TODO: GetLogicalProcessorInformation for cache topology */
    info.l2_cache_eff = 0;

    return info;
}
#endif

/* ── Public API ──────────────────────────────────────────────────── */

static int info_cached = 0;
static cbm_system_info_t cached_info;

cbm_system_info_t cbm_system_info(void) {
    if (!info_cached) {
#ifdef _WIN32
        cached_info = detect_system_windows();
#elif defined(__APPLE__)
        cached_info = detect_system_macos();
#else
        cached_info = detect_system_linux();
#endif
        info_cached = 1;
    }
    return cached_info;
}

int cbm_default_worker_count(bool initial) {
    cbm_system_info_t info = cbm_system_info();
    if (initial) {
        /* Use all cores for initial indexing — user is waiting */
        return info.total_cores;
    }
    /* Incremental: leave headroom for user's apps */
    int workers = info.perf_cores - 1;
    return workers > 0 ? workers : 1;
}

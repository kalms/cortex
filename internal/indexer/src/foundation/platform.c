/*
 * platform.c — OS abstraction implementations.
 *
 * macOS, Linux, and Windows. Platform-specific code behind #ifdef guards.
 */
#include "platform.h"

#include "foundation/compat.h"
#include "foundation/constants.h"
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifdef _WIN32

/* ── Windows implementation ───────────────────────────────────── */

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <io.h>
#include <sys/stat.h>

void *ctx_mmap_read(const char *path, size_t *out_size) {
    if (!path || !out_size) {
        return NULL;
    }
    *out_size = 0;

    HANDLE file = CreateFileA(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                              FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        return NULL;
    }
    LARGE_INTEGER sz;
    if (!GetFileSizeEx(file, &sz) || sz.QuadPart == 0) {
        CloseHandle(file);
        return NULL;
    }
    HANDLE mapping = CreateFileMappingA(file, NULL, PAGE_READONLY, 0, 0, NULL);
    if (!mapping) {
        CloseHandle(file);
        return NULL;
    }
    void *addr = MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, 0);
    CloseHandle(mapping);
    CloseHandle(file);
    if (!addr) {
        return NULL;
    }
    *out_size = (size_t)sz.QuadPart;
    return addr;
}

void ctx_munmap(void *addr, size_t size) {
    (void)size;
    if (addr) {
        UnmapViewOfFile(addr);
    }
}

uint64_t ctx_now_ns(void) {
    LARGE_INTEGER freq, count;
    QueryPerformanceFrequency(&freq);
    QueryPerformanceCounter(&count);
    return (uint64_t)count.QuadPart * 1000000000ULL / (uint64_t)freq.QuadPart;
}

#define CTX_USEC_PER_SEC 1000000ULL

uint64_t ctx_now_ms(void) {
    return ctx_now_ns() / CTX_USEC_PER_SEC;
}

int ctx_nprocs(void) {
    SYSTEM_INFO si;
    GetSystemInfo(&si);
    return (int)si.dwNumberOfProcessors > 0 ? (int)si.dwNumberOfProcessors : 1;
}

bool ctx_file_exists(const char *path) {
    DWORD attr = GetFileAttributesA(path);
    return attr != INVALID_FILE_ATTRIBUTES;
}

bool ctx_is_dir(const char *path) {
    DWORD attr = GetFileAttributesA(path);
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY);
}

int64_t ctx_file_size(const char *path) {
    WIN32_FILE_ATTRIBUTE_DATA fad;
    if (!GetFileAttributesExA(path, GetFileExInfoStandard, &fad)) {
        return CTX_NOT_FOUND;
    }
    LARGE_INTEGER sz;
    sz.HighPart = (LONG)fad.nFileSizeHigh; // cppcheck-suppress unreadVariable
    sz.LowPart = fad.nFileSizeLow;         // cppcheck-suppress unreadVariable
    return (int64_t)sz.QuadPart;
}

char *ctx_normalize_path_sep(char *path) {
    if (path) {
        for (char *p = path; *p; p++) {
            if (*p == '\\') {
                *p = '/';
            }
        }
    }
    return path;
}

#else /* POSIX (macOS + Linux) */

/* ── POSIX implementation ─────────────────────────────────────── */

#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <time.h>

#ifdef __APPLE__
#include <mach/mach_time.h>
#include <sys/sysctl.h>
#else
#include <sched.h>
#endif

/* ── Memory mapping ────────────────────────────────────────────── */

void *ctx_mmap_read(const char *path, size_t *out_size) {
    if (!path || !out_size) {
        return NULL;
    }
    *out_size = 0;

    int fd = open(path, O_RDONLY);
    if (fd < 0) {
        return NULL;
    }

    struct stat st;
    if (fstat(fd, &st) != 0 || st.st_size == 0) {
        close(fd);
        return NULL;
    }

    void *addr = mmap(NULL, (size_t)st.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    close(fd);

    if (addr == MAP_FAILED) {
        return NULL;
    }
    *out_size = (size_t)st.st_size;
    return addr;
}

void ctx_munmap(void *addr, size_t size) {
    if (addr && size > 0) {
        munmap(addr, size);
    }
}

/* ── Timing ────────────────────────────────────────────────────── */

#ifdef __APPLE__
static mach_timebase_info_data_t timebase_info;
static int timebase_init = 0;

uint64_t ctx_now_ns(void) {
    if (!timebase_init) {
        mach_timebase_info(&timebase_info);
        timebase_init = SKIP_ONE;
    }
    uint64_t ticks = mach_absolute_time();
    return ticks * timebase_info.numer / timebase_info.denom;
}
#else
uint64_t ctx_now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000000ULL + (uint64_t)ts.tv_nsec;
}
#endif

#define CTX_USEC_PER_SEC 1000000ULL

uint64_t ctx_now_ms(void) {
    return ctx_now_ns() / CTX_USEC_PER_SEC;
}

/* ── System info ───────────────────────────────────────────────── */

int ctx_nprocs(void) {
#ifdef __APPLE__
    int ncpu = 0;
    size_t len = sizeof(ncpu);
    if (sysctlbyname("hw.ncpu", &ncpu, &len, NULL, 0) == 0 && ncpu > 0) {
        return ncpu;
    }
    enum { FILE_EXISTS = 1 };
    return FILE_EXISTS;
#else
    long n = sysconf(_SC_NPROCESSORS_ONLN);
    return n > 0 ? (int)n : 1;
#endif
}

/* ── File system ───────────────────────────────────────────────── */

bool ctx_file_exists(const char *path) {
    struct stat st;
    return stat(path, &st) == 0;
}

bool ctx_is_dir(const char *path) {
    struct stat st;
    return stat(path, &st) == 0 && S_ISDIR(st.st_mode);
}

int64_t ctx_file_size(const char *path) {
    struct stat st;
    if (stat(path, &st) != 0) {
        return CTX_NOT_FOUND;
    }
    return (int64_t)st.st_size;
}

char *ctx_normalize_path_sep(char *path) {
    /* Normalize on ALL platforms — backslash paths can arrive via stored
     * data, cross-platform DB files, or Windows-style arguments. */
    if (path) {
        for (char *p = path; *p; p++) {
            if (*p == '\\') {
                *p = '/';
            }
        }
    }
    return path;
}

#endif /* _WIN32 */

/* ── Environment variables ────────────────────────────────────── */

/* Thread-safe getenv: iterates environ directly instead of calling getenv().
 * getenv() is flagged by concurrency-mt-unsafe because the returned pointer
 * can be invalidated by setenv/putenv in another thread. We copy to a
 * caller-owned buffer immediately. */
#ifdef _WIN32
#include <stdlib.h>
#define CTX_ENVIRON _environ
#elif defined(__APPLE__)
#include <crt_externs.h>
#define CTX_ENVIRON (*_NSGetEnviron())
#else
extern char **environ;
#define CTX_ENVIRON environ
#endif

const char *ctx_safe_getenv(const char *name, char *buf, size_t buf_sz, const char *fallback) {
    char **env = CTX_ENVIRON;
    if (env) {
        size_t nlen = strlen(name);
        for (; *env; env++) {
            if (strncmp(*env, name, nlen) == 0 && (*env)[nlen] == '=') {
                snprintf(buf, buf_sz, "%s", *env + nlen + SKIP_ONE);
                return buf;
            }
        }
    }
    if (fallback) {
        snprintf(buf, buf_sz, "%s", fallback);
        return buf;
    }
    buf[0] = '\0';
    return NULL;
}

/* ── Home directory (cross-platform) ──────────────────────────── */

const char *ctx_get_home_dir(void) {
    static char buf[CTX_SZ_1K];
    char tmp[CTX_SZ_256] = "";

    ctx_safe_getenv("HOME", tmp, sizeof(tmp), NULL);
    if (tmp[0]) {
        snprintf(buf, sizeof(buf), "%s", tmp);
        ctx_normalize_path_sep(buf);
        return buf;
    }

    ctx_safe_getenv("USERPROFILE", tmp, sizeof(tmp), NULL);
    if (tmp[0]) {
        snprintf(buf, sizeof(buf), "%s", tmp);
        ctx_normalize_path_sep(buf);
        return buf;
    }
    return NULL;
}

/* ── App config directories (cross-platform) ─────────────────── */

const char *ctx_app_config_dir(void) {
    static char buf[CTX_SZ_1K];
    char tmp[CTX_SZ_256] = "";
#ifdef _WIN32
    ctx_safe_getenv("APPDATA", tmp, sizeof(tmp), NULL);
    if (tmp[0]) {
        snprintf(buf, sizeof(buf), "%s", tmp);
        ctx_normalize_path_sep(buf);
        return buf;
    }
    const char *home = ctx_get_home_dir();
    if (home) {
        snprintf(buf, sizeof(buf), "%s/AppData/Roaming", home);
        return buf;
    }
    return NULL;
#else
    /* Linux: XDG_CONFIG_HOME or ~/.config */
    ctx_safe_getenv("XDG_CONFIG_HOME", tmp, sizeof(tmp), NULL);
    if (tmp[0]) {
        snprintf(buf, sizeof(buf), "%s", tmp);
        return buf;
    }
    const char *home = ctx_get_home_dir();
    if (home) {
        snprintf(buf, sizeof(buf), "%s/.config", home);
        return buf;
    }
    return NULL;
#endif /* _WIN32 */
}

const char *ctx_app_local_dir(void) {
#ifdef _WIN32
    static char buf[CTX_SZ_1K];
    char tmp[CTX_SZ_256] = "";
    ctx_safe_getenv("LOCALAPPDATA", tmp, sizeof(tmp), NULL);
    if (tmp[0]) {
        snprintf(buf, sizeof(buf), "%s", tmp);
        ctx_normalize_path_sep(buf);
        return buf;
    }
    const char *home = ctx_get_home_dir();
    if (home) {
        snprintf(buf, sizeof(buf), "%s/AppData/Local", home);
        return buf;
    }
    return NULL;
#else
    return ctx_app_config_dir();
#endif
}

/* ── Cache directory ─────────────────────────────────────────── */

const char *ctx_resolve_cache_dir(void) {
    static char buf[CTX_SZ_1K];
    char tmp[CTX_SZ_256] = "";
    ctx_safe_getenv("CTX_CACHE_DIR", tmp, sizeof(tmp), NULL);
    if (tmp[0]) {
        snprintf(buf, sizeof(buf), "%s", tmp);
        ctx_normalize_path_sep(buf);
        return buf;
    }
    const char *home = ctx_get_home_dir();
    if (!home) {
        return NULL;
    }
    snprintf(buf, sizeof(buf), "%s/.cache/codebase-memory-mcp", home);
    return buf;
}

const char *ctx_resolve_db_path(const char *project, char *buf, size_t bufsz) {
    if (!buf || bufsz == 0) {
        return NULL;
    }
    char tmp[CTX_SZ_1K];
    ctx_safe_getenv("CORTEX_DB", tmp, sizeof(tmp), NULL);
    if (tmp[0]) {
        snprintf(buf, bufsz, "%s", tmp);
        return buf;
    }
    if (!project) {
        return NULL;
    }
    const char *cdir = ctx_resolve_cache_dir();
    if (!cdir) {
        cdir = ctx_tmpdir();
    }
    snprintf(buf, bufsz, "%s/%s.db", cdir, project);
    return buf;
}

/*
 * profile.h — Activatable fine-grained performance profiling.
 *
 * Enable via environment variable: CTX_PROFILE=1 (or any non-empty non-"0" value)
 * Init is called once at program startup (from main.c).
 *
 * When disabled (default), the CTX_PROF_* macros cost one load + branch,
 * effectively zero overhead.
 *
 * Output format (structured log lines, parseable):
 *   level=info msg=prof phase=<pass> sub=<subphase> ms=<N> us=<N> items=<N> rate_per_s=<N>
 *
 * Grep for `msg=prof` to get a full profile report.
 */
#ifndef CTX_PROFILE_H
#define CTX_PROFILE_H

#include <stdbool.h>
#include <time.h>

/* Runtime-active flag. Set once by ctx_profile_init() from CTX_PROFILE env. */
extern bool ctx_profile_active;

/* Initialize profiling — reads CTX_PROFILE env var. Call once at startup. */
void ctx_profile_init(void);

/* Force-enable profiling at runtime (used by CLI --profile flag). */
void ctx_profile_enable(void);

/* Get a high-resolution timestamp. */
void ctx_profile_now(struct timespec *ts);

/* Log elapsed time since `start` for the given phase/subphase.
 * `items` = optional count to compute rate (pass 0 to skip). */
void ctx_profile_log_elapsed(const char *phase, const char *sub, const struct timespec *start,
                             long items);

/* Zero-overhead macros: a single runtime check gates everything. */
#define CTX_PROF_START(var) \
    struct timespec var;    \
    if (ctx_profile_active) \
    ctx_profile_now(&(var))

#define CTX_PROF_END(phase, sub, start_var)                           \
    do {                                                              \
        if (ctx_profile_active) {                                     \
            ctx_profile_log_elapsed((phase), (sub), &(start_var), 0); \
        }                                                             \
    } while (0)

#define CTX_PROF_END_N(phase, sub, start_var, items)                              \
    do {                                                                          \
        if (ctx_profile_active) {                                                 \
            ctx_profile_log_elapsed((phase), (sub), &(start_var), (long)(items)); \
        }                                                                         \
    } while (0)

#endif /* CTX_PROFILE_H */

/*
 * userconfig.h — User-defined file extension → language mappings.
 *
 * Reads extra_extensions from two optional JSON config files:
 *   Global:  $XDG_CONFIG_HOME/cortex-indexer/config.json
 *            (falls back to ~/.config/cortex-indexer/config.json)
 *   Project: {repo_root}/.codebase-memory.json
 *
 * Project config wins over global. Unknown language values warn and are
 * skipped (fail-open). Missing files are silently ignored.
 *
 * Format:
 *   {"extra_extensions": {".blade.php": "php", ".mjs": "javascript"}}
 *
 * The language string matching is case-insensitive.
 */
#ifndef CTX_USERCONFIG_H
#define CTX_USERCONFIG_H

#include "extract.h" /* CtxLanguage */

/* ── Types ──────────────────────────────────────────────────────── */

typedef struct {
    char *ext;        /* file extension including dot, e.g. ".blade.php" */
    CtxLanguage lang; /* resolved language enum */
} ctx_userext_t;

typedef struct {
    ctx_userext_t *entries; /* heap-allocated array */
    int count;              /* number of entries */
} ctx_userconfig_t;

/* ── API ────────────────────────────────────────────────────────── */

/*
 * Load user config from global + project files, merge (project wins).
 * repo_path: absolute path to the repository root (for project config).
 * Returns a heap-allocated ctx_userconfig_t (caller must free via
 * ctx_userconfig_free). Returns NULL only on allocation failure.
 * Missing config files are silently ignored.
 */
ctx_userconfig_t *ctx_userconfig_load(const char *repo_path);

/*
 * Look up a file extension in the user config.
 * ext: extension including dot, e.g. ".blade.php"
 * Returns the mapped CtxLanguage, or CTX_LANG_COUNT if not found.
 */
CtxLanguage ctx_userconfig_lookup(const ctx_userconfig_t *cfg, const char *ext);

/* Free a ctx_userconfig_t returned by ctx_userconfig_load. NULL-safe. */
void ctx_userconfig_free(ctx_userconfig_t *cfg);

/* ── Integration hook ───────────────────────────────────────────── */

/*
 * Set the process-global user config that ctx_language_for_extension()
 * will consult before the built-in table.
 * cfg may be NULL to clear the override.
 * Not thread-safe — call before spawning worker threads.
 */
void ctx_set_user_lang_config(const ctx_userconfig_t *cfg);

/*
 * Get the currently active process-global user config.
 * Returns NULL if none has been set.
 * Called internally by ctx_language_for_extension().
 */
const ctx_userconfig_t *ctx_get_user_lang_config(void);

#endif /* CTX_USERCONFIG_H */

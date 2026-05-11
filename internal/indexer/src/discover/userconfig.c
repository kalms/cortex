/*
 * userconfig.c — User-defined extension→language mappings.
 *
 * Reads extra_extensions from:
 *   Global:  $XDG_CONFIG_HOME/codebase-memory-mcp/config.json
 *            (falls back to ~/.config/codebase-memory-mcp/config.json)
 *   Project: {repo_root}/.codebase-memory.json
 *
 * Project config wins over global. Unknown language values warn and are
 * skipped (fail-open). Missing files are silently ignored.
 */
#include "discover/userconfig.h"
#include "cbm.h" /* CtxLanguage, CTX_LANG_* */
#include "foundation/constants.h"
#include "foundation/platform.h" /* ctx_safe_getenv */

enum { MAX_CONFIG_SIZE = 65536 };
#include "foundation/log.h"

#include <yyjson/yyjson.h>

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Process-global user config pointer ──────────────────────────── */

static const ctx_userconfig_t *g_userconfig = NULL;

void ctx_set_user_lang_config(const ctx_userconfig_t *cfg) {
    g_userconfig = cfg;
}

const ctx_userconfig_t *ctx_get_user_lang_config(void) {
    return g_userconfig;
}

/* ── Language name → enum table ──────────────────────────────────── */

/*
 * Reverse-mapping from lowercase language name strings to CtxLanguage.
 * Covers all names exposed by ctx_language_name() plus common aliases.
 */
typedef struct {
    const char *name; /* lowercase */
    CtxLanguage lang;
} lang_name_entry_t;

static const lang_name_entry_t LANG_NAME_TABLE[] = {
    {"go", CTX_LANG_GO},
    {"python", CTX_LANG_PYTHON},
    {"javascript", CTX_LANG_JAVASCRIPT},
    {"typescript", CTX_LANG_TYPESCRIPT},
    {"tsx", CTX_LANG_TSX},
    {"rust", CTX_LANG_RUST},
    {"java", CTX_LANG_JAVA},
    {"c++", CTX_LANG_CPP},
    {"cpp", CTX_LANG_CPP},
    {"c#", CTX_LANG_CSHARP},
    {"csharp", CTX_LANG_CSHARP},
    {"php", CTX_LANG_PHP},
    {"lua", CTX_LANG_LUA},
    {"scala", CTX_LANG_SCALA},
    {"kotlin", CTX_LANG_KOTLIN},
    {"ruby", CTX_LANG_RUBY},
    {"c", CTX_LANG_C},
    {"bash", CTX_LANG_BASH},
    {"sh", CTX_LANG_BASH},
    {"zig", CTX_LANG_ZIG},
    {"elixir", CTX_LANG_ELIXIR},
    {"haskell", CTX_LANG_HASKELL},
    {"ocaml", CTX_LANG_OCAML},
    {"objective-c", CTX_LANG_OBJC},
    {"objc", CTX_LANG_OBJC},
    {"swift", CTX_LANG_SWIFT},
    {"dart", CTX_LANG_DART},
    {"perl", CTX_LANG_PERL},
    {"groovy", CTX_LANG_GROOVY},
    {"erlang", CTX_LANG_ERLANG},
    {"r", CTX_LANG_R},
    {"html", CTX_LANG_HTML},
    {"css", CTX_LANG_CSS},
    {"scss", CTX_LANG_SCSS},
    {"yaml", CTX_LANG_YAML},
    {"toml", CTX_LANG_TOML},
    {"hcl", CTX_LANG_HCL},
    {"terraform", CTX_LANG_HCL},
    {"sql", CTX_LANG_SQL},
    {"dockerfile", CTX_LANG_DOCKERFILE},
    {"clojure", CTX_LANG_CLOJURE},
    {"f#", CTX_LANG_FSHARP},
    {"fsharp", CTX_LANG_FSHARP},
    {"julia", CTX_LANG_JULIA},
    {"vimscript", CTX_LANG_VIMSCRIPT},
    {"nix", CTX_LANG_NIX},
    {"common lisp", CTX_LANG_COMMONLISP},
    {"commonlisp", CTX_LANG_COMMONLISP},
    {"lisp", CTX_LANG_COMMONLISP},
    {"elm", CTX_LANG_ELM},
    {"fortran", CTX_LANG_FORTRAN},
    {"cuda", CTX_LANG_CUDA},
    {"cobol", CTX_LANG_COBOL},
    {"verilog", CTX_LANG_VERILOG},
    {"emacs lisp", CTX_LANG_EMACSLISP},
    {"emacslisp", CTX_LANG_EMACSLISP},
    {"json", CTX_LANG_JSON},
    {"xml", CTX_LANG_XML},
    {"markdown", CTX_LANG_MARKDOWN},
    {"makefile", CTX_LANG_MAKEFILE},
    {"cmake", CTX_LANG_CMAKE},
    {"protobuf", CTX_LANG_PROTOBUF},
    {"graphql", CTX_LANG_GRAPHQL},
    {"vue", CTX_LANG_VUE},
    {"svelte", CTX_LANG_SVELTE},
    {"meson", CTX_LANG_MESON},
    {"glsl", CTX_LANG_GLSL},
    {"ini", CTX_LANG_INI},
    {"matlab", CTX_LANG_MATLAB},
    {"lean", CTX_LANG_LEAN},
    {"form", CTX_LANG_FORM},
    {"magma", CTX_LANG_MAGMA},
    {"wolfram", CTX_LANG_WOLFRAM},
};

#define LANG_NAME_TABLE_SIZE (sizeof(LANG_NAME_TABLE) / sizeof(LANG_NAME_TABLE[0]))

/*
 * Parse a language string (case-insensitive) to a CtxLanguage enum.
 * Returns CTX_LANG_COUNT if the string is not recognized.
 */
static CtxLanguage lang_from_string(const char *s) {
    if (!s || !s[0]) {
        return CTX_LANG_COUNT;
    }

    /* Build a lowercase copy for comparison */
    char lower[CTX_SZ_64];
    size_t i;
    for (i = 0; i < sizeof(lower) - SKIP_ONE && s[i]; i++) {
        lower[i] = (char)tolower((unsigned char)s[i]);
    }
    lower[i] = '\0';

    for (size_t j = 0; j < LANG_NAME_TABLE_SIZE; j++) {
        if (strcmp(LANG_NAME_TABLE[j].name, lower) == 0) {
            return LANG_NAME_TABLE[j].lang;
        }
    }
    return CTX_LANG_COUNT;
}

/* ── Config directory helper ─────────────────────────────────────── */

/* ctx_app_config_dir() is now in platform.c (cross-platform). */

/* ── JSON parsing ────────────────────────────────────────────────── */

/*
 * Parse extra_extensions from a yyjson object root.
 * Appends valid entries to *entries / *count (growing via realloc).
 * Project-level entries (from_project=true) are appended after global
 * entries so that a later dedup pass can prefer project values.
 *
 * Returns 0 on success, -1 on alloc failure.
 */
static int parse_extra_extensions(yyjson_val *root, ctx_userext_t **entries, int *count,
                                  const char *source_label) {
    if (!yyjson_is_obj(root)) {
        ctx_log_warn("userconfig.bad_root", "file", source_label);
        return 0;
    }

    yyjson_val *extra = yyjson_obj_get(root, "extra_extensions");
    if (!extra) {
        return 0; /* key absent — fine */
    }
    if (!yyjson_is_obj(extra)) {
        ctx_log_warn("userconfig.bad_extra_extensions", "file", source_label);
        return 0;
    }

    yyjson_obj_iter iter;
    yyjson_obj_iter_init(extra, &iter);
    yyjson_val *key;
    while ((key = yyjson_obj_iter_next(&iter)) != NULL) {
        yyjson_val *val = yyjson_obj_iter_get_val(key);

        const char *ext_str = yyjson_get_str(key);
        const char *lang_str = yyjson_get_str(val);

        if (!ext_str || !lang_str) {
            ctx_log_warn("userconfig.skip_non_string", "file", source_label);
            continue;
        }

        /* Extension must start with '.' */
        if (ext_str[0] != '.') {
            ctx_log_warn("userconfig.skip_bad_ext", "file", source_label, "ext", ext_str);
            continue;
        }

        CtxLanguage lang = lang_from_string(lang_str);
        if (lang == CTX_LANG_COUNT) {
            ctx_log_warn("userconfig.unknown_lang", "file", source_label, "lang", lang_str);
            continue; /* fail-open: skip unknown languages */
        }

        /* Grow the array */
        ctx_userext_t *tmp = realloc(*entries, (size_t)(*count + SKIP_ONE) * sizeof(ctx_userext_t));
        if (!tmp) {
            return CTX_NOT_FOUND;
        }
        *entries = tmp;

        char *ext_copy = strdup(ext_str);
        if (!ext_copy) {
            return CTX_NOT_FOUND;
        }

        (*entries)[*count].ext = ext_copy;
        (*entries)[*count].lang = lang;
        (*count)++;
    }
    return 0;
}

/*
 * Read a JSON file and parse extra_extensions from it.
 * Silently ignores missing files. Logs warnings for corrupt JSON.
 * Returns 0 on success (or absent file), -1 on alloc failure.
 */
static int load_config_file(const char *path, ctx_userext_t **entries, int *count) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        return 0; /* file absent — silently ignore */
    }

    if (fseek(f, 0, SEEK_END) != 0) {
        (void)fclose(f);
        return 0;
    }
    long len = ftell(f);
    if (fseek(f, 0, SEEK_SET) != 0) {
        (void)fclose(f);
        return 0;
    }

    if (len <= 0 || len > MAX_CONFIG_SIZE) {
        (void)fclose(f);
        if (len > MAX_CONFIG_SIZE) {
            ctx_log_warn("userconfig.file_too_large", "path", path);
        }
        return 0;
    }

    char *buf = malloc((size_t)len + SKIP_ONE);
    if (!buf) {
        (void)fclose(f);
        return CTX_NOT_FOUND;
    }

    size_t nread = fread(buf, SKIP_ONE, (size_t)len, f);
    (void)fclose(f);
    if (nread > (size_t)len) {
        nread = (size_t)len;
    }
    buf[nread] = '\0';

    yyjson_doc *doc = yyjson_read(buf, nread, 0);
    free(buf);

    if (!doc) {
        ctx_log_warn("userconfig.corrupt_json", "path", path);
        return 0; /* corrupt JSON — silently ignore (fail-open) */
    }

    yyjson_val *root = yyjson_doc_get_root(doc);
    int rc = parse_extra_extensions(root, entries, count, path);
    yyjson_doc_free(doc);
    return rc;
}

/* ── Public API ──────────────────────────────────────────────────── */

ctx_userconfig_t *ctx_userconfig_load(const char *repo_path) {
    ctx_userconfig_t *cfg = calloc(CTX_ALLOC_ONE, sizeof(ctx_userconfig_t));
    if (!cfg) {
        return NULL;
    }

    ctx_userext_t *entries = NULL;
    int count = 0;

    /* ── Step 1: Load global config ── */
    enum { PATH_BUF_SZ = 1280 };
    const char *cfg_base = ctx_app_config_dir();
    const char *cfg_fallback = cfg_base ? cfg_base : "/tmp";
    char global_path[PATH_BUF_SZ];
    snprintf(global_path, sizeof(global_path), "%s/codebase-memory-mcp/config.json", cfg_fallback);

    if (load_config_file(global_path, &entries, &count) != 0) {
        for (int i = 0; i < count; i++) {
            free(entries[i].ext);
        }
        free(entries);
        free(cfg);
        return NULL;
    }

    int global_count = count; /* entries[0..global_count) are from global */

    /* ── Step 2: Load project config ── */
    if (repo_path && repo_path[0]) {
        char project_path[PATH_BUF_SZ];
        snprintf(project_path, sizeof(project_path), "%s/.codebase-memory.json", repo_path);

        if (load_config_file(project_path, &entries, &count) != 0) {
            /* Free already-allocated entries */
            for (int i = 0; i < count; i++) {
                free(entries[i].ext);
            }
            free(entries);
            free(cfg);
            return NULL;
        }
    }

    /*
     * ── Step 3: Dedup — project entries win over global ──
     *
     * For any extension that appears in both global (indices 0..global_count)
     * and project (indices global_count..count), remove the global entry by
     * replacing it with the last global entry (order-insensitive dedup).
     */
    for (int p = global_count; p < count; p++) {
        for (int g = 0; g < global_count; g++) {
            if (entries[g].ext && strcmp(entries[g].ext, entries[p].ext) == 0) {
                /* Remove global entry: overwrite with last global entry */
                free(entries[g].ext);
                entries[g] = entries[global_count - SKIP_ONE];
                entries[global_count - SKIP_ONE].ext = NULL; /* mark as consumed */
                global_count--;
                break;
            }
        }
    }

    /*
     * Compact: remove any NULL-ext slots left by the dedup step.
     * (Those are the consumed "last global" entries.)
     */
    int write_idx = 0;
    for (int i = 0; i < count; i++) {
        if (entries[i].ext != NULL) {
            entries[write_idx++] = entries[i];
        }
    }
    count = write_idx;

    cfg->entries = entries;
    cfg->count = count;
    return cfg;
}

CtxLanguage ctx_userconfig_lookup(const ctx_userconfig_t *cfg, const char *ext) {
    if (!cfg || !ext || !ext[0]) {
        return CTX_LANG_COUNT;
    }
    for (int i = 0; i < cfg->count; i++) {
        if (cfg->entries[i].ext && strcmp(cfg->entries[i].ext, ext) == 0) {
            return cfg->entries[i].lang;
        }
    }
    return CTX_LANG_COUNT;
}

void ctx_userconfig_free(ctx_userconfig_t *cfg) {
    if (!cfg) {
        return;
    }
    for (int i = 0; i < cfg->count; i++) {
        free(cfg->entries[i].ext);
    }
    free(cfg->entries);
    free(cfg);
}

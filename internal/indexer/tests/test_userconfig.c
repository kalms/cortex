/*
 * test_userconfig.c — Tests for user-defined extension→language mappings.
 *
 * Tests ctx_userconfig_load(), ctx_userconfig_lookup(), and the
 * ctx_set_user_lang_config() / ctx_language_for_extension() integration.
 */
#include "../src/foundation/compat.h"
#include "../src/foundation/compat_fs.h"
#include "../src/foundation/platform.h"
#include "test_framework.h"
#include "discover/discover.h"
#include "discover/userconfig.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ── Helpers ─────────────────────────────────────────────────────── */

/* Write a JSON file to path. Returns 0 on success. */
static int write_json(const char *path, const char *json) {
    FILE *f = fopen(path, "w");
    if (!f) {
        return -1;
    }
    fputs(json, f);
    fclose(f);
    return 0;
}

/* ── Tests: project config ───────────────────────────────────────── */

TEST(userconfig_project_basic) {
    /* Write a .codebase-memory.json in a temp dir */
    char dir[256];
    snprintf(dir, sizeof(dir), "%s/uctest_proj_basic", ctx_tmpdir());
    ctx_mkdir_p(dir, 0755); /* from compat_fs.h via compat.h */

    char proj[512];
    snprintf(proj, sizeof(proj), "%s/.codebase-memory.json", dir);
    ASSERT_EQ(
        write_json(proj, "{\"extra_extensions\":{\".blade.php\":\"php\",\".mjs\":\"javascript\"}}"),
        0);

    ctx_userconfig_t *cfg = ctx_userconfig_load(dir);
    ASSERT_NOT_NULL(cfg);

    ASSERT_EQ(ctx_userconfig_lookup(cfg, ".blade.php"), CTX_LANG_PHP);
    ASSERT_EQ(ctx_userconfig_lookup(cfg, ".mjs"), CTX_LANG_JAVASCRIPT);
    ASSERT_EQ(ctx_userconfig_lookup(cfg, ".go"), CTX_LANG_COUNT); /* not in user config */

    ctx_userconfig_free(cfg);
    remove(proj);
    PASS();
}

/* ── Tests: global config ────────────────────────────────────────── */

TEST(userconfig_global_via_env) {
    /* Point config dir to a temp dir via the platform-appropriate env var:
     * XDG_CONFIG_HOME on Linux/macOS, APPDATA on Windows. */
    char cfg_dir[256];
    snprintf(cfg_dir, sizeof(cfg_dir), "%s/uctest_global_xdg", ctx_tmpdir());

    char app_dir[512];
    snprintf(app_dir, sizeof(app_dir), "%s/cortex-indexer", cfg_dir);
    ctx_mkdir_p(app_dir, 0755);

    char global_path[768];
    snprintf(global_path, sizeof(global_path), "%s/config.json", app_dir);
    ASSERT_EQ(
        write_json(global_path, "{\"extra_extensions\":{\".twig\":\"html\"}}"),
        0);

#ifdef _WIN32
    char old_appdata[512] = "";
    ctx_safe_getenv("APPDATA", old_appdata, sizeof(old_appdata), NULL);
    ctx_setenv("APPDATA", cfg_dir, 1);
#else
    ctx_setenv("XDG_CONFIG_HOME", cfg_dir, 1);
#endif
    ctx_userconfig_t *cfg = ctx_userconfig_load(NULL); /* no project dir */
#ifdef _WIN32
    if (old_appdata[0]) {
        ctx_setenv("APPDATA", old_appdata, 1);
    } else {
        ctx_unsetenv("APPDATA");
    }
#else
    ctx_unsetenv("XDG_CONFIG_HOME");
#endif

    ASSERT_NOT_NULL(cfg);
    ASSERT_EQ(ctx_userconfig_lookup(cfg, ".twig"), CTX_LANG_HTML);

    ctx_userconfig_free(cfg);
    remove(global_path);
    PASS();
}

/* ── Tests: project wins over global ────────────────────────────── */

TEST(userconfig_project_wins_over_global) {
    /* Global says .xyz → python; project says .xyz → rust */
    char xdg_dir[256];
    snprintf(xdg_dir, sizeof(xdg_dir), "%s/uctest_priority_xdg", ctx_tmpdir());

    char app_dir[512];
    snprintf(app_dir, sizeof(app_dir), "%s/cortex-indexer", xdg_dir);
    ctx_mkdir_p(app_dir, 0755);

    char global_path[768];
    snprintf(global_path, sizeof(global_path), "%s/config.json", app_dir);
    ASSERT_EQ(
        write_json(global_path, "{\"extra_extensions\":{\".xyz\":\"python\"}}"),
        0);

    char proj_dir[256];
    snprintf(proj_dir, sizeof(proj_dir), "%s/uctest_priority_proj", ctx_tmpdir());
    ctx_mkdir_p(proj_dir, 0755);

    char proj_path[512];
    snprintf(proj_path, sizeof(proj_path), "%s/.codebase-memory.json", proj_dir);
    ASSERT_EQ(
        write_json(proj_path, "{\"extra_extensions\":{\".xyz\":\"rust\"}}"),
        0);

    ctx_setenv("XDG_CONFIG_HOME", xdg_dir, 1);
    ctx_userconfig_t *cfg = ctx_userconfig_load(proj_dir);
    ctx_unsetenv("XDG_CONFIG_HOME");

    ASSERT_NOT_NULL(cfg);
    /* Project definition (rust) must win */
    ASSERT_EQ(ctx_userconfig_lookup(cfg, ".xyz"), CTX_LANG_RUST);

    ctx_userconfig_free(cfg);
    remove(global_path);
    remove(proj_path);
    PASS();
}

/* ── Tests: unknown language values are skipped ──────────────────── */

TEST(userconfig_unknown_lang_skipped) {
    char dir[256];
    snprintf(dir, sizeof(dir), "%s/uctest_unknown_lang", ctx_tmpdir());
    ctx_mkdir_p(dir, 0755);

    char proj[512];
    snprintf(proj, sizeof(proj), "%s/.codebase-memory.json", dir);
    /* "klingon" is not a valid language; ".wasm" should be silently skipped */
    ASSERT_EQ(
        write_json(proj,
                   "{\"extra_extensions\":{\".wasm\":\"klingon\",\".mjs\":\"javascript\"}}"),
        0);

    ctx_userconfig_t *cfg = ctx_userconfig_load(dir);
    ASSERT_NOT_NULL(cfg);

    /* .wasm with unknown lang → not in config */
    ASSERT_EQ(ctx_userconfig_lookup(cfg, ".wasm"), CTX_LANG_COUNT);
    /* .mjs with valid lang → present */
    ASSERT_EQ(ctx_userconfig_lookup(cfg, ".mjs"), CTX_LANG_JAVASCRIPT);

    ctx_userconfig_free(cfg);
    remove(proj);
    PASS();
}

/* ── Tests: missing files are silently ignored ───────────────────── */

TEST(userconfig_missing_files_ok) {
    /* Point to a non-existent repo dir */
    ctx_userconfig_t *cfg = ctx_userconfig_load("/tmp/__nonexistent_repo_12345__");
    ASSERT_NOT_NULL(cfg); /* must not return NULL — just empty */
    ASSERT_EQ(cfg->count, 0);
    ctx_userconfig_free(cfg);
    PASS();
}

/* ── Tests: integration with ctx_language_for_extension ─────────── */

TEST(userconfig_integration_override) {
    /* Verify that setting the global config makes ctx_language_for_extension
     * respect the override. We map ".blade.php" → PHP, which is not in the
     * built-in table. */
    char dir[256];
    snprintf(dir, sizeof(dir), "%s/uctest_integ", ctx_tmpdir());
    ctx_mkdir_p(dir, 0755);

    char proj[512];
    snprintf(proj, sizeof(proj), "%s/.codebase-memory.json", dir);
    ASSERT_EQ(
        write_json(proj, "{\"extra_extensions\":{\".blade.php\":\"php\"}}"),
        0);

    ctx_userconfig_t *cfg = ctx_userconfig_load(dir);
    ASSERT_NOT_NULL(cfg);

    /* Before setting, .blade.php is unknown */
    ASSERT_EQ(ctx_language_for_extension(".blade.php"), CTX_LANG_COUNT);

    ctx_set_user_lang_config(cfg);
    /* After setting, .blade.php → PHP */
    ASSERT_EQ(ctx_language_for_extension(".blade.php"), CTX_LANG_PHP);
    /* Built-in extensions still work */
    ASSERT_EQ(ctx_language_for_extension(".go"), CTX_LANG_GO);

    /* Clean up global state */
    ctx_set_user_lang_config(NULL);
    ctx_userconfig_free(cfg);
    remove(proj);
    PASS();
}

/* ── Tests: free is NULL-safe ────────────────────────────────────── */

TEST(userconfig_free_null) {
    ctx_userconfig_free(NULL); /* must not crash */
    PASS();
}

/* ── Suite ──────────────────────────────────────────────────────── */

SUITE(userconfig) {
    RUN_TEST(userconfig_project_basic);
    RUN_TEST(userconfig_global_via_env);
    RUN_TEST(userconfig_project_wins_over_global);
    RUN_TEST(userconfig_unknown_lang_skipped);
    RUN_TEST(userconfig_missing_files_ok);
    RUN_TEST(userconfig_integration_override);
    RUN_TEST(userconfig_free_null);
}

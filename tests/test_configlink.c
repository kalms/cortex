/*
 * test_configlink.c — Tests for config ↔ code linking strategies.
 *
 * Ported from internal/pipeline/configlink_test.go (9 tests).
 * Uses unit test approach: set up store state directly, run strategies,
 * check CONFIGURES edges.
 */
#include "test_framework.h"
#include "pipeline/pipeline.h"
#include "pipeline/pipeline_internal.h"
#include "store/store.h"

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

/* ── Helpers ─────────────────────────────────────────────────────── */

/* Helper to check if any CONFIGURES edge has a given strategy (parsed from JSON) */
static bool has_strategy(cbm_edge_t *edges, int count, const char *strategy) {
    char needle[64];
    snprintf(needle, sizeof(needle), "\"strategy\":\"%s\"", strategy);
    for (int i = 0; i < count; i++) {
        if (edges[i].properties_json && strstr(edges[i].properties_json, needle))
            return true;
    }
    return false;
}

/* Check if any CONFIGURES edge has given strategy AND confidence. */
static bool has_strategy_with_confidence(cbm_edge_t *edges, int count, const char *strategy,
                                         double confidence) {
    char strat_needle[64];
    snprintf(strat_needle, sizeof(strat_needle), "\"strategy\":\"%s\"", strategy);
    char conf_needle[64];
    snprintf(conf_needle, sizeof(conf_needle), "\"confidence\":%.2f", confidence);

    for (int i = 0; i < count; i++) {
        if (edges[i].properties_json && strstr(edges[i].properties_json, strat_needle) &&
            strstr(edges[i].properties_json, conf_needle))
            return true;
    }
    return false;
}

/* Check if any CONFIGURES edge has given strategy AND config_key. */
static bool has_strategy_with_key(cbm_edge_t *edges, int count, const char *strategy,
                                  const char *config_key) {
    char strat_needle[64];
    snprintf(strat_needle, sizeof(strat_needle), "\"strategy\":\"%s\"", strategy);
    char key_needle[128];
    snprintf(key_needle, sizeof(key_needle), "\"config_key\":\"%s\"", config_key);

    for (int i = 0; i < count; i++) {
        if (edges[i].properties_json && strstr(edges[i].properties_json, strat_needle) &&
            strstr(edges[i].properties_json, key_needle))
            return true;
    }
    return false;
}

/* Recursive remove */
static void rm_rf(const char *path) {
    char cmd[1024];
    snprintf(cmd, sizeof(cmd), "rm -rf '%s'", path);
    (void)system(cmd);
}

/* ── Strategy 1: Config Key → Code Symbol ───────────────────────── */

/* Go: TestConfigKeySymbol_ExactMatch
 * config.toml has max_connections, main.go has getMaxConnections() */
TEST(configlink_key_symbol_exact_match) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "test", "/tmp/test");

    /* Config Variable node: max_connections from config.toml */
    cbm_node_t cfg_var = {
        .project = "test",
        .label = "Variable",
        .name = "max_connections",
        .qualified_name = "test.config.max_connections",
        .file_path = "config.toml",
    };
    int64_t cfg_id = cbm_store_upsert_node(s, &cfg_var);
    ASSERT_GT(cfg_id, 0);

    /* Code Function node: getMaxConnections from main.go */
    cbm_node_t func = {
        .project = "test",
        .label = "Function",
        .name = "getMaxConnections",
        .qualified_name = "test.main.getMaxConnections",
        .file_path = "main.go",
    };
    int64_t func_id = cbm_store_upsert_node(s, &func);
    ASSERT_GT(func_id, 0);

    /* Run configlink */
    int n = cbm_pipeline_pass_configlink(s, "test", NULL);
    ASSERT_GT(n, 0);

    /* Check CONFIGURES edges */
    cbm_edge_t *edges = NULL;
    int count = 0;
    int rc = cbm_store_find_edges_by_type(s, "test", "CONFIGURES", &edges, &count);
    ASSERT_EQ(rc, CBM_STORE_OK);
    ASSERT_TRUE(has_strategy(edges, count, "key_symbol"));
    cbm_store_free_edges(edges, count);
    cbm_store_close(s);
    PASS();
}

/* Go: TestConfigKeySymbol_SubstringMatch
 * config.toml has request_timeout, main.go has getRequestTimeoutSeconds() */
TEST(configlink_key_symbol_substring_match) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "test", "/tmp/test");

    cbm_node_t cfg_var = {
        .project = "test",
        .label = "Variable",
        .name = "request_timeout",
        .qualified_name = "test.config.request_timeout",
        .file_path = "config.toml",
    };
    cbm_store_upsert_node(s, &cfg_var);

    cbm_node_t func = {
        .project = "test",
        .label = "Function",
        .name = "getRequestTimeoutSeconds",
        .qualified_name = "test.main.getRequestTimeoutSeconds",
        .file_path = "main.go",
    };
    cbm_store_upsert_node(s, &func);

    cbm_pipeline_pass_configlink(s, "test", NULL);

    cbm_edge_t *edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_type(s, "test", "CONFIGURES", &edges, &count);
    ASSERT_TRUE(has_strategy_with_confidence(edges, count, "key_symbol", 0.75));
    cbm_store_free_edges(edges, count);
    cbm_store_close(s);
    PASS();
}

/* Go: TestConfigKeySymbol_ShortKeySkipped
 * config.toml has port, host, name — all 1-token keys, should be skipped */
TEST(configlink_key_symbol_short_key_skipped) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "test", "/tmp/test");

    /* Short single-token config keys */
    const char *short_keys[] = {"port", "host", "name"};
    for (int i = 0; i < 3; i++) {
        char qn[64];
        snprintf(qn, sizeof(qn), "test.config.%s", short_keys[i]);
        cbm_node_t v = {
            .project = "test",
            .label = "Variable",
            .name = short_keys[i],
            .qualified_name = qn,
            .file_path = "config.toml",
        };
        cbm_store_upsert_node(s, &v);
    }

    cbm_node_t func = {
        .project = "test",
        .label = "Function",
        .name = "getPort",
        .qualified_name = "test.main.getPort",
        .file_path = "main.go",
    };
    cbm_store_upsert_node(s, &func);

    cbm_pipeline_pass_configlink(s, "test", NULL);

    cbm_edge_t *edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_type(s, "test", "CONFIGURES", &edges, &count);
    /* No key_symbol edges for 1-token keys */
    ASSERT_FALSE(has_strategy(edges, count, "key_symbol"));
    cbm_store_free_edges(edges, count);
    cbm_store_close(s);
    PASS();
}

/* Go: TestConfigKeySymbol_CamelCaseNormalization
 * config.json has maxRetryCount, handler.go has getMaxRetryCount() */
TEST(configlink_key_symbol_camel_case) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "test", "/tmp/test");

    cbm_node_t cfg_var = {
        .project = "test",
        .label = "Variable",
        .name = "maxRetryCount",
        .qualified_name = "test.config.maxRetryCount",
        .file_path = "config.json",
    };
    cbm_store_upsert_node(s, &cfg_var);

    cbm_node_t func = {
        .project = "test",
        .label = "Function",
        .name = "getMaxRetryCount",
        .qualified_name = "test.handler.getMaxRetryCount",
        .file_path = "handler.go",
    };
    cbm_store_upsert_node(s, &func);

    cbm_pipeline_pass_configlink(s, "test", NULL);

    cbm_edge_t *edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_type(s, "test", "CONFIGURES", &edges, &count);
    ASSERT_TRUE(has_strategy(edges, count, "key_symbol"));
    cbm_store_free_edges(edges, count);
    cbm_store_close(s);
    PASS();
}

/* Go: TestConfigKeySymbol_NoFalsePositive
 * config.toml has url — 1-token key, should not match parseURL */
TEST(configlink_key_symbol_no_false_positive) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "test", "/tmp/test");

    cbm_node_t cfg_var = {
        .project = "test",
        .label = "Variable",
        .name = "url",
        .qualified_name = "test.db.url",
        .file_path = "config.toml",
    };
    cbm_store_upsert_node(s, &cfg_var);

    cbm_node_t func = {
        .project = "test",
        .label = "Function",
        .name = "parseURL",
        .qualified_name = "test.main.parseURL",
        .file_path = "main.go",
    };
    cbm_store_upsert_node(s, &func);

    cbm_pipeline_pass_configlink(s, "test", NULL);

    cbm_edge_t *edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_type(s, "test", "CONFIGURES", &edges, &count);
    /* url is 1 token → skipped by key_symbol strategy */
    ASSERT_FALSE(has_strategy_with_key(edges, count, "key_symbol", "url"));
    cbm_store_free_edges(edges, count);
    cbm_store_close(s);
    PASS();
}

/* ── Strategy 2: Dependency → Import ────────────────────────────── */

/* Go: TestDependencyImport_PackageJson
 * package.json has express dep, app.js imports express */
TEST(configlink_dep_import_package_json) {
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, "test", "/tmp/test");

    /* Dependency Variable in package.json */
    cbm_node_t dep_var = {
        .project = "test",
        .label = "Variable",
        .name = "express",
        .qualified_name = "test.package.dependencies.express",
        .file_path = "package.json",
    };
    (void)cbm_store_upsert_node(s, &dep_var);

    /* Module node for app.js (source of import) */
    cbm_node_t app_mod = {
        .project = "test",
        .label = "Module",
        .name = "app",
        .qualified_name = "test.app",
        .file_path = "app.js",
    };
    int64_t app_id = cbm_store_upsert_node(s, &app_mod);

    /* Import target node (what 'express' resolves to) */
    cbm_node_t import_target = {
        .project = "test",
        .label = "Module",
        .name = "express",
        .qualified_name = "test.node_modules.express",
        .file_path = "node_modules/express/index.js",
    };
    int64_t target_id = cbm_store_upsert_node(s, &import_target);

    /* IMPORTS edge: app.js → express module */
    cbm_edge_t imp = {
        .project = "test",
        .source_id = app_id,
        .target_id = target_id,
        .type = "IMPORTS",
    };
    cbm_store_insert_edge(s, &imp);

    cbm_pipeline_pass_configlink(s, "test", NULL);

    cbm_edge_t *edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_type(s, "test", "CONFIGURES", &edges, &count);
    /* Should find dependency_import edge linking app.js to package.json dep */
    ASSERT_TRUE(has_strategy(edges, count, "dependency_import"));
    cbm_store_free_edges(edges, count);
    cbm_store_close(s);
    PASS();
}

/* ── Strategy 3: Config File Path → Code String Reference ───────── */

/* Go: TestConfigFileRef_ExactPath
 * main.go references "config/database.toml" in source code */
TEST(configlink_file_ref_exact_path) {
    /* Create temp directory with files */
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_cfglink_XXXXXX");
    ASSERT_NOT_NULL(mkdtemp(tmpdir));

    /* Create config/database.toml */
    char cfg_dir[512];
    snprintf(cfg_dir, sizeof(cfg_dir), "%s/config", tmpdir);
    mkdir(cfg_dir, 0755);

    char cfg_path[512];
    snprintf(cfg_path, sizeof(cfg_path), "%s/config/database.toml", tmpdir);
    FILE *f = fopen(cfg_path, "w");
    fprintf(f, "[database]\nhost = \"localhost\"\n");
    fclose(f);

    /* Create main.go that references the config file */
    char main_path[512];
    snprintf(main_path, sizeof(main_path), "%s/main.go", tmpdir);
    f = fopen(main_path, "w");
    fprintf(f, "package main\n\nfunc loadConfig() {\n"
               "\tcfg := readFile(\"config/database.toml\")\n"
               "\t_ = cfg\n}\n");
    fclose(f);

    /* Derive project name like the pipeline does */
    char *project = cbm_project_name_from_path(tmpdir);

    /* Set up store */
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, project, tmpdir);

    /* Config Module node */
    char cfg_mod_qn[256];
    char *tmp_qn = cbm_pipeline_fqn_module(project, "config/database.toml");
    snprintf(cfg_mod_qn, sizeof(cfg_mod_qn), "%s", tmp_qn);
    free(tmp_qn);

    cbm_node_t cfg_mod = {
        .project = project,
        .label = "Module",
        .name = "database",
        .qualified_name = cfg_mod_qn,
        .file_path = "config/database.toml",
    };
    cbm_store_upsert_node(s, &cfg_mod);

    /* Source Module node */
    char main_mod_qn[256];
    tmp_qn = cbm_pipeline_fqn_module(project, "main.go");
    snprintf(main_mod_qn, sizeof(main_mod_qn), "%s", tmp_qn);
    free(tmp_qn);

    cbm_node_t main_mod = {
        .project = project,
        .label = "Module",
        .name = "main",
        .qualified_name = main_mod_qn,
        .file_path = "main.go",
    };
    cbm_store_upsert_node(s, &main_mod);

    /* Run configlink with repo_path so strategy 3 can read files */
    cbm_pipeline_pass_configlink(s, project, tmpdir);

    cbm_edge_t *edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_type(s, project, "CONFIGURES", &edges, &count);
    ASSERT_TRUE(has_strategy(edges, count, "file_reference"));
    cbm_store_free_edges(edges, count);

    cbm_store_close(s);
    free(project);
    rm_rf(tmpdir);
    PASS();
}

/* Go: TestConfigFileRef_BasenameMatch
 * main.go references "settings.yaml" by basename */
TEST(configlink_file_ref_basename_match) {
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_cfglink_XXXXXX");
    ASSERT_NOT_NULL(mkdtemp(tmpdir));

    /* Create settings.yaml */
    char cfg_path[512];
    snprintf(cfg_path, sizeof(cfg_path), "%s/settings.yaml", tmpdir);
    FILE *f = fopen(cfg_path, "w");
    fprintf(f, "database:\n  host: localhost\n");
    fclose(f);

    /* Create main.go */
    char main_path[512];
    snprintf(main_path, sizeof(main_path), "%s/main.go", tmpdir);
    f = fopen(main_path, "w");
    fprintf(f, "package main\n\nfunc loadSettings() {\n"
               "\tcfg := readFile(\"settings.yaml\")\n"
               "\t_ = cfg\n}\n");
    fclose(f);

    char *project = cbm_project_name_from_path(tmpdir);
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, project, tmpdir);

    /* Config Module */
    char *cfg_qn = cbm_pipeline_fqn_module(project, "settings.yaml");
    cbm_node_t cfg_mod = {
        .project = project,
        .label = "Module",
        .name = "settings",
        .qualified_name = cfg_qn,
        .file_path = "settings.yaml",
    };
    cbm_store_upsert_node(s, &cfg_mod);

    /* Source Module */
    char *main_qn = cbm_pipeline_fqn_module(project, "main.go");
    cbm_node_t main_mod = {
        .project = project,
        .label = "Module",
        .name = "main",
        .qualified_name = main_qn,
        .file_path = "main.go",
    };
    cbm_store_upsert_node(s, &main_mod);

    cbm_pipeline_pass_configlink(s, project, tmpdir);

    cbm_edge_t *edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_type(s, project, "CONFIGURES", &edges, &count);
    /* Basename match should produce file_reference edge */
    ASSERT_TRUE(has_strategy(edges, count, "file_reference"));
    cbm_store_free_edges(edges, count);

    cbm_store_close(s);
    free(cfg_qn);
    free(main_qn);
    free(project);
    rm_rf(tmpdir);
    PASS();
}

/* Go: TestConfigFileRef_NoFalsePositive
 * main.go references "data.csv" — not a config extension */
TEST(configlink_file_ref_no_false_positive) {
    char tmpdir[256];
    snprintf(tmpdir, sizeof(tmpdir), "/tmp/cbm_cfglink_XXXXXX");
    ASSERT_NOT_NULL(mkdtemp(tmpdir));

    /* Create data.csv */
    char csv_path[512];
    snprintf(csv_path, sizeof(csv_path), "%s/data.csv", tmpdir);
    FILE *f = fopen(csv_path, "w");
    fprintf(f, "a,b,c\n");
    fclose(f);

    /* Create main.go referencing data.csv */
    char main_path[512];
    snprintf(main_path, sizeof(main_path), "%s/main.go", tmpdir);
    f = fopen(main_path, "w");
    fprintf(f, "package main\n\nfunc loadData() {\n"
               "\tf := readFile(\"data.csv\")\n"
               "\t_ = f\n}\n");
    fclose(f);

    char *project = cbm_project_name_from_path(tmpdir);
    cbm_store_t *s = cbm_store_open_memory();
    cbm_store_upsert_project(s, project, tmpdir);

    /* data.csv Module (NOT a config extension) */
    char *csv_qn = cbm_pipeline_fqn_module(project, "data.csv");
    cbm_node_t csv_mod = {
        .project = project,
        .label = "Module",
        .name = "data",
        .qualified_name = csv_qn,
        .file_path = "data.csv",
    };
    cbm_store_upsert_node(s, &csv_mod);

    /* Source Module */
    char *main_qn = cbm_pipeline_fqn_module(project, "main.go");
    cbm_node_t main_mod = {
        .project = project,
        .label = "Module",
        .name = "main",
        .qualified_name = main_qn,
        .file_path = "main.go",
    };
    cbm_store_upsert_node(s, &main_mod);

    cbm_pipeline_pass_configlink(s, project, tmpdir);

    cbm_edge_t *edges = NULL;
    int count = 0;
    cbm_store_find_edges_by_type(s, project, "CONFIGURES", &edges, &count);
    /* .csv is not a config extension — no file_reference edges */
    ASSERT_FALSE(has_strategy(edges, count, "file_reference"));
    cbm_store_free_edges(edges, count);

    cbm_store_close(s);
    free(csv_qn);
    free(main_qn);
    free(project);
    rm_rf(tmpdir);
    PASS();
}

/* ── Suite ───────────────────────────────────────────────────────── */

SUITE(configlink) {
    /* Strategy 1: Key → Symbol */
    RUN_TEST(configlink_key_symbol_exact_match);
    RUN_TEST(configlink_key_symbol_substring_match);
    RUN_TEST(configlink_key_symbol_short_key_skipped);
    RUN_TEST(configlink_key_symbol_camel_case);
    RUN_TEST(configlink_key_symbol_no_false_positive);

    /* Strategy 2: Dependency → Import */
    RUN_TEST(configlink_dep_import_package_json);

    /* Strategy 3: File Path → Reference */
    RUN_TEST(configlink_file_ref_exact_path);
    RUN_TEST(configlink_file_ref_basename_match);
    RUN_TEST(configlink_file_ref_no_false_positive);
}

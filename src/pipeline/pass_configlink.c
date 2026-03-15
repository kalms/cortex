// NOLINTBEGIN(cert-err33-c) — best-effort logging and snprintf truncation
// NOLINTBEGIN(readability-magic-numbers) — buffer sizes, scoring weights, and capacity constants
/*
 * pass_configlink.c — Config ↔ Code linking strategies (post-flush pass).
 *
 * Three strategies link config files to code symbols:
 *   1. Key→Symbol: normalized config key matches code function/variable name
 *   2. Dep→Import: package manifest dependency matches IMPORTS edge target
 *   3. File→Ref: source code string literal references config file path
 *
 * Operates on the store after graph buffer flush.
 */
#include "pipeline/pipeline.h"
#include "pipeline/pipeline_internal.h"
#include "store/store.h"
#include "foundation/log.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <regex.h>

/* ── Manifest / dep section tables ──────────────────────────────── */

static bool is_manifest_file(const char *basename) {
    static const char *names[] = {"Cargo.toml",       "package.json",  "go.mod",
                                  "requirements.txt", "Gemfile",       "build.gradle",
                                  "pom.xml",          "composer.json", NULL};
    for (int i = 0; names[i]; i++) {
        if (strcmp(basename, names[i]) == 0) {
            return true;
        }
    }
    return false;
}

static bool is_dep_section(const char *s) {
    static const char *secs[] = {"dependencies",     "devdependencies",    "peerdependencies",
                                 "dev-dependencies", "build-dependencies", NULL};
    for (int i = 0; secs[i]; i++) {
        // NOLINTNEXTLINE(misc-include-cleaner) — strcasestr provided by standard header
        if (strcasestr(s, secs[i]) != NULL) {
            return true;
        }
    }
    return false;
}

/* ── Strategy 1: Config Key → Code Symbol ───────────────────────── */

typedef struct {
    // NOLINTNEXTLINE(misc-include-cleaner) — int64_t provided by standard header
    int64_t node_id;
    char normalized[256];
    char name[256];
} config_entry_t;

/* Collect config Variable nodes with ≥2 tokens, each ≥3 chars. */
static int collect_config_entries(const cbm_node_t *vars, int var_count, config_entry_t *out,
                                  int max_out) {
    int n = 0;
    for (int i = 0; i < var_count && n < max_out; i++) {
        if (!cbm_has_config_extension(vars[i].file_path)) {
            continue;
        }

        char norm[256];
        int tokens = cbm_normalize_config_key(vars[i].name, norm, sizeof(norm));
        if (tokens < 2) {
            continue;
        }

        /* Check all tokens ≥3 chars */
        bool all_long = true;
        const char *p = norm;
        while (*p) {
            const char *end = strchr(p, '_');
            size_t tlen = end ? (size_t)(end - p) : strlen(p);
            if (tlen < 3) {
                all_long = false;
                break;
            }
            p = end ? end + 1 : p + tlen;
        }
        if (!all_long) {
            continue;
        }

        out[n].node_id = vars[i].id;
        snprintf(out[n].normalized, sizeof(out[n].normalized), "%s", norm);
        snprintf(out[n].name, sizeof(out[n].name), "%s", vars[i].name);
        n++;
    }
    return n;
}

/* Collect code nodes (Function/Variable/Class) not from config files. */
typedef struct {
    int64_t node_id;
    char normalized[256];
} code_entry_t;

static int collect_code_entries(cbm_store_t *s, const char *project, code_entry_t *out,
                                int max_out) {
    int n = 0;
    static const char *labels[] = {"Function", "Variable", "Class", NULL};

    for (int li = 0; labels[li] && n < max_out; li++) {
        cbm_node_t *nodes = NULL;
        int count = 0;
        if (cbm_store_find_nodes_by_label(s, project, labels[li], &nodes, &count) != 0) {
            continue;
        }

        for (int i = 0; i < count && n < max_out; i++) {
            if (cbm_has_config_extension(nodes[i].file_path)) {
                continue;
            }

            char norm[256];
            int tokens = cbm_normalize_config_key(nodes[i].name, norm, sizeof(norm));
            if (tokens == 0 || norm[0] == '\0') {
                continue;
            }

            out[n].node_id = nodes[i].id;
            snprintf(out[n].normalized, sizeof(out[n].normalized), "%s", norm);
            n++;
        }
        cbm_store_free_nodes(nodes, count);
    }
    return n;
}

static int strategy_key_symbols(cbm_store_t *s, const char *project) {
    /* Get all Variable nodes */
    cbm_node_t *vars = NULL;
    int var_count = 0;
    if (cbm_store_find_nodes_by_label(s, project, "Variable", &vars, &var_count) != 0) {
        return 0;
    }

    config_entry_t config_entries[4096];
    int config_count = collect_config_entries(vars, var_count, config_entries, 4096);
    cbm_store_free_nodes(vars, var_count);

    if (config_count == 0) {
        return 0;
    }

    code_entry_t code_entries[8192];
    int code_count = collect_code_entries(s, project, code_entries, 8192);

    int edge_count = 0;

    for (int ci = 0; ci < config_count; ci++) {
        for (int co = 0; co < code_count; co++) {
            double confidence = 0.0;

            if (strcmp(config_entries[ci].normalized, code_entries[co].normalized) == 0) {
                /* Exact match */
                confidence = 0.85;
            } else if (strstr(code_entries[co].normalized, config_entries[ci].normalized) != NULL) {
                /* Substring match */
                confidence = 0.75;
            }

            if (confidence > 0.0) {
                char props[512];
                snprintf(props, sizeof(props),
                         "{\"strategy\":\"key_symbol\",\"confidence\":%.2f,\"config_key\":\"%s\"}",
                         confidence, config_entries[ci].name);

                cbm_edge_t e = {
                    .project = project,
                    .source_id = code_entries[co].node_id,
                    .target_id = config_entries[ci].node_id,
                    .type = "CONFIGURES",
                    .properties_json = props,
                };
                cbm_store_insert_edge(s, &e);
                edge_count++;
            }
        }
    }

    return edge_count;
}

/* ── Strategy 2: Dependency → Import ────────────────────────────── */

typedef struct {
    int64_t node_id;
    char name[256];
} dep_entry_t;

/* Extract basename from a file path. */
static const char *path_basename(const char *path) {
    if (!path) {
        return "";
    }
    const char *slash = strrchr(path, '/');
    return slash ? slash + 1 : path;
}

static int collect_manifest_deps(const cbm_node_t *vars, int var_count, dep_entry_t *out,
                                 int max_out) {
    int n = 0;
    for (int i = 0; i < var_count && n < max_out; i++) {
        const char *base = path_basename(vars[i].file_path);
        if (!is_manifest_file(base)) {
            continue;
        }

        /* Check if QN contains a dependency section name */
        bool is_dep = false;
        if (vars[i].qualified_name) {
            is_dep = is_dep_section(vars[i].qualified_name);
        }

        /* Cargo.toml special case: check QN parts */
        if (!is_dep && strcmp(base, "Cargo.toml") == 0 && vars[i].qualified_name) {
            /* Check if any dotted part is a dep section */
            char qn_copy[512];
            snprintf(qn_copy, sizeof(qn_copy), "%s", vars[i].qualified_name);
            char *saveptr = NULL;
            // NOLINTNEXTLINE(misc-include-cleaner) — strtok_r provided by standard header
            char *part = strtok_r(qn_copy, ".", &saveptr);
            while (part) {
                char lower[128];
                size_t plen = strlen(part);
                if (plen >= sizeof(lower)) {
                    plen = sizeof(lower) - 1;
                }
                for (size_t j = 0; j < plen; j++) {
                    lower[j] = (char)tolower((unsigned char)part[j]);
                }
                lower[plen] = '\0';

                static const char *dep_secs[] = {"dependencies",       "devdependencies",
                                                 "peerdependencies",   "dev-dependencies",
                                                 "build-dependencies", NULL};
                for (int k = 0; dep_secs[k]; k++) {
                    if (strcmp(lower, dep_secs[k]) == 0) {
                        is_dep = true;
                        break;
                    }
                }
                if (is_dep) {
                    break;
                }
                part = strtok_r(NULL, ".", &saveptr);
            }
        }

        if (is_dep) {
            out[n].node_id = vars[i].id;
            snprintf(out[n].name, sizeof(out[n].name), "%s", vars[i].name);
            n++;
        }
    }
    return n;
}

static int strategy_dep_imports(cbm_store_t *s, const char *project) {
    cbm_node_t *vars = NULL;
    int var_count = 0;
    if (cbm_store_find_nodes_by_label(s, project, "Variable", &vars, &var_count) != 0) {
        return 0;
    }

    dep_entry_t deps[2048];
    int dep_count = collect_manifest_deps(vars, var_count, deps, 2048);
    cbm_store_free_nodes(vars, var_count);

    if (dep_count == 0) {
        return 0;
    }

    /* Get all IMPORTS edges */
    cbm_edge_t *imports = NULL;
    int import_count = 0;
    if (cbm_store_find_edges_by_type(s, project, "IMPORTS", &imports, &import_count) != 0) {
        return 0;
    }

    int edge_count = 0;

    for (int di = 0; di < dep_count; di++) {
        char dep_lower[256];
        size_t dlen = strlen(deps[di].name);
        for (size_t j = 0; j < dlen && j < sizeof(dep_lower) - 1; j++) {
            dep_lower[j] = (char)tolower((unsigned char)deps[di].name[j]);
        }
        dep_lower[dlen < sizeof(dep_lower) ? dlen : sizeof(dep_lower) - 1] = '\0';

        for (int ii = 0; ii < import_count; ii++) {
            /* Resolve target node */
            cbm_node_t target = {0};
            if (cbm_store_find_node_by_id(s, imports[ii].target_id, &target) != 0) {
                continue;
            }

            cbm_node_t source = {0};
            if (cbm_store_find_node_by_id(s, imports[ii].source_id, &source) != 0) {
                continue;
            }

            /* Compare dep name to import target */
            double confidence = 0.0;
            char target_lower[256];
            size_t tlen = target.name ? strlen(target.name) : 0;
            for (size_t j = 0; j < tlen && j < sizeof(target_lower) - 1; j++) {
                target_lower[j] = (char)tolower((unsigned char)target.name[j]);
            }
            target_lower[tlen < sizeof(target_lower) ? tlen : sizeof(target_lower) - 1] = '\0';

            if (strcmp(target_lower, dep_lower) == 0) {
                confidence = 0.95;
            } else if (target.qualified_name) {
                char qn_lower[512];
                size_t qlen = strlen(target.qualified_name);
                for (size_t j = 0; j < qlen && j < sizeof(qn_lower) - 1; j++) {
                    qn_lower[j] = (char)tolower((unsigned char)target.qualified_name[j]);
                }
                qn_lower[qlen < sizeof(qn_lower) ? qlen : sizeof(qn_lower) - 1] = '\0';

                if (strstr(qn_lower, dep_lower) != NULL) {
                    confidence = 0.80;
                }
            }

            if (confidence > 0.0) {
                char props[512];
                snprintf(
                    props, sizeof(props),
                    "{\"strategy\":\"dependency_import\",\"confidence\":%.2f,\"dep_name\":\"%s\"}",
                    confidence, deps[di].name);

                cbm_edge_t e = {
                    .project = project,
                    .source_id = source.id,
                    .target_id = deps[di].node_id,
                    .type = "CONFIGURES",
                    .properties_json = props,
                };
                cbm_store_insert_edge(s, &e);
                edge_count++;
            }
        }
    }

    cbm_store_free_edges(imports, import_count);
    return edge_count;
}

/* ── Strategy 3: Config File Path → Code String Reference ───────── */

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters)
static int strategy_file_refs(cbm_store_t *s, const char *project, const char *repo_path) {
    /* Collect config Module nodes */
    cbm_node_t *modules = NULL;
    int mod_count = 0;
    if (cbm_store_find_nodes_by_label(s, project, "Module", &modules, &mod_count) != 0) {
        return 0;
    }

    /* Build basename → Module and fullpath → Module maps
     * (using simple linear arrays, not hash tables, for clarity) */
    typedef struct {
        const char *key;
        int64_t node_id;
    } path_map_t;

    path_map_t *base_map = calloc((size_t)mod_count, sizeof(path_map_t));
    path_map_t *full_map = calloc((size_t)mod_count, sizeof(path_map_t));
    int base_count = 0;
    int full_count = 0;

    int scan_count = 0;
    int *scan_indices = calloc((size_t)mod_count, sizeof(int));

    for (int i = 0; i < mod_count; i++) {
        if (cbm_has_config_extension(modules[i].file_path)) {
            base_map[base_count].key = path_basename(modules[i].file_path);
            base_map[base_count].node_id = modules[i].id;
            base_count++;

            full_map[full_count].key = modules[i].file_path;
            full_map[full_count].node_id = modules[i].id;
            full_count++;
        } else {
            scan_indices[scan_count++] = i;
        }
    }

    if (base_count == 0) {
        free(base_map);
        free(full_map);
        free(scan_indices);
        cbm_store_free_nodes(modules, mod_count);
        return 0;
    }

    /* Compile regex for config file references in string literals */
    // NOLINTBEGIN(misc-include-cleaner)
    regex_t re;
    int rc = regcomp(&re, "[\"']([^\"']*\\.(toml|yaml|yml|ini|json|xml|conf|cfg|env))[\"']",
                     REG_EXTENDED);
    // NOLINTEND(misc-include-cleaner)
    if (rc != 0) {
        free(base_map);
        free(full_map);
        free(scan_indices);
        cbm_store_free_nodes(modules, mod_count);
        return 0;
    }

    int edge_count = 0;

    for (int si = 0; si < scan_count; si++) {
        int idx = scan_indices[si];
        const char *file_path = modules[idx].file_path;

        /* Read source file from disk */
        char abs_path[1024];
        snprintf(abs_path, sizeof(abs_path), "%s/%s", repo_path, file_path);

        FILE *f = fopen(abs_path, "r");
        if (!f) {
            continue;
        }

        fseek(f, 0, SEEK_END);
        long fsize = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (fsize <= 0 || fsize > (long)10 * 1024 * 1024) {
            fclose(f);
            continue;
        }

        char *source = malloc((size_t)fsize + 1);
        if (!source) {
            fclose(f);
            continue;
        }
        size_t nread = fread(source, 1, (size_t)fsize, f);
        // NOLINTNEXTLINE(clang-analyzer-security.ArrayBound)
        source[nread] = '\0';
        fclose(f);

        /* Find all config file references via regex */
        // NOLINTNEXTLINE(misc-include-cleaner) — regmatch_t provided by standard header
        regmatch_t match[3];
        const char *cursor = source;
        // NOLINTNEXTLINE(misc-include-cleaner) — regexec provided by standard header
        while (regexec(&re, cursor, 3, match, 0) == 0) {
            /* Extract the captured path (group 1) */
            // NOLINTNEXTLINE(bugprone-narrowing-conversions)
            int start = match[1].rm_so;
            // NOLINTNEXTLINE(bugprone-narrowing-conversions)
            int end = match[1].rm_eo;
            int ref_len = end - start;
            char ref_path[512];
            if (ref_len >= (int)sizeof(ref_path)) {
                ref_len = (int)sizeof(ref_path) - 1;
            }
            memcpy(ref_path, cursor + start, (size_t)ref_len);
            ref_path[ref_len] = '\0';

            /* Match against config modules */
            int64_t target_id = 0;
            double confidence = 0.0;

            /* Try full path match */
            for (int fi = 0; fi < full_count; fi++) {
                if (strcmp(full_map[fi].key, ref_path) == 0) {
                    target_id = full_map[fi].node_id;
                    confidence = 0.90;
                    break;
                }
            }

            /* Try basename match */
            if (target_id == 0) {
                const char *ref_base = path_basename(ref_path);
                for (int bi = 0; bi < base_count; bi++) {
                    if (strcmp(base_map[bi].key, ref_base) == 0) {
                        target_id = base_map[bi].node_id;
                        confidence = 0.70;
                        break;
                    }
                }
            }

            if (target_id != 0) {
                /* Resolve source Module QN */
                char *module_qn = cbm_pipeline_fqn_module(project, file_path);
                if (module_qn) {
                    cbm_node_t src_node = {0};
                    if (cbm_store_find_node_by_qn(s, project, module_qn, &src_node) == 0) {
                        char props[512];
                        snprintf(props, sizeof(props),
                                 "{\"strategy\":\"file_reference\",\"confidence\":%.2f,\"ref_"
                                 "path\":\"%s\"}",
                                 confidence, ref_path);

                        cbm_edge_t e = {
                            .project = project,
                            .source_id = src_node.id,
                            .target_id = target_id,
                            .type = "CONFIGURES",
                            .properties_json = props,
                        };
                        cbm_store_insert_edge(s, &e);
                        edge_count++;
                    }
                    free(module_qn);
                }
            }

            cursor += match[0].rm_eo;
        }

        free(source);
    }

    // NOLINTNEXTLINE(misc-include-cleaner) — regfree provided by standard header
    regfree(&re);
    free(base_map);
    free(full_map);
    free(scan_indices);
    cbm_store_free_nodes(modules, mod_count);
    return edge_count;
}

/* ── Public API ──────────────────────────────────────────────────── */

int cbm_pipeline_pass_configlink(cbm_store_t *s, const char *project, const char *repo_path) {
    char buf1[16];
    char buf2[16];
    char buf3[16];
    char buf4[16];

    int key_edges = strategy_key_symbols(s, project);
    snprintf(buf1, sizeof(buf1), "%d", key_edges);
    cbm_log_info("configlinker.strategy", "name", "key_symbol", "edges", buf1);

    int dep_edges = strategy_dep_imports(s, project);
    snprintf(buf2, sizeof(buf2), "%d", dep_edges);
    cbm_log_info("configlinker.strategy", "name", "dep_import", "edges", buf2);

    int ref_edges = 0;
    if (repo_path) {
        ref_edges = strategy_file_refs(s, project, repo_path);
    }
    snprintf(buf3, sizeof(buf3), "%d", ref_edges);
    cbm_log_info("configlinker.strategy", "name", "file_ref", "edges", buf3);

    snprintf(buf4, sizeof(buf4), "%d", key_edges + dep_edges + ref_edges);
    cbm_log_info("configlinker.done", "total", buf4);

    return key_edges + dep_edges + ref_edges;
}

// NOLINTEND(readability-magic-numbers)
// NOLINTEND(cert-err33-c)

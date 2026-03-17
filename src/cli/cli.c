/*
 * cli.c — CLI subcommand handlers for install, uninstall, update, version.
 *
 * Port of Go cmd/codebase-memory-mcp/ install/update logic.
 * All functions accept explicit paths for testability.
 */
#include "cli/cli.h"

// the correct standard headers are included below but clang-tidy doesn't map them.
#include <ctype.h>
#include "foundation/compat_fs.h"
#include <errno.h>  // EEXIST
#include <stdint.h> // uintptr_t
#include <stdio.h>
#include <stdlib.h>
#include <string.h>   // strtok_r
#include <sys/stat.h> // mode_t, S_IXUSR
#include <zlib.h>     // MAX_WBITS

/* yyjson for JSON read-modify-write */
#include "yyjson/yyjson.h"

/* ── Constants ────────────────────────────────────────────────── */

/* Directory permissions: rwxr-x--- */
#define DIR_PERMS 0750

/* Decompression buffer cap (500 MB) */
#define DECOMPRESS_MAX_BYTES ((size_t)500 * 1024 * 1024)

/* Tar header field offsets */
#define TAR_NAME_LEN 101    /* filename field: bytes 0-99 + NUL */
#define TAR_SIZE_OFFSET 124 /* octal size field offset */
#define TAR_SIZE_LEN 13     /* octal size field: bytes 124-135 + NUL */
#define TAR_TYPE_OFFSET 156 /* type flag byte */
#define TAR_BINARY_NAME "codebase-memory-mcp"
#define TAR_BINARY_NAME_LEN 19
#define TAR_BLOCK_SIZE 512 /* tar record alignment */
#define TAR_BLOCK_MASK 511 /* TAR_BLOCK_SIZE - 1 */

/* ── Version ──────────────────────────────────────────────────── */

static const char *cli_version = "dev";

void cbm_cli_set_version(const char *ver) {
    if (ver) {
        cli_version = ver;
    }
}

const char *cbm_cli_get_version(void) {
    return cli_version;
}

/* ── Version comparison ───────────────────────────────────────── */

/* Parse semver major.minor.patch into array. Returns number of parts parsed. */
static int parse_semver(const char *v, int out[3]) {
    out[0] = out[1] = out[2] = 0;
    /* Skip v prefix */
    if (*v == 'v' || *v == 'V') {
        v++;
    }

    int count = 0;
    while (*v && count < 3) {
        if (*v == '-') {
            break; /* stop at pre-release suffix */
        }
        char *endptr;
        long val = strtol(v, &endptr, 10);
        out[count++] = (int)val;
        if (*endptr == '.') {
            v = endptr + 1;
        } else {
            break;
        }
    }
    return count;
}

static bool has_prerelease(const char *v) {
    if (*v == 'v' || *v == 'V') {
        v++;
    }
    return strchr(v, '-') != NULL;
}

int cbm_compare_versions(const char *a, const char *b) {
    int pa[3];
    int pb[3];
    parse_semver(a, pa);
    parse_semver(b, pb);

    for (int i = 0; i < 3; i++) {
        if (pa[i] != pb[i]) {
            return pa[i] - pb[i];
        }
    }

    /* Same base version — non-dev beats dev */
    bool a_pre = has_prerelease(a);
    bool b_pre = has_prerelease(b);
    if (a_pre && !b_pre) {
        return -1;
    }
    if (!a_pre && b_pre) {
        return 1;
    }
    return 0;
}

/* ── Shell RC detection ───────────────────────────────────────── */

const char *cbm_detect_shell_rc(const char *home_dir) {
    static char buf[512];
    if (!home_dir || !home_dir[0]) {
        return "";
    }

    // NOLINTNEXTLINE(concurrency-mt-unsafe)
    const char *shell = getenv("SHELL");
    if (!shell) {
        shell = "";
    }

    if (strstr(shell, "/zsh")) {
        snprintf(buf, sizeof(buf), "%s/.zshrc", home_dir);
        return buf;
    }
    if (strstr(shell, "/bash")) {
        /* Prefer .bashrc, fall back to .bash_profile */
        snprintf(buf, sizeof(buf), "%s/.bashrc", home_dir);
        struct stat st;
        if (stat(buf, &st) == 0) {
            return buf;
        }
        snprintf(buf, sizeof(buf), "%s/.bash_profile", home_dir);
        return buf;
    }
    if (strstr(shell, "/fish")) {
        snprintf(buf, sizeof(buf), "%s/.config/fish/config.fish", home_dir);
        return buf;
    }

    /* Default to .profile */
    snprintf(buf, sizeof(buf), "%s/.profile", home_dir);
    return buf;
}

/* ── CLI binary detection ─────────────────────────────────────── */

const char *cbm_find_cli(const char *name, const char *home_dir) {
    static char buf[512];
    if (!name || !name[0]) {
        return "";
    }

    /* Check PATH first */
    // NOLINTNEXTLINE(concurrency-mt-unsafe)
    const char *path_env = getenv("PATH");
    if (path_env) {
        char path_copy[4096];
        snprintf(path_copy, sizeof(path_copy), "%s", path_env);
        char *saveptr;
        // NOLINTNEXTLINE(misc-include-cleaner) — strtok_r provided by standard header
        char *dir = strtok_r(path_copy, ":", &saveptr);
        while (dir) {
            snprintf(buf, sizeof(buf), "%s/%s", dir, name);
            struct stat st;
            // NOLINTNEXTLINE(misc-include-cleaner) — S_IXUSR provided by standard header
            if (stat(buf, &st) == 0 && (st.st_mode & S_IXUSR)) {
                return buf;
            }
            dir = strtok_r(NULL, ":", &saveptr);
        }
    }

    /* Check common install locations */
    if (home_dir && home_dir[0]) {
        const char *candidates[] = {
            "/usr/local/bin/%s",
            NULL, /* filled dynamically */
            NULL,
            NULL,
            NULL,
        };
        char paths[5][512];
        snprintf(paths[0], sizeof(paths[0]), "/usr/local/bin/%s", name);
        snprintf(paths[1], sizeof(paths[1]), "%s/.npm/bin/%s", home_dir, name);
        snprintf(paths[2], sizeof(paths[2]), "%s/.local/bin/%s", home_dir, name);
        snprintf(paths[3], sizeof(paths[3]), "%s/.cargo/bin/%s", home_dir, name);
#ifdef __APPLE__
        snprintf(paths[4], sizeof(paths[4]), "/opt/homebrew/bin/%s", name);
#else
        paths[4][0] = '\0';
#endif
        (void)candidates;

        for (int i = 0; i < 5; i++) {
            if (!paths[i][0]) {
                continue;
            }
            struct stat st;
            if (stat(paths[i], &st) == 0) {
                snprintf(buf, sizeof(buf), "%s", paths[i]);
                return buf;
            }
        }
    }

    return "";
}

/* ── File utilities ───────────────────────────────────────────── */

int cbm_copy_file(const char *src, const char *dst) {
    FILE *in = fopen(src, "rb");
    if (!in) {
        return -1;
    }

    FILE *out = fopen(dst, "wb");
    if (!out) {
        (void)fclose(in);
        return -1;
    }

    char buf[8192];
    int err = 0;
    while (!feof(in) && !ferror(in)) {
        size_t n = fread(buf, 1, sizeof(buf), in);
        if (n == 0) {
            break;
        }
        if (fwrite(buf, 1, n, out) != n) {
            err = 1;
            break;
        }
    }

    if (err || ferror(in)) {
        (void)fclose(in);
        (void)fclose(out);
        return -1;
    }

    (void)fclose(in);
    int rc = fclose(out);
    return rc == 0 ? 0 : -1;
}

/* ── Skill file content (embedded) ────────────────────────────── */

static const char skill_exploring_content[] =
    "---\n"
    "name: codebase-memory-exploring\n"
    "description: This skill should be used when the user asks to \"explore the codebase\", "
    "\"understand the architecture\", \"what functions exist\", \"show me the structure\", "
    "\"how is the code organized\", \"find functions matching\", \"search for classes\", "
    "\"list all routes\", \"show API endpoints\", or needs codebase orientation.\n"
    "---\n"
    "\n"
    "# Codebase Exploration\n"
    "\n"
    "Use codebase-memory-mcp tools to explore the codebase:\n"
    "\n"
    "## Workflow\n"
    "1. `get_graph_schema` — understand what node/edge types exist\n"
    "2. `search_graph` — find functions, classes, routes by pattern\n"
    "3. `get_code_snippet` — read specific function implementations\n"
    "4. `get_architecture` — get high-level project summary\n"
    "\n"
    "## Tips\n"
    "- Use `search_graph(name_pattern=\".*Pattern.*\")` for fuzzy matching\n"
    "- Use `search_graph(label=\"Route\")` to find HTTP routes\n"
    "- Use `search_graph(label=\"Function\", file_pattern=\"*.go\")` to scope by language\n";

static const char skill_tracing_content[] =
    "---\n"
    "name: codebase-memory-tracing\n"
    "description: This skill should be used when the user asks \"who calls this function\", "
    "\"what does X call\", \"trace the call chain\", \"find callers of\", \"show dependencies\", "
    "\"what depends on\", \"trace call path\", \"find all references to\", \"impact analysis\", "
    "or needs to understand function call relationships and dependency chains.\n"
    "---\n"
    "\n"
    "# Call Tracing & Impact Analysis\n"
    "\n"
    "Use codebase-memory-mcp tools to trace call paths:\n"
    "\n"
    "## Workflow\n"
    "1. `search_graph(name_pattern=\".*FuncName.*\")` — find exact function name\n"
    "2. `trace_call_path(function_name=\"FuncName\", direction=\"both\")` — trace callers + "
    "callees\n"
    "3. `detect_changes` — find what changed and assess risk_labels\n"
    "\n"
    "## Direction Options\n"
    "- `inbound` — who calls this function?\n"
    "- `outbound` — what does this function call?\n"
    "- `both` — full context (callers + callees)\n";

static const char skill_quality_content[] =
    "---\n"
    "name: codebase-memory-quality\n"
    "description: This skill should be used when the user asks about \"dead code\", "
    "\"find dead code\", \"detect dead code\", \"show dead code\", \"dead code analysis\", "
    "\"unused functions\", \"find unused functions\", \"unreachable code\", "
    "\"identify high fan-out functions\", \"find complex functions\", \"code quality audit\", "
    "\"find functions nobody calls\", \"reduce codebase size\", \"refactor candidates\", "
    "\"cleanup candidates\", or needs code quality analysis.\n"
    "---\n"
    "\n"
    "# Code Quality Analysis\n"
    "\n"
    "Use codebase-memory-mcp tools for quality analysis:\n"
    "\n"
    "## Dead Code Detection\n"
    "- `search_graph(max_degree=0, exclude_entry_points=true)` — find unreferenced functions\n"
    "- `search_graph(max_degree=0, label=\"Function\")` — unreferenced functions only\n"
    "\n"
    "## Complexity Analysis\n"
    "- `search_graph(min_degree=10)` — high fan-out functions\n"
    "- `search_graph(label=\"Function\", sort_by=\"degree\")` — most-connected functions\n";

static const char skill_reference_content[] =
    "---\n"
    "name: codebase-memory-reference\n"
    "description: This skill should be used when the user asks about \"codebase-memory-mcp "
    "tools\", "
    "\"graph query syntax\", \"Cypher query examples\", \"edge types\", \"how to use "
    "search_graph\", "
    "\"query_graph examples\", or needs reference documentation for the codebase knowledge graph "
    "tools.\n"
    "---\n"
    "\n"
    "# Codebase Memory MCP Reference\n"
    "\n"
    "## 14 total MCP Tools\n"
    "- `index_repository` — index a project\n"
    "- `index_status` — check indexing progress\n"
    "- `detect_changes` — find what changed since last index\n"
    "- `search_graph` — find nodes by pattern\n"
    "- `search_code` — text search in source\n"
    "- `query_graph` — Cypher query language\n"
    "- `trace_call_path` — call chain traversal\n"
    "- `get_code_snippet` — read function source\n"
    "- `get_graph_schema` — node/edge type catalog\n"
    "- `get_architecture` — high-level summary\n"
    "- `list_projects` — indexed projects\n"
    "- `delete_project` — remove a project\n"
    "- `manage_adr` — architecture decision records\n"
    "- `ingest_traces` — import runtime traces\n"
    "\n"
    "## Edge Types\n"
    "CALLS, HTTP_CALLS, ASYNC_CALLS, IMPORTS, DEFINES, DEFINES_METHOD,\n"
    "HANDLES, IMPLEMENTS, CONTAINS_FILE, CONTAINS_FOLDER, CONTAINS_PACKAGE\n"
    "\n"
    "## Cypher Examples\n"
    "```\n"
    "MATCH (f:Function) WHERE f.name =~ '.*Handler.*' RETURN f.name, f.file_path\n"
    "MATCH (a)-[r:CALLS]->(b) WHERE a.name = 'main' RETURN b.name\n"
    "MATCH (a)-[r:HTTP_CALLS]->(b) RETURN a.name, b.name, r.url_path\n"
    "```\n";

static const char codex_instructions_content[] =
    "# Codebase Knowledge Graph\n"
    "\n"
    "This project uses codebase-memory-mcp to maintain a knowledge graph of the codebase.\n"
    "Use the MCP tools to explore and understand the code:\n"
    "\n"
    "- `search_graph` — find functions, classes, routes by pattern\n"
    "- `trace_call_path` — trace who calls a function or what it calls\n"
    "- `get_code_snippet` — read function source code\n"
    "- `query_graph` — run Cypher queries for complex patterns\n"
    "- `get_architecture` — high-level project summary\n"
    "\n"
    "Always prefer graph tools over grep for code discovery.\n";

static const cbm_skill_t skills[CBM_SKILL_COUNT] = {
    {"codebase-memory-exploring", skill_exploring_content},
    {"codebase-memory-tracing", skill_tracing_content},
    {"codebase-memory-quality", skill_quality_content},
    {"codebase-memory-reference", skill_reference_content},
};

const cbm_skill_t *cbm_get_skills(void) {
    return skills;
}

const char *cbm_get_codex_instructions(void) {
    return codex_instructions_content;
}

/* ── Recursive mkdir (via compat_fs) ──────────────────────────── */

static int mkdirp(const char *path, int mode) {
    return (int)cbm_mkdir_p(path, mode) ? 0 : -1;
}

/* ── Recursive rmdir ──────────────────────────────────────────── */

// NOLINTNEXTLINE(misc-no-recursion) — intentional recursive directory removal
static int rmdir_recursive(const char *path) {
    cbm_dir_t *d = cbm_opendir(path);
    if (!d) {
        return -1;
    }

    cbm_dirent_t *ent;
    while ((ent = cbm_readdir(d)) != NULL) {
        char child[1024];
        snprintf(child, sizeof(child), "%s/%s", path, ent->name);
        struct stat st;
        if (stat(child, &st) == 0 && S_ISDIR(st.st_mode)) {
            rmdir_recursive(child);
        } else {
            cbm_unlink(child);
        }
    }
    cbm_closedir(d);
    return cbm_rmdir(path);
}

/* ── Skill management ─────────────────────────────────────────── */

int cbm_install_skills(const char *skills_dir, bool force, bool dry_run) {
    if (!skills_dir) {
        return 0;
    }
    int count = 0;

    for (int i = 0; i < CBM_SKILL_COUNT; i++) {
        char skill_path[1024];
        snprintf(skill_path, sizeof(skill_path), "%s/%s", skills_dir, skills[i].name);
        char file_path[1024];
        snprintf(file_path, sizeof(file_path), "%s/SKILL.md", skill_path);

        /* Check if already exists */
        if (!force) {
            struct stat st;
            if (stat(file_path, &st) == 0) {
                continue;
            }
        }

        if (dry_run) {
            count++;
            continue;
        }

        if (mkdirp(skill_path, DIR_PERMS) != 0) {
            continue;
        }

        FILE *f = fopen(file_path, "w");
        if (!f) {
            continue;
        }
        (void)fwrite(skills[i].content, 1, strlen(skills[i].content), f);
        (void)fclose(f);
        count++;
    }
    return count;
}

int cbm_remove_skills(const char *skills_dir, bool dry_run) {
    if (!skills_dir) {
        return 0;
    }
    int count = 0;

    for (int i = 0; i < CBM_SKILL_COUNT; i++) {
        char skill_path[1024];
        snprintf(skill_path, sizeof(skill_path), "%s/%s", skills_dir, skills[i].name);
        struct stat st;
        if (stat(skill_path, &st) != 0) {
            continue;
        }

        if (dry_run) {
            count++;
            continue;
        }

        if (rmdir_recursive(skill_path) == 0) {
            count++;
        }
    }
    return count;
}

bool cbm_remove_old_monolithic_skill(const char *skills_dir, bool dry_run) {
    if (!skills_dir) {
        return false;
    }

    char old_path[1024];
    snprintf(old_path, sizeof(old_path), "%s/codebase-memory-mcp", skills_dir);
    struct stat st;
    if (stat(old_path, &st) != 0 || !S_ISDIR(st.st_mode)) {
        return false;
    }

    if (dry_run) {
        return true;
    }
    return rmdir_recursive(old_path) == 0;
}

/* ── JSON config helpers (using yyjson) ───────────────────────── */

/* Read a JSON file into a yyjson document. Returns NULL on error. */
static yyjson_doc *read_json_file(const char *path) {
    FILE *f = fopen(path, "r");
    if (!f) {
        return NULL;
    }

    (void)fseek(f, 0, SEEK_END);
    long size = ftell(f);
    (void)fseek(f, 0, SEEK_SET);

    if (size <= 0 || size > 10L * 1024 * 1024) {
        (void)fclose(f);
        return NULL;
    }

    char *buf = malloc((size_t)size + 1);
    if (!buf) {
        (void)fclose(f);
        return NULL;
    }

    size_t nread = fread(buf, 1, (size_t)size, f);
    (void)fclose(f);
    // NOLINTNEXTLINE(clang-analyzer-security.ArrayBound)
    buf[nread] = '\0';

    yyjson_doc *doc = yyjson_read(buf, nread, 0);
    free(buf);
    return doc;
}

/* Write a mutable yyjson document to a file with pretty printing. */
static int write_json_file(const char *path, yyjson_mut_doc *doc) {
    /* Ensure parent directory exists */
    char dir[1024];
    snprintf(dir, sizeof(dir), "%s", path);
    char *last_slash = strrchr(dir, '/');
    if (last_slash) {
        *last_slash = '\0';
        mkdirp(dir, DIR_PERMS);
    }

    yyjson_write_flag flags = YYJSON_WRITE_PRETTY | YYJSON_WRITE_ESCAPE_UNICODE;
    size_t len;
    char *json = yyjson_mut_write(doc, flags, &len);
    if (!json) {
        return -1;
    }

    FILE *f = fopen(path, "w");
    if (!f) {
        free(json);
        return -1;
    }

    size_t written = fwrite(json, 1, len, f);
    /* Add trailing newline */
    (void)fputc('\n', f);
    (void)fclose(f);
    free(json);

    return written == len ? 0 : -1;
}

/* ── Editor MCP: Cursor/Windsurf/Gemini (mcpServers key) ──────── */

int cbm_install_editor_mcp(const char *binary_path, const char *config_path) {
    if (!binary_path || !config_path) {
        return -1;
    }

    /* Read existing or start fresh */
    yyjson_mut_doc *mdoc = yyjson_mut_doc_new(NULL);
    if (!mdoc) {
        return -1;
    }

    yyjson_doc *doc = read_json_file(config_path);
    yyjson_mut_val *root;
    if (doc) {
        root = yyjson_val_mut_copy(mdoc, yyjson_doc_get_root(doc));
        yyjson_doc_free(doc);
    } else {
        root = yyjson_mut_obj(mdoc);
    }
    if (!root) {
        yyjson_mut_doc_free(mdoc);
        return -1;
    }
    yyjson_mut_doc_set_root(mdoc, root);

    /* Get or create mcpServers object */
    yyjson_mut_val *servers = yyjson_mut_obj_get(root, "mcpServers");
    if (!servers || !yyjson_mut_is_obj(servers)) {
        servers = yyjson_mut_obj(mdoc);
        yyjson_mut_obj_add_val(mdoc, root, "mcpServers", servers);
    }

    /* Remove existing entry if present */
    yyjson_mut_obj_remove_key(servers, "codebase-memory-mcp");

    /* Add our entry */
    yyjson_mut_val *entry = yyjson_mut_obj(mdoc);
    yyjson_mut_obj_add_str(mdoc, entry, "command", binary_path);
    yyjson_mut_obj_add_val(mdoc, servers, "codebase-memory-mcp", entry);

    int rc = write_json_file(config_path, mdoc);
    yyjson_mut_doc_free(mdoc);
    return rc;
}

int cbm_remove_editor_mcp(const char *config_path) {
    if (!config_path) {
        return -1;
    }

    yyjson_doc *doc = read_json_file(config_path);
    if (!doc) {
        return -1;
    }

    yyjson_mut_doc *mdoc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_val_mut_copy(mdoc, yyjson_doc_get_root(doc));
    yyjson_doc_free(doc);
    if (!root) {
        yyjson_mut_doc_free(mdoc);
        return -1;
    }
    yyjson_mut_doc_set_root(mdoc, root);

    yyjson_mut_val *servers = yyjson_mut_obj_get(root, "mcpServers");
    if (!servers || !yyjson_mut_is_obj(servers)) {
        yyjson_mut_doc_free(mdoc);
        return 0;
    }

    yyjson_mut_obj_remove_key(servers, "codebase-memory-mcp");

    int rc = write_json_file(config_path, mdoc);
    yyjson_mut_doc_free(mdoc);
    return rc;
}

/* ── VS Code MCP (servers key with type:stdio) ────────────────── */

int cbm_install_vscode_mcp(const char *binary_path, const char *config_path) {
    if (!binary_path || !config_path) {
        return -1;
    }

    yyjson_mut_doc *mdoc = yyjson_mut_doc_new(NULL);
    if (!mdoc) {
        return -1;
    }

    yyjson_doc *doc = read_json_file(config_path);
    yyjson_mut_val *root;
    if (doc) {
        root = yyjson_val_mut_copy(mdoc, yyjson_doc_get_root(doc));
        yyjson_doc_free(doc);
    } else {
        root = yyjson_mut_obj(mdoc);
    }
    if (!root) {
        yyjson_mut_doc_free(mdoc);
        return -1;
    }
    yyjson_mut_doc_set_root(mdoc, root);

    yyjson_mut_val *servers = yyjson_mut_obj_get(root, "servers");
    if (!servers || !yyjson_mut_is_obj(servers)) {
        servers = yyjson_mut_obj(mdoc);
        yyjson_mut_obj_add_val(mdoc, root, "servers", servers);
    }

    yyjson_mut_obj_remove_key(servers, "codebase-memory-mcp");

    yyjson_mut_val *entry = yyjson_mut_obj(mdoc);
    yyjson_mut_obj_add_str(mdoc, entry, "type", "stdio");
    yyjson_mut_obj_add_str(mdoc, entry, "command", binary_path);
    yyjson_mut_obj_add_val(mdoc, servers, "codebase-memory-mcp", entry);

    int rc = write_json_file(config_path, mdoc);
    yyjson_mut_doc_free(mdoc);
    return rc;
}

int cbm_remove_vscode_mcp(const char *config_path) {
    if (!config_path) {
        return -1;
    }

    yyjson_doc *doc = read_json_file(config_path);
    if (!doc) {
        return -1;
    }

    yyjson_mut_doc *mdoc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_val_mut_copy(mdoc, yyjson_doc_get_root(doc));
    yyjson_doc_free(doc);
    if (!root) {
        yyjson_mut_doc_free(mdoc);
        return -1;
    }
    yyjson_mut_doc_set_root(mdoc, root);

    yyjson_mut_val *servers = yyjson_mut_obj_get(root, "servers");
    if (!servers || !yyjson_mut_is_obj(servers)) {
        yyjson_mut_doc_free(mdoc);
        return 0;
    }

    yyjson_mut_obj_remove_key(servers, "codebase-memory-mcp");

    int rc = write_json_file(config_path, mdoc);
    yyjson_mut_doc_free(mdoc);
    return rc;
}

/* ── Zed MCP (context_servers with source:custom) ─────────────── */

int cbm_install_zed_mcp(const char *binary_path, const char *config_path) {
    if (!binary_path || !config_path) {
        return -1;
    }

    yyjson_mut_doc *mdoc = yyjson_mut_doc_new(NULL);
    if (!mdoc) {
        return -1;
    }

    yyjson_doc *doc = read_json_file(config_path);
    yyjson_mut_val *root;
    if (doc) {
        root = yyjson_val_mut_copy(mdoc, yyjson_doc_get_root(doc));
        yyjson_doc_free(doc);
    } else {
        root = yyjson_mut_obj(mdoc);
    }
    if (!root) {
        yyjson_mut_doc_free(mdoc);
        return -1;
    }
    yyjson_mut_doc_set_root(mdoc, root);

    yyjson_mut_val *servers = yyjson_mut_obj_get(root, "context_servers");
    if (!servers || !yyjson_mut_is_obj(servers)) {
        servers = yyjson_mut_obj(mdoc);
        yyjson_mut_obj_add_val(mdoc, root, "context_servers", servers);
    }

    yyjson_mut_obj_remove_key(servers, "codebase-memory-mcp");

    yyjson_mut_val *entry = yyjson_mut_obj(mdoc);
    yyjson_mut_obj_add_str(mdoc, entry, "source", "custom");
    yyjson_mut_obj_add_str(mdoc, entry, "command", binary_path);
    yyjson_mut_obj_add_val(mdoc, servers, "codebase-memory-mcp", entry);

    int rc = write_json_file(config_path, mdoc);
    yyjson_mut_doc_free(mdoc);
    return rc;
}

int cbm_remove_zed_mcp(const char *config_path) {
    if (!config_path) {
        return -1;
    }

    yyjson_doc *doc = read_json_file(config_path);
    if (!doc) {
        return -1;
    }

    yyjson_mut_doc *mdoc = yyjson_mut_doc_new(NULL);
    yyjson_mut_val *root = yyjson_val_mut_copy(mdoc, yyjson_doc_get_root(doc));
    yyjson_doc_free(doc);
    if (!root) {
        yyjson_mut_doc_free(mdoc);
        return -1;
    }
    yyjson_mut_doc_set_root(mdoc, root);

    yyjson_mut_val *servers = yyjson_mut_obj_get(root, "context_servers");
    if (!servers || !yyjson_mut_is_obj(servers)) {
        yyjson_mut_doc_free(mdoc);
        return 0;
    }

    yyjson_mut_obj_remove_key(servers, "codebase-memory-mcp");

    int rc = write_json_file(config_path, mdoc);
    yyjson_mut_doc_free(mdoc);
    return rc;
}

/* ── PATH management ──────────────────────────────────────────── */

int cbm_ensure_path(const char *bin_dir, const char *rc_file, bool dry_run) {
    if (!bin_dir || !rc_file) {
        return -1;
    }

    char line[1024];
    snprintf(line, sizeof(line), "export PATH=\"%s:$PATH\"", bin_dir);

    /* Check if already present in rc file */
    FILE *f = fopen(rc_file, "r");
    if (f) {
        char buf[2048];
        while (fgets(buf, sizeof(buf), f)) {
            if (strstr(buf, line)) {
                (void)fclose(f);
                return 1; /* already present */
            }
        }
        (void)fclose(f);
    }

    if (dry_run) {
        return 0;
    }

    f = fopen(rc_file, "a");
    if (!f) {
        return -1;
    }

    // NOLINTNEXTLINE(clang-analyzer-security.insecureAPI.DeprecatedOrUnsafeBufferHandling)
    (void)fprintf(f, "\n# Added by codebase-memory-mcp install\n%s\n", line);
    (void)fclose(f);
    return 0;
}

/* ── Tar.gz extraction ────────────────────────────────────────── */

unsigned char *cbm_extract_binary_from_targz(const unsigned char *data, int data_len,
                                             int *out_len) {
    if (!data || data_len <= 0 || !out_len) {
        return NULL;
    }

    /* Decompress gzip */
    z_stream strm = {0};
    // NOLINTNEXTLINE(performance-no-int-to-ptr)
    strm.next_in = (unsigned char *)(uintptr_t)data;
    strm.avail_in = (unsigned int)data_len;

    // NOLINTNEXTLINE(misc-include-cleaner) — MAX_WBITS provided by standard header
    if (inflateInit2(&strm, 16 + MAX_WBITS) != Z_OK) {
        return NULL;
    }

    /* Allocate decompression buffer (up to 500MB) */
    size_t buf_cap = (size_t)data_len * 10;
    if (buf_cap < 4096) {
        buf_cap = 4096;
    }
    if (buf_cap > DECOMPRESS_MAX_BYTES) {
        buf_cap = DECOMPRESS_MAX_BYTES;
    }
    unsigned char *decompressed = malloc(buf_cap);
    if (!decompressed) {
        inflateEnd(&strm);
        return NULL;
    }

    size_t total = 0;
    int ret;
    do {
        if (total >= buf_cap) {
            size_t new_cap = buf_cap * 2;
            if (new_cap > DECOMPRESS_MAX_BYTES) {
                free(decompressed);
                inflateEnd(&strm);
                return NULL;
            }
            unsigned char *nb = realloc(decompressed, new_cap);
            if (!nb) {
                free(decompressed);
                inflateEnd(&strm);
                return NULL;
            }
            decompressed = nb;
            buf_cap = new_cap;
        }
        strm.next_out = decompressed + total;
        strm.avail_out = (unsigned int)(buf_cap - total);
        ret = inflate(&strm, Z_NO_FLUSH);
        total = buf_cap - strm.avail_out;
    } while (ret == Z_OK);

    inflateEnd(&strm);

    if (ret != Z_STREAM_END) {
        free(decompressed);
        return NULL;
    }

    /* Parse tar: find entry starting with "codebase-memory-mcp" */
    size_t pos = 0;
    while (pos + 512 <= total) {
        /* Tar header is 512 bytes */
        const unsigned char *hdr = decompressed + pos;

        /* Check for end-of-archive (two zero blocks) */
        bool all_zero = true;
        for (int i = 0; i < 512 && all_zero; i++) {
            if (hdr[i] != 0) {
                all_zero = false;
            }
        }
        if (all_zero) {
            break;
        }

        /* Extract filename (bytes 0-99) */
        char name[TAR_NAME_LEN] = {0};
        memcpy(name, hdr, TAR_NAME_LEN - 1);

        /* Extract size from octal field */
        char size_str[TAR_SIZE_LEN] = {0};
        memcpy(size_str, hdr + TAR_SIZE_OFFSET, TAR_SIZE_LEN - 1);
        long file_size = strtol(size_str, NULL, 8);

        /* Extract type flag (byte 156) */
        char typeflag = (char)hdr[TAR_TYPE_OFFSET];

        pos += 512; /* skip header */

        /* Check if this is a regular file with our binary name */
        if (typeflag == '0' || typeflag == '\0') {
            /* Get basename */
            const char *basename = strrchr(name, '/');
            basename = basename ? basename + 1 : name;

            if (strncmp(basename, TAR_BINARY_NAME, TAR_BINARY_NAME_LEN) == 0) {
                if (pos + (size_t)file_size <= total) {
                    unsigned char *result = malloc((size_t)file_size);
                    if (result) {
                        memcpy(result, decompressed + pos, (size_t)file_size);
                        *out_len = (int)file_size;
                        free(decompressed);
                        return result;
                    }
                }
            }
        }

        /* Skip to next 512-byte boundary */
        size_t blocks = ((size_t)file_size + TAR_BLOCK_MASK) / TAR_BLOCK_SIZE;
        pos += blocks * 512;
    }

    free(decompressed);
    return NULL; /* binary not found */
}

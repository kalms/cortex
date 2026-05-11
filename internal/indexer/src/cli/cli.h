/*
 * cli.h — CLI subcommand handlers for install, uninstall, update, version.
 *
 * Port of Go cmd/codebase-memory-mcp/ install/update/config logic.
 *
 * Functions accept explicit paths (home_dir, binary_path) rather than
 * reading HOME internally, making them testable with temp directories.
 */
#ifndef CTX_CLI_H
#define CTX_CLI_H

#include <stdbool.h>

/* ── Version ──────────────────────────────────────────────────── */

/* Set the version string (called from main). */
void ctx_cli_set_version(const char *ver);

/* Get the version string. */
const char *ctx_cli_get_version(void);

/* ── Self-update: version comparison ──────────────────────────── */

/* Compare two semver strings (e.g. "0.2.1" vs "0.2.0").
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Handles v-prefix and -dev suffix. */
int ctx_compare_versions(const char *a, const char *b);

/* ── Shell RC detection ───────────────────────────────────────── */

/* Detect the appropriate shell RC file path for the current user.
 * Uses SHELL env var. home_dir is the user's home directory.
 * Returns static buffer — do NOT free. Returns "" if unknown. */
const char *ctx_detect_shell_rc(const char *home_dir);

/* ── CLI binary detection ─────────────────────────────────────── */

/* Find a CLI binary by name.
 * Checks PATH first, then common install locations.
 * Returns static buffer — do NOT free. Returns "" if not found. */
const char *ctx_find_cli(const char *name, const char *home_dir);

/* ── File utilities ───────────────────────────────────────────── */

/* Copy a file from src to dst. Returns 0 on success, -1 on error. */
int ctx_copy_file(const char *src, const char *dst);

/* Replace a binary file: unlinks the existing file first (handles read-only),
 * then creates a new file with the given data and permissions.
 * Returns 0 on success, -1 on error. */
int ctx_replace_binary(const char *path, const unsigned char *data, int len, int mode);

/* ── Skill file management ────────────────────────────────────── */

/* Number of skill files. */
#define CTX_SKILL_COUNT 1

/* Skill name/content pair. */
typedef struct {
    const char *name;    /* e.g. "codebase-memory" */
    const char *content; /* full SKILL.md content */
} ctx_skill_t;

/* Get the array of skill definitions. */
const ctx_skill_t *ctx_get_skills(void);

/* Install skills to skills_dir (e.g. ~/.claude/skills/).
 * If force is true, overwrite existing skills.
 * Returns count of skills written. */
int ctx_install_skills(const char *skills_dir, bool force, bool dry_run);

/* Remove skills from skills_dir.
 * Returns count of skills removed. */
int ctx_remove_skills(const char *skills_dir, bool dry_run);

/* Remove old monolithic skill dir if it exists.
 * Returns true if it was removed. */
bool ctx_remove_old_monolithic_skill(const char *skills_dir, bool dry_run);

/* ── Editor MCP config management ─────────────────────────────── */

/* Install MCP server entry in Cursor/Windsurf/Gemini JSON config.
 * Format: { "mcpServers": { "cortex-indexer": { "command": binary_path } } }
 * Preserves existing entries. Returns 0 on success. */
int ctx_install_editor_mcp(const char *binary_path, const char *config_path);

/* Remove MCP server entry from Cursor/Windsurf/Gemini JSON config.
 * Returns 0 on success. */
int ctx_remove_editor_mcp(const char *config_path);

/* Install MCP server entry in VS Code JSON config.
 * Format: { "servers": { "cortex-indexer": { "type": "stdio", "command": binary_path } } }
 * Returns 0 on success. */
int ctx_install_vscode_mcp(const char *binary_path, const char *config_path);

/* Remove MCP server entry from VS Code JSON config.
 * Returns 0 on success. */
int ctx_remove_vscode_mcp(const char *config_path);

/* Install MCP server entry in Zed settings.json.
 * Format: { "context_servers": { "cortex-indexer": { "command": path, "args": [""] } } }
 * Returns 0 on success. */
int ctx_install_zed_mcp(const char *binary_path, const char *config_path);

/* Remove MCP server entry from Zed settings.json.
 * Returns 0 on success. */
int ctx_remove_zed_mcp(const char *config_path);

/* ── Agent detection ──────────────────────────────────────────── */

/* Detected coding agents on the system. */
typedef struct {
    bool claude_code; /* ~/.claude/ exists */
    bool codex;       /* ~/.codex/ exists */
    bool gemini;      /* ~/.gemini/ exists */
    bool zed;         /* platform-specific Zed config dir exists */
    bool opencode;    /* opencode on PATH or config exists */
    bool antigravity; /* ~/.gemini/antigravity/ exists */
    bool aider;       /* aider on PATH */
    bool kilocode;    /* KiloCode globalStorage dir exists */
    bool vscode;      /* VS Code User config dir exists */
    bool openclaw;    /* ~/.openclaw/ exists */
} ctx_detected_agents_t;

/* Detect which coding agents are installed.
 * Checks config dirs and PATH. home_dir is used for config dir checks. */
ctx_detected_agents_t ctx_detect_agents(const char *home_dir);

/* ── Agent MCP config upsert (per agent) ──────────────────────── */

/* Codex CLI: upsert MCP entry in ~/.codex/config.toml. Returns 0 on success. */
int ctx_upsert_codex_mcp(const char *binary_path, const char *config_path);

/* Remove CMM MCP entry from Codex config.toml. Returns 0 on success. */
int ctx_remove_codex_mcp(const char *config_path);

/* OpenCode: upsert MCP entry in opencode.json. Returns 0 on success. */
int ctx_upsert_opencode_mcp(const char *binary_path, const char *config_path);

/* Remove CMM MCP entry from opencode.json. Returns 0 on success. */
int ctx_remove_opencode_mcp(const char *config_path);

/* Antigravity: upsert MCP entry in ~/.gemini/antigravity/mcp_config.json.
 * Returns 0 on success. */
int ctx_upsert_antigravity_mcp(const char *binary_path, const char *config_path);

/* Remove CMM MCP entry from antigravity mcp_config.json. Returns 0 on success. */
int ctx_remove_antigravity_mcp(const char *config_path);

/* ── Instructions file upsert ─────────────────────────────────── */

/* Upsert a cortex-indexer instruction section in a markdown file.
 * Uses <!-- cortex-indexer:start --> / <!-- cortex-indexer:end --> markers.
 * If markers exist, replaces content between them. Otherwise appends.
 * If file doesn't exist, creates it. Returns 0 on success. */
int ctx_upsert_instructions(const char *path, const char *content);

/* Remove the cortex-indexer instruction section from a markdown file.
 * Returns 0 on success, 1 if not found. */
int ctx_remove_instructions(const char *path);

/* Get the shared agent instructions content (markdown). */
const char *ctx_get_agent_instructions(void);

/* ── Pre-tool hook management ─────────────────────────────────── */

/* Upsert a PreToolUse hook in ~/.claude/settings.json for Claude Code.
 * Adds a Grep|Glob matcher that reminds to use MCP tools.
 * Returns 0 on success. */
int ctx_upsert_claude_hooks(const char *settings_path);

/* Remove our PreToolUse hook from Claude Code settings.json.
 * Returns 0 on success. */
int ctx_remove_claude_hooks(const char *settings_path);

/* Upsert a BeforeTool hook in ~/.gemini/settings.json for Gemini CLI / Antigravity.
 * Returns 0 on success. */
int ctx_upsert_gemini_hooks(const char *settings_path);

/* Remove our BeforeTool hook from Gemini settings.json.
 * Returns 0 on success. */
int ctx_remove_gemini_hooks(const char *settings_path);

/* ── PATH management ──────────────────────────────────────────── */

/* Append an export PATH line to the given rc file.
 * Checks if already present. Returns 0 on success, 1 if already present. */
int ctx_ensure_path(const char *bin_dir, const char *rc_file, bool dry_run);

/* ── Codex instructions (legacy, wraps ctx_get_agent_instructions) ── */

/* Get the Codex CLI instructions content. */
const char *ctx_get_codex_instructions(void);

/* ── Tar.gz extraction ────────────────────────────────────────── */

/* Extract a binary named "cortex-indexer*" from a tar.gz buffer.
 * Returns malloc'd binary content and sets *out_len.
 * Returns NULL on error. Caller must free. */
unsigned char *ctx_extract_binary_from_targz(const unsigned char *data, int data_len, int *out_len);

/* Extract the cortex-indexer binary from a zip archive in memory.
 * Returns malloc'd binary content and sets *out_len.
 * Returns NULL on error. Caller must free. */
unsigned char *ctx_extract_binary_from_zip(const unsigned char *data, int data_len, int *out_len);

/* ── Index management ─────────────────────────────────────────── */

/* List .db files in the cache directory (~/.cache/cortex-indexer/).
 * Prints each file path to stdout. Returns count of .db files found. */
int ctx_list_indexes(const char *home_dir);

/* Remove all .db files in the cache directory. Returns count removed. */
int ctx_remove_indexes(const char *home_dir);

/* ── Config store (persistent key-value, backed by _config.db) ── */

typedef struct ctx_config ctx_config_t;

/* Open the config store in the given cache directory.
 * Creates _config.db if it doesn't exist. Returns NULL on error. */
ctx_config_t *ctx_config_open(const char *cache_dir);

/* Close the config store. */
void ctx_config_close(ctx_config_t *cfg);

/* Get a config value. Returns default_val if key not found. */
const char *ctx_config_get(ctx_config_t *cfg, const char *key, const char *default_val);

/* Get a config value as bool. "true"/"1"/"on" → true. */
bool ctx_config_get_bool(ctx_config_t *cfg, const char *key, bool default_val);

/* Get a config value as int. Returns default_val if not found or invalid. */
int ctx_config_get_int(ctx_config_t *cfg, const char *key, int default_val);

/* Set a config value. Returns 0 on success. */
int ctx_config_set(ctx_config_t *cfg, const char *key, const char *value);

/* Delete a config key. Returns 0 on success. */
int ctx_config_delete(ctx_config_t *cfg, const char *key);

/* Well-known config keys */
#define CTX_CONFIG_AUTO_INDEX "auto_index"
#define CTX_CONFIG_AUTO_INDEX_LIMIT "auto_index_limit"

/* ── Subcommands (wired from main.c) ─────────────────────────── */

/* install: copy binary, install skills, install editor MCP configs, ensure PATH.
 * Prompts to delete old indexes if any exist — rejects on "no". */
int ctx_cmd_install(int argc, char **argv);

/* uninstall: remove skills, remove editor MCP configs, remove binary. */
int ctx_cmd_uninstall(int argc, char **argv);

/* update: check latest release, prompt for index deletion, prompt for ui/standard,
 * download and replace binary. */
int ctx_cmd_update(int argc, char **argv);

/* config: get/set/list/reset runtime config values. */
int ctx_cmd_config(int argc, char **argv);

#endif /* CTX_CLI_H */

/*
 * cli.h — CLI subcommand handlers for install, uninstall, update, version.
 *
 * Port of Go cmd/codebase-memory-mcp/ install/update/config logic.
 *
 * Functions accept explicit paths (home_dir, binary_path) rather than
 * reading HOME internally, making them testable with temp directories.
 */
#ifndef CBM_CLI_H
#define CBM_CLI_H

#include <stdbool.h>

/* ── Version ──────────────────────────────────────────────────── */

/* Set the version string (called from main). */
void cbm_cli_set_version(const char *ver);

/* Get the version string. */
const char *cbm_cli_get_version(void);

/* ── Self-update: version comparison ──────────────────────────── */

/* Compare two semver strings (e.g. "0.2.1" vs "0.2.0").
 * Returns >0 if a > b, <0 if a < b, 0 if equal.
 * Handles v-prefix and -dev suffix. */
int cbm_compare_versions(const char *a, const char *b);

/* ── Shell RC detection ───────────────────────────────────────── */

/* Detect the appropriate shell RC file path for the current user.
 * Uses SHELL env var. home_dir is the user's home directory.
 * Returns static buffer — do NOT free. Returns "" if unknown. */
const char *cbm_detect_shell_rc(const char *home_dir);

/* ── CLI binary detection ─────────────────────────────────────── */

/* Find a CLI binary by name.
 * Checks PATH first, then common install locations.
 * Returns static buffer — do NOT free. Returns "" if not found. */
const char *cbm_find_cli(const char *name, const char *home_dir);

/* ── File utilities ───────────────────────────────────────────── */

/* Copy a file from src to dst. Returns 0 on success, -1 on error. */
int cbm_copy_file(const char *src, const char *dst);

/* ── Skill file management ────────────────────────────────────── */

/* Number of skill files. */
#define CBM_SKILL_COUNT 4

/* Skill name/content pair. */
typedef struct {
    const char *name;    /* e.g. "codebase-memory-exploring" */
    const char *content; /* full SKILL.md content */
} cbm_skill_t;

/* Get the array of skill definitions. */
const cbm_skill_t *cbm_get_skills(void);

/* Install skills to skills_dir (e.g. ~/.claude/skills/).
 * If force is true, overwrite existing skills.
 * Returns count of skills written. */
int cbm_install_skills(const char *skills_dir, bool force, bool dry_run);

/* Remove skills from skills_dir.
 * Returns count of skills removed. */
int cbm_remove_skills(const char *skills_dir, bool dry_run);

/* Remove old monolithic skill dir if it exists.
 * Returns true if it was removed. */
bool cbm_remove_old_monolithic_skill(const char *skills_dir, bool dry_run);

/* ── Editor MCP config management ─────────────────────────────── */

/* Install MCP server entry in Cursor/Windsurf/Gemini JSON config.
 * Format: { "mcpServers": { "codebase-memory-mcp": { "command": binary_path } } }
 * Preserves existing entries. Returns 0 on success. */
int cbm_install_editor_mcp(const char *binary_path, const char *config_path);

/* Remove MCP server entry from Cursor/Windsurf/Gemini JSON config.
 * Returns 0 on success. */
int cbm_remove_editor_mcp(const char *config_path);

/* Install MCP server entry in VS Code JSON config.
 * Format: { "servers": { "codebase-memory-mcp": { "type": "stdio", "command": binary_path } } }
 * Returns 0 on success. */
int cbm_install_vscode_mcp(const char *binary_path, const char *config_path);

/* Remove MCP server entry from VS Code JSON config.
 * Returns 0 on success. */
int cbm_remove_vscode_mcp(const char *config_path);

/* Install MCP server entry in Zed settings.json.
 * Format: { "context_servers": { "codebase-memory-mcp": { "source": "custom", "command":
 * binary_path } } } Returns 0 on success. */
int cbm_install_zed_mcp(const char *binary_path, const char *config_path);

/* Remove MCP server entry from Zed settings.json.
 * Returns 0 on success. */
int cbm_remove_zed_mcp(const char *config_path);

/* ── PATH management ──────────────────────────────────────────── */

/* Append an export PATH line to the given rc file.
 * Checks if already present. Returns 0 on success, 1 if already present. */
int cbm_ensure_path(const char *bin_dir, const char *rc_file, bool dry_run);

/* ── Codex instructions ───────────────────────────────────────── */

/* Get the Codex CLI instructions content. */
const char *cbm_get_codex_instructions(void);

/* ── Tar.gz extraction ────────────────────────────────────────── */

/* Extract a binary named "codebase-memory-mcp*" from a tar.gz buffer.
 * Returns malloc'd binary content and sets *out_len.
 * Returns NULL on error. Caller must free. */
unsigned char *cbm_extract_binary_from_targz(const unsigned char *data, int data_len, int *out_len);

#endif /* CBM_CLI_H */

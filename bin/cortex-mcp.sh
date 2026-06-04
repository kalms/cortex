#!/usr/bin/env bash
# Entry point for the Cortex MCP server.
#
# This script is invoked from TWO contexts; both land at the same
# `exec npx tsx src/index.ts` after locating the repo root.
#
#   1. Plugin context — Claude Code spawns this from
#      ~/.claude/plugins/cache/cortex-local/cortex/<version>/.mcp.json.
#      Claude Code sets $CLAUDE_PLUGIN_ROOT in the child env; we use it
#      directly. (Runs the cached/published plugin version.)
#
#   2. Project context — Claude Code spawns this from the repo's own
#      .mcp.json at the repo root. $CLAUDE_PLUGIN_ROOT is empty here, so
#      we fall back to BASH_SOURCE/.. to locate ourselves. (Runs live src/,
#      no plugin reinstall needed for dev iteration.)
#
# Why a wrapper at all, instead of `command: "npx", args: ["tsx", "src/index.ts"]`
# directly in .mcp.json: Claude Code does NOT reliably honor the `cwd` field
# in .mcp.json configs. In plugin context the inherited cwd is the user's
# project directory (which has no tsx/src/index.ts), so we must chdir into
# PLUGIN_ROOT ourselves before exec'ing the server.
#
# Why .mcp.json uses `exec "${CLAUDE_PLUGIN_ROOT:-$PWD}/bin/cortex-mcp.sh"`
# (a single expression that works in both contexts): $CLAUDE_PLUGIN_ROOT is
# set only when Claude Code spawns plugin-scoped MCP servers; project-scoped
# servers get an empty value. Bash's `${VAR:-fallback}` parameter expansion
# evaluates to $CLAUDE_PLUGIN_ROOT when set (plugin context), or to $PWD
# when unset/empty (project context — $PWD equals the repo root because
# Claude Code spawns project servers from the repo containing .mcp.json).
# One file works in both contexts, so the cache stays in sync with the repo
# without per-context divergence. Earlier iterations used $PWD-only or
# $CLAUDE_PLUGIN_ROOT-only forms, which each broke the *other* context with
# `MCP error -32000: Connection closed`.
set -euo pipefail
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$PLUGIN_ROOT"
exec npx tsx src/index.ts

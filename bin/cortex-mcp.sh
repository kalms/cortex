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
# Why the project .mcp.json uses `exec "$PWD/bin/cortex-mcp.sh"` rather than
# `exec "$CLAUDE_PLUGIN_ROOT/bin/cortex-mcp.sh"`: $CLAUDE_PLUGIN_ROOT is only
# set when Claude Code spawns plugin-scoped MCP servers; project-scoped
# servers get an empty value, which expanded to `/bin/cortex-mcp.sh` and
# silently failed with `MCP error -32000: Connection closed`. $PWD at spawn
# time equals the repo root for a project-scoped .mcp.json that lives there,
# so it resolves correctly without depending on plugin-only env.
set -euo pipefail
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$PLUGIN_ROOT"
exec npx tsx src/index.ts

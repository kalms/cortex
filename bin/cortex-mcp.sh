#!/usr/bin/env bash
# Entry point for the Cortex MCP server.
#
# Why this exists: Claude Code's MCP-spawn does not reliably honor the `cwd`
# field in plugin or project `.mcp.json` configs — it inherits the host
# session's cwd (the user's project directory), which has no `tsx` and no
# `src/index.ts`. We chdir into $CLAUDE_PLUGIN_ROOT ourselves before exec'ing
# the server. CLAUDE_PLUGIN_ROOT is passed in the child env by Claude Code.
set -euo pipefail
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$PLUGIN_ROOT"
exec npx tsx src/index.ts

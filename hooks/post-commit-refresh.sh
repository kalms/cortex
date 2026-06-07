#!/usr/bin/env bash
# PostToolUse hook (fires only on `git commit*` via the hooks.json `if`):
# refresh the index incrementally so the graph tracks the new HEAD. Safe to run
# mid-session now that incremental persist is inode-preserving (the live
# .cortex/db is never unlinked, so the MCP server's open handle survives).
# Best-effort and silent; gated by CORTEX_AUTO_REFRESH.
set -u
[ "${CORTEX_AUTO_REFRESH:-1}" = "0" ] && exit 0
CORTEX_BIN="${CLAUDE_PLUGIN_ROOT:-.}/bin/cortex"
[ -x "$CORTEX_BIN" ] || CORTEX_BIN="$(command -v cortex || echo ./bin/cortex)"
"$CORTEX_BIN" index >/dev/null 2>&1 || true
exit 0

#!/usr/bin/env bash
# Entry point for the Cortex MCP server.
#
# Invoked from TWO contexts; both resolve the repo root and `exec npx tsx
# src/index.ts` from it:
#
#   1. Plugin context — Claude Code spawns this from the installed plugin's
#      bundled .mcp.json. Claude Code locates the plugin directory by
#      STRING-SUBSTITUTING the literal `${CLAUDE_PLUGIN_ROOT}` token in the
#      .mcp.json values before spawn. Two things it does NOT do (both learned
#      the hard way — MCP error -32000, Connection closed):
#        - it does NOT export CLAUDE_PLUGIN_ROOT into this process's env, and
#        - it only substitutes the EXACT bare token, not the bash-style
#          `${CLAUDE_PLUGIN_ROOT:-default}` form (that form is left for the
#          general env-interpolation, which has no CLAUDE_PLUGIN_ROOT and so
#          collapses to the default — the original launch bug, T-mskp).
#      So .mcp.json uses the bare token and execs us by absolute path.
#
#   2. Project/dev context — the cortex repo's own .mcp.json is loaded as a
#      project-scoped server. `${CLAUDE_PLUGIN_ROOT}` is not substituted there,
#      so .mcp.json falls back to $PWD (the repo root, where Claude spawns the
#      project server) to locate this script.
#
# Because .mcp.json execs us by absolute path in BOTH contexts, BASH_SOURCE
# points at the real script location, so we self-locate the repo root from it
# rather than trusting any env var. Running from the repo root lets
# `npx tsx src/index.ts` resolve tsx and the sources.
#
# NOTE: everything before `exec` must write ONLY to stderr — stdout is the
# MCP JSON-RPC channel and any stray byte there corrupts the protocol.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Native-module self-heal backstop (T-mskp bug 2): some plugin install/update
# paths copy node_modules without rebuilding better-sqlite3's native binding
# for this platform, so GraphStore's `new Database()` throws on boot
# ("Could not locate the bindings file"). Probe the binding and rebuild once
# if it's missing. Quiet on the happy path; never fatal — if the rebuild can't
# fix it we still exec and let the real startup error surface.
#
# The probe CONSTRUCTS a Database rather than just `require`-ing the package:
# better-sqlite3's index.js loads fine without the binding — the native `.node`
# is lazy-loaded only when a Database is instantiated (lib/database.js), which
# is exactly where boot crashes. A bare `require` probe would falsely pass.
if ! node -e 'new (require("better-sqlite3"))(":memory:").close()' >/dev/null 2>&1; then
  echo "cortex: better-sqlite3 native binding missing — rebuilding (one-time)…" >&2
  # Targeted: rebuild the native binding, or reinstall just this one package if
  # its dir is absent. Deliberately NOT a bare `npm install` — that would pull
  # the full devDependency tree into the plugin cache to fix one binding.
  npm rebuild better-sqlite3 1>&2 || npm install better-sqlite3 --no-save --omit=dev 1>&2 || true
fi

exec npx tsx src/index.ts

#!/usr/bin/env bash
# Hook: check-index (SessionStart)
#
# Goal: prevent agents from defaulting to grep/Read for code exploration
# when Cortex MCP tools are available. Fires on session start / resume /
# clear / compact via the plugin's hooks.json.
#
# Behavior:
#   1. Try to detect whether the current working directory is indexed by
#      Cortex (uses bin/cortex-indexer if available, else degrades to a
#      protocol reminder).
#   2. Emit a *specific* routing table for this project, naming the tools
#      the agent should reach for first.
#
# The hook MUST be safe to run in any cwd — including non-Cortex repos
# that happen to have this plugin installed. It never errors out; the
# worst case is an emitted reminder with no index status info.

REPO="$PWD"

# The MCP server resolves the DB path via resolveCortexDbPath():
#   1. $CORTEX_DB env override
#   2. <repo>/.cortex/graph.db (walks up for .git)
#   3. fallback under the cache dir
# We replicate just (1) and (2) — the common cases. A graph.db file present
# in either location is a strong proxy for "indexed".
INDEX_STATE="not-indexed"
DB_PATH=""
if [ -n "$CORTEX_DB" ] && [ -f "$CORTEX_DB" ]; then
    DB_PATH="$CORTEX_DB"
    INDEX_STATE="indexed"
elif [ -f "$REPO/.cortex/graph.db" ]; then
    DB_PATH="$REPO/.cortex/graph.db"
    INDEX_STATE="indexed"
else
    # Walk up to the git root and check there too — handles cases where
    # the hook fires in a subdirectory of the repo.
    GIT_ROOT="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)"
    if [ -n "$GIT_ROOT" ] && [ -f "$GIT_ROOT/.cortex/graph.db" ]; then
        DB_PATH="$GIT_ROOT/.cortex/graph.db"
        REPO="$GIT_ROOT"
        INDEX_STATE="indexed"
    fi
fi

cat <<EOF
=== Cortex routing for this session ===

Repo: $REPO
Index state: $INDEX_STATE

EOF

case "$INDEX_STATE" in
    indexed)
        cat <<'EOF'
The repo is indexed by Cortex. For code exploration, prefer these MCP tools
over grep/Read:

  - search_graph(name_pattern="…")    → find functions/classes by name
  - get_code_snippet(qualified_name)  → read source for a known symbol
  - trace_path(function_name, mode="callers"|"calls")
                                       → who calls X / what X calls
  - why_was_this_built(qualified_name) → check governing decisions
  - search_code(pattern)              → graph-augmented grep
  - get_architecture(aspects)         → project structure overview

Fall back to Grep/Glob/Read only for:
  - Configs, docs, JSON, plain-text files
  - Cases where Cortex returns no results AND the index is current

After any non-trivial commit, consider:
  - propose_decision / create_decision if an architectural choice was made
  - detect_changes + index_repository to keep the graph current
EOF
        ;;
    not-indexed)
        cat <<'EOF'
The repo is NOT indexed by Cortex. Before any code exploration, run:

  index_repository(path="<repo path>")

Without an index, search_graph / get_code_snippet / trace_path return empty
and you'll be forced to fall back to grep. Index once up front and the
session's code-discovery is hash-O(1) for the rest of the work.

After indexing, use:
  - search_graph, get_code_snippet, trace_path, why_was_this_built
  - search_code for text patterns with structural context
EOF
        ;;
    unknown)
        cat <<'EOF'
Could not determine index state (no cortex-indexer binary found in
\$PWD/bin/ or \$PATH).

If this repo IS the Cortex repo: build the indexer first
(\`make -f internal/indexer/Makefile.indexer indexer && cp build/c/cortex-indexer bin/\`).

If this repo USES Cortex as a plugin: ensure the cortex MCP server is
configured and call \`index_status\` directly via the MCP tool to learn
the state. Then proceed with search_graph etc. before reaching for grep.
EOF
        ;;
esac

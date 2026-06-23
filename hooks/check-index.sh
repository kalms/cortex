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

# The MCP server resolves the read DB via resolveGraphDbForRead(), preferring
# the canonical <repo>/.cortex/db and falling back to the legacy graph.db /
# cache slot. We replicate the common cases here. We use `-s` (exists AND
# non-empty) rather than `-f`: a 0-byte `.cortex/db` is a degraded/aborted
# index, NOT an indexed repo — treating it as indexed would mask the stale-read
# fallback (see the graph-db-stale-reads field note).
INDEX_STATE="not-indexed"
DB_PATH=""
if [ -n "$CORTEX_DB" ] && [ -s "$CORTEX_DB" ]; then
    DB_PATH="$CORTEX_DB"
    INDEX_STATE="indexed"
elif [ -s "$REPO/.cortex/db" ]; then
    DB_PATH="$REPO/.cortex/db"
    INDEX_STATE="indexed"
elif [ -s "$REPO/.cortex/graph.db" ]; then
    DB_PATH="$REPO/.cortex/graph.db"
    INDEX_STATE="indexed"
else
    # Walk up to the git root and check there too — handles cases where
    # the hook fires in a subdirectory of the repo.
    GIT_ROOT="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)"
    if [ -n "$GIT_ROOT" ] && [ -s "$GIT_ROOT/.cortex/db" ]; then
        DB_PATH="$GIT_ROOT/.cortex/db"
        REPO="$GIT_ROOT"
        INDEX_STATE="indexed"
    elif [ -n "$GIT_ROOT" ] && [ -s "$GIT_ROOT/.cortex/graph.db" ]; then
        DB_PATH="$GIT_ROOT/.cortex/graph.db"
        REPO="$GIT_ROOT"
        INDEX_STATE="indexed"
    fi
fi

# Locate a cortex CLI for best-effort freshness / decision-count probes.
CORTEX_BIN=""
if [ -n "$CLAUDE_PLUGIN_ROOT" ] && [ -x "$CLAUDE_PLUGIN_ROOT/bin/cortex" ]; then
    CORTEX_BIN="$CLAUDE_PLUGIN_ROOT/bin/cortex"
elif [ -x "$REPO/bin/cortex" ]; then
    CORTEX_BIN="$REPO/bin/cortex"
fi

# Compute the freshness verdict, optionally auto-refresh out-of-band (this runs
# at SessionStart, BEFORE the agent reads — a clean boundary), then fold the
# verdict into the banner so a stale/degraded graph is loud.
#
# Auto-refresh runs at SessionStart (here) AND mid-session after every commit
# (hooks/post-commit-refresh.sh). Both are safe now that the write path builds
# into a staging DB and publishes via a single WAL transaction (publishStagedDb,
# decision D-syde supersedes D-qmv5): the live .cortex/db is never truncated or
# unlinked out-of-band, so the MCP server's open pooled handle sees the new
# snapshot with no reopen. `cortex index` auto-selects incremental when a
# populated DB exists and a full reindex otherwise — one verb covers both the
# empty/degraded and the stale cases. Gated by CORTEX_AUTO_REFRESH=0.
if [ "$INDEX_STATE" = "indexed" ] && [ -n "$CORTEX_BIN" ]; then
    FRESHNESS="$(cd "$REPO" && "$CORTEX_BIN" freshness 2>/dev/null | head -1)"
    if [ "${CORTEX_AUTO_REFRESH:-1}" != "0" ]; then
        case "$FRESHNESS" in
            empty*|unknown*)
                echo "Cortex: index missing/degraded — rebuilding (one-time)…" >&2
                (cd "$REPO" && "$CORTEX_BIN" index >/dev/null 2>&1) || true
                FRESHNESS="$(cd "$REPO" && "$CORTEX_BIN" freshness 2>/dev/null | head -1)"
                ;;
            stale:*)
                echo "Cortex: index stale — incremental refresh…" >&2
                (cd "$REPO" && "$CORTEX_BIN" index >/dev/null 2>&1) || true
                FRESHNESS="$(cd "$REPO" && "$CORTEX_BIN" freshness 2>/dev/null | head -1)"
                ;;
        esac
    fi
    if [ -n "$FRESHNESS" ] && [ "$FRESHNESS" != "fresh" ]; then
        INDEX_STATE="indexed ($FRESHNESS)"
    fi
fi

cat <<EOF
=== Cortex routing for this session ===

Repo: $REPO
Repo path: $REPO
Index state: $INDEX_STATE

Cortex MCP tools require an absolute repo_path argument (except
list_projects / delete_project). Use the Repo path above when calling
tools about this repo; for multi-repo work, pass the explicit path of
the repo the call is about.

EOF

case "$INDEX_STATE" in
    indexed*)
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
        # Cold-start decision seeding: if the durable decisions store is empty,
        # nudge the agent to bootstrap it. Degrade-safe — never errors, and only
        # prompts when we can confirm a zero count. Reuses $CORTEX_BIN resolved
        # above.
        if [ -n "$CORTEX_BIN" ]; then
            DECISION_COUNT="$(cd "$REPO" && "$CORTEX_BIN" decision count 2>/dev/null | tr -dc '0-9')"
            if [ "$DECISION_COUNT" = "0" ]; then
                cat <<'EOF'

--- Cold-start: no decisions captured yet ---
This repo is indexed but has zero decisions, so why_was_this_built and
search_decisions are empty. Offer to bootstrap them:

  Run the `seed-decisions` skill — it frames candidates from git history and
  docs (via the decision_candidates MCP tool), writes them as `proposed`
  decisions with provenance, and asks you to ratify a subset.
EOF
            fi
        fi
        # Reconciliation drift probe (opt-in). Cheap: deterministic hash compare, no LLM.
        if [ "${CORTEX_RECONCILE:-0}" = "1" ] && [ -n "$CORTEX_BIN" ]; then
            DRIFTED="$(cd "$REPO" && "$CORTEX_BIN" reconcile status 2>/dev/null | tr -dc '0-9')"
            if [ -n "$DRIFTED" ] && [ "$DRIFTED" -gt 0 ]; then
                printf '↻ %s decision(s) drifted since last reconciliation. Call pending_reconciliations to refresh their verdicts.\n' "$DRIFTED"
            fi
        fi
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

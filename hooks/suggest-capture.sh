#!/usr/bin/env bash
# Hook: suggest-capture
#
# Fires after git commits. Two nudges:
#   1. If architectural decisions were made → propose_decision / create_decision
#   2. If code files changed → detect_changes + incremental index_repository
#      to keep the Cortex graph current with the commit
#
# Wired via hooks.json PostToolUse hook with if: "Bash(git commit*)".

# Detect whether the last commit touched code (not just docs/config).
# We grep the most-recent commit's diff-stat for known code extensions.
CODE_TOUCHED=0
if git rev-parse --git-dir >/dev/null 2>&1; then
    if git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null \
        | grep -qE '\.(c|h|cc|cpp|hpp|ts|tsx|js|jsx|py|go|rs|java|kt|rb|swift|vue|svelte|m|mm|cs|scala|php|cu|cuh)$'; then
        CODE_TOUCHED=1
    fi
fi

echo ""
echo "---"
echo "Were any architectural or design decisions made in this commit?"
echo "If so, use create_decision to capture the decision with its rationale and alternatives."
echo "Use search_decisions first to check if a similar decision already exists."
if [ "$CODE_TOUCHED" -eq 1 ]; then
    echo ""
    echo "Code files changed. To keep Cortex's graph current for subsequent"
    echo "search_graph / get_code_snippet / trace_path queries, run:"
    echo "  detect_changes(path=\"<repo>\")  → preview the delta"
    echo "  index_repository(path=\"<repo>\") → apply (incremental)"
fi
echo "---"

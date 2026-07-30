#!/usr/bin/env bash
# Hook: suggest-capture
#
# Fires after git commits and merges. Nudges, in order of specificity:
#   1. `gh pr merge` just ran → the merge happened on the REMOTE (and may be
#      a squash/rebase that never creates a local merge commit): emit a
#      sync-then-draft instruction anchored to the pre-merge origin sha.
#   2. Local merge commit landed (HEAD^2 exists) → WARM-PATH DRAFTING: run
#      branch-scoped decision candidates and propose drafts for one-tap
#      ratification (field-report P4; proposed-only per decision D-vz80).
#   3. Ordinary commit → the original "were decisions made?" reminder.
#   4. If code files changed → detect_changes + incremental index_repository
#      to keep the Cortex graph current with the commit.
#
# Wired via hooks.json PostToolUse with if: "Bash(git commit*)",
# "Bash(git merge*)" and "Bash(gh pr merge*)".

# The PostToolUse payload (JSON on stdin) tells us WHICH command fired the
# hook — a remote `gh pr merge` needs different guidance from a local merge.
# Degrade-safe: no stdin / no jq / no payload → treat as a plain commit.
TRIGGER_CMD=""
if [ ! -t 0 ] && command -v jq >/dev/null 2>&1; then
    PAYLOAD="$(cat 2>/dev/null)"
    [ -n "$PAYLOAD" ] && TRIGGER_CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)"
fi

# Detect whether the last commit touched code (not just docs/config).
# We grep the most-recent commit's diff-stat for known code extensions.
CODE_TOUCHED=0
IS_MERGE=0
if git rev-parse --git-dir >/dev/null 2>&1; then
    if git diff-tree --no-commit-id --name-only -r HEAD 2>/dev/null \
        | grep -qE '\.(c|h|cc|cpp|hpp|ts|tsx|js|jsx|py|go|rs|java|kt|rb|swift|vue|svelte|m|mm|cs|scala|php|cu|cuh)$'; then
        CODE_TOUCHED=1
    fi
    # HEAD^2 exists only on merge commits.
    if git rev-parse -q --verify 'HEAD^2' >/dev/null 2>&1; then
        IS_MERGE=1
    fi
fi

echo ""
echo "---"
case "$TRIGGER_CMD" in
    "gh pr merge"*)
        # Remote merge: local HEAD hasn't moved (and squash/rebase merges
        # never create a HEAD^2). Anchor drafting to the pre-fetch origin
        # default-branch sha — after the pull, base..HEAD is the PR's delta.
        DEFAULT_REMOTE="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)"
        [ -n "$DEFAULT_REMOTE" ] || DEFAULT_REMOTE="origin/main"
        PRE_MERGE_SHA="$(git rev-parse -q --verify "$DEFAULT_REMOTE" 2>/dev/null)"
        echo "A PR just merged on the remote. Draft the decisions it embodies (warm path):"
        echo "  1. Sync the default branch (e.g. git checkout main && git pull)"
        if [ -n "$PRE_MERGE_SHA" ]; then
            echo "  2. decision({action:\"candidates\", base:\"$PRE_MERGE_SHA\"})  ← pre-merge $DEFAULT_REMOTE"
        else
            echo "  2. decision({action:\"candidates\", base:\"<pre-merge $DEFAULT_REMOTE sha>\"})"
        fi
        echo "  3. For each GENUINE choice: decision({action:\"propose\", author:\"cortex:draft\", provenance:{...}})"
        echo "  4. Present the proposed drafts to the user for ratification (decision({action:\"promote\"}))."
        echo "Check decision({action:\"search\"}) first to avoid duplicating an existing decision."
        echo "---"
        exit 0
        ;;
esac
if [ "$IS_MERGE" -eq 1 ]; then
    echo "A branch was just merged. Draft the decisions it embodies (warm path):"
    echo "  1. decision({action:\"candidates\", base:\"HEAD^1\"})"
    echo "     → candidate manifest scoped to the merged branch only"
    echo "  2. For each GENUINE choice (pattern/library/contract/default — not routine work):"
    echo "     decision({action:\"propose\", author:\"cortex:draft\", title, problem, resolution, rationale,"
    echo "               provenance:{source:\"commits\", confidence:..., commit_shas:[...]}})"
    echo "  3. Tell the user what you proposed so they can ratify with decision({action:\"promote\"})"
    echo "     or discard. Drafts stay status:\"proposed\" until ratified."
    echo "Check decision({action:\"search\"}) first to avoid duplicating an existing decision."
else
    echo "Were any architectural or design decisions made in this commit?"
    echo "If so, use decision({action:\"create\"}) to capture the decision with its rationale and alternatives."
    echo "Use decision({action:\"search\"}) first to check if a similar decision already exists."
fi
if [ "$CODE_TOUCHED" -eq 1 ]; then
    echo ""
    echo "Code files changed. To keep Cortex's graph current for subsequent"
    echo "search_graph / get_code_snippet / trace_path queries, run:"
    echo "  detect_changes(path=\"<repo>\")  → preview the delta"
    echo "  index_repository(path=\"<repo>\") → apply (incremental)"
fi
echo "---"

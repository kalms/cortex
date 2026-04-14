#!/usr/bin/env bash
# Hook: suggest-capture
#
# Fires after git commits to nudge the agent into considering
# whether any architectural decisions should be captured in Cortex.
#
# Installed via settings.local.json PostToolUse hook with
# if: "Bash(git commit*)" to only trigger on commits.

echo ""
echo "---"
echo "Were any architectural or design decisions made in this commit?"
echo "If so, use create_decision to capture the decision with its rationale and alternatives."
echo "Use search_decisions first to check if a similar decision already exists."
echo "---"

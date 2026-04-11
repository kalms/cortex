#!/usr/bin/env bash
# Hook: suggest-capture
#
# Fires after commits or plan completion to nudge the agent
# into considering whether any decisions should be captured.
#
# Install in .claude/settings.local.json:
# {
#   "hooks": {
#     "PostToolUse": [{
#       "matcher": "Bash",
#       "hooks": ["bash src/hooks/suggest-capture.sh"]
#     }]
#   }
# }

echo ""
echo "---"
echo "Were any architectural or design decisions made during this work?"
echo "If so, use create_decision to capture the decision with its rationale and alternatives."
echo "Use search_decisions first to check if a similar decision already exists."
echo "---"

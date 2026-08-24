#!/usr/bin/env bash
# Shared auto-index denylist — sourced by BOTH hooks/check-index.sh
# (SessionStart) and hooks/prefer-cortex.sh (PreToolUse's maybe_bg_index) so
# the two auto-index enforcement points can never drift apart. Never
# auto-index junk/vendored/eval-clone trees. `.tmp` is cortex's eval-corpus
# clone convention (the real pollution source); the others are build/
# dependency dirs that aren't real project roots. Bare system `/tmp` is
# intentionally NOT denylisted — a git repo a user actively works in there is
# a legitimate index target, and `os.tmpdir()` is `/tmp` on Linux, so
# denylisting it would wrongly exclude every Linux temp-dir repo.
#
# Degrade-safe by construction, no special-casing required at the call site:
# if this file is missing/unreadable, callers simply don't source it, so
# AUTO_INDEX_DENYLIST_RE stays unset/empty. `grep -Eq ""` (an empty pattern)
# matches unconditionally, so the caller's `... | grep -Eq "$AUTO_INDEX_DENYLIST_RE"`
# guard reads every target as denylisted — auto-index fails CLOSED (skips)
# rather than open (auto-indexing everything) when the shared file can't be
# loaded.
AUTO_INDEX_DENYLIST_RE='(^|/)(\.tmp|node_modules|vendor|dist|build|\.cache)(/|$)'

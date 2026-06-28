#!/usr/bin/env bash
# Hook: brief-edit (PreToolUse on Edit|Write|MultiEdit) — edit-time block-once backstop.
# Degrade-safe: ANY failure / missing jq / missing cli → exit 0 (allow).
set +e

command -v jq >/dev/null 2>&1 || exit 0

[ "${CORTEX_BRIEF:-1}" = "0" ] && exit 0
[ "${CORTEX_BRIEF_BLOCK:-1}" = "0" ] && exit 0

PAYLOAD="$(cat)"; [ -n "$PAYLOAD" ] || exit 0

TOOL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)"
case "$TOOL" in Edit|Write|MultiEdit) ;; *) exit 0 ;; esac

FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$FILE" ] || exit 0

ROOT="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null)"
[ -n "$ROOT" ] || ROOT="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$ROOT" ] || exit 0

# Canonicalize ROOT the same way FILE is canonicalized, so the prefix strip works
# even on macOS where /tmp → /private/tmp (important when ROOT came from .cwd fallback).
_RROOT="$(cd "$ROOT" 2>/dev/null && pwd -P 2>/dev/null)"
[ -n "$_RROOT" ] && ROOT="$_RROOT"

# Resolve symlinks in FILE so the prefix strip works even on macOS where /tmp → /private/tmp.
_DIR="$(dirname "$FILE")"
_BASE="$(basename "$FILE")"
_RDIR="$(cd "$_DIR" 2>/dev/null && pwd -P 2>/dev/null)"
[ -n "$_RDIR" ] && FILE="$_RDIR/$_BASE"
REL="${FILE#"$ROOT"/}"
CDIR="$ROOT/.cortex"
CACHE="$CDIR/.brief-gate-cache"
LEDGER="$CDIR/.briefed"
BLOCKED="$CDIR/.brief-blocked"

# Cheap pre-filter: if a cache exists and REL isn't gated, allow with no CLI spawn.
if [ -f "$CACHE" ]; then grep -qxF "$REL" "$CACHE" 2>/dev/null || exit 0; fi

# Studied this session → disarmed.
[ -f "$LEDGER" ] && grep -qxF "$REL" "$LEDGER" 2>/dev/null && exit 0

# Already blocked once → let it through.
[ -f "$BLOCKED" ] && grep -qxF "$REL" "$BLOCKED" 2>/dev/null && exit 0

# Resolve the CLI (env override → PATH). No-op if unresolvable.
BIN="${CORTEX_BIN:-}"
[ -n "$BIN" ] || BIN="$(command -v cortex 2>/dev/null)"
[ -n "$BIN" ] || exit 0

HEADLINE="$(cd "$ROOT" && "$BIN" brief "$REL" 2>/dev/null)"
[ -n "$HEADLINE" ] || exit 0

mkdir -p "$CDIR" 2>/dev/null || true
printf '%s\n' "$REL" >> "$BLOCKED" 2>/dev/null || true

REASON="$(printf 'Pre-edit briefing for %s (study-time backstop — block-once):\n\n%s\n\nRe-issue the edit to proceed. Tip: get_code_snippet/trace_path on this symbol silences this for the rest of the session.' "$REL" "$HEADLINE")"
jq -n --arg r "$REASON" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0

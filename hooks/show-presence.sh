#!/usr/bin/env bash
# Hook: show-presence (PostToolUse) — streams agent activity to the viewer's
# presence pipeline. Fire-and-forget POST /api/presence; degrade-safe: ANY
# failure / missing jq / no server → exit 0 silently. Never blocks the agent.
# Spec: .superpowers/specs/2026-07-23-show-your-work-design.md §3.
set +e

[ "${CORTEX_PRESENCE:-1}" = "0" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

PAYLOAD="$(cat)"; [ -n "$PAYLOAD" ] || exit 0

TOOL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)"
SESSION="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)"
[ -n "$TOOL" ] && [ -n "$SESSION" ] || exit 0

ACTIVITY="" REF="" ROOT=""

case "$TOOL" in
  Read|Edit|Write|MultiEdit)
    FILE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
    [ -n "$FILE" ] || exit 0
    ROOT="$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null)"
    [ -n "$ROOT" ] || exit 0
    # Canonicalize both sides (macOS /tmp → /private/tmp) so the prefix strip works.
    _R="$(cd "$ROOT" 2>/dev/null && pwd -P)"; [ -n "$_R" ] && ROOT="$_R"
    _D="$(cd "$(dirname "$FILE")" 2>/dev/null && pwd -P)"; [ -n "$_D" ] && FILE="$_D/$(basename "$FILE")"
    case "$FILE" in "$ROOT"/*) ;; *) exit 0 ;; esac   # scope filter: outside repo → drop
    REF="${FILE#"$ROOT"/}"
    case "$TOOL" in Read) ACTIVITY="studied" ;; *) ACTIVITY="edited" ;; esac
    ;;
  mcp__*cortex*__get_code_snippet|mcp__*cortex*__context_pack|mcp__*cortex*__search_graph|\
  mcp__*cortex*__trace_path|mcp__*cortex*__decision)
    ROOT="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.repo_path // empty' 2>/dev/null)"
    [ -n "$ROOT" ] || exit 0
    case "$TOOL" in
      *__trace_path)
        ACTIVITY="traced"
        REF="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.function_name // empty' 2>/dev/null)" ;;
      *__decision)
        ACTION="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.action // empty' 2>/dev/null)"
        case "$ACTION" in why|get) ;; *) exit 0 ;; esac   # reads only — writes self-emit server-side
        ACTIVITY="consulted"
        REF="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.qualified_name // .tool_input.decision_id // .tool_input.id // empty' 2>/dev/null)" ;;
      *)
        ACTIVITY="studied"
        REF="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.qualified_name // .tool_input.name_pattern // empty' 2>/dev/null)" ;;
    esac
    ;;
  *) exit 0 ;;
esac

[ -n "$ACTIVITY" ] && [ -n "$REF" ] && [ -n "$ROOT" ] || exit 0
WORKSPACE="$(basename "$ROOT")"

BODY="$(jq -cn --arg s "$SESSION" --arg r "$ROOT" --arg w "$WORKSPACE" --arg a "$ACTIVITY" --arg ref "$REF" \
  '{session_id:$s, repo_path:$r, workspace:$w, activity:$a, refs:[$ref]}')"

AUTH=()
[ -n "${CORTEX_API_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${CORTEX_API_TOKEN}")

# Everything network-shaped runs backgrounded — the hook returns immediately.
(
  if [ -n "${CORTEX_PRESENCE_URL:-}" ]; then
    BASES=("${CORTEX_PRESENCE_URL}")
  else
    SENTINEL="${TMPDIR:-/tmp}/cortex-presence-port-${SESSION}"
    CACHED="$(cat "$SENTINEL" 2>/dev/null)"
    if [ -n "$CACHED" ]; then
      BASES=("http://127.0.0.1:${CACHED}")
    else
      PORTS=("${CORTEX_VIEWER_PORT:-}" 3333 3334)
      BASES=()
      for P in "${PORTS[@]}"; do
        [ -n "$P" ] || continue
        if curl -sf --max-time 0.3 "http://127.0.0.1:${P}/api/health" >/dev/null 2>&1; then
          BASES=("http://127.0.0.1:${P}"); printf '%s' "$P" > "$SENTINEL" 2>/dev/null; break
        fi
      done
    fi
  fi
  for B in "${BASES[@]}"; do
    curl -sf --max-time 0.5 -X POST -H 'content-type: application/json' "${AUTH[@]}" \
      -d "$BODY" "${B}/api/presence" >/dev/null 2>&1 && break
    # A cached port that stopped answering: clear the sentinel for next time.
    [ -z "${CORTEX_PRESENCE_URL:-}" ] && rm -f "${TMPDIR:-/tmp}/cortex-presence-port-${SESSION}" 2>/dev/null
  done
) >/dev/null 2>&1 &

exit 0

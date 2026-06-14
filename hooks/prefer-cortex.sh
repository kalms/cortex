#!/usr/bin/env bash
# Hook: prefer-cortex (PreToolUse, matches Grep | Glob | Bash)
#
# Goal: ENFORCE the CLAUDE.md routing table at the decision point, not just
# advertise it at SessionStart. The session-start banner and CLAUDE.md are
# advisory and get skipped (the agent reflexively reaches for grep). This hook
# runs in the harness — not the model — so it can't be rationalized away.
#
# Policy (chosen 2026-06-11): "block code, allow non-code." On an INDEXED repo,
# deny a Grep/Glob/Bash-grep that targets *code* and redirect to the matching
# Cortex MCP tool; allow searches scoped to non-code files (configs/docs/JSON)
# and anything on an unindexed repo. The redirect text rides back to the model
# via permissionDecisionReason, so it sees the right tool and re-issues.
#
# Escape hatches (so a genuine code grep is never permanently wedged):
#   - scope the search to non-code files (a non-code glob / file arg), or
#   - add the token `cortex:grep-ok` to a Bash grep/rg command for a one-off
#     deliberate code grep (a regex feature search_code lacks, or Cortex has
#     already returned empty on a current index).
#
# Degrade-safe by construction: ANY failure, missing jq, empty payload, or
# unindexed repo → exit 0 with no output (allow). A hook bug must never block
# the user's tools.

set +e

# Need jq to parse the PreToolUse payload. Without it, do nothing (allow).
command -v jq >/dev/null 2>&1 || exit 0

PAYLOAD="$(cat)"
[ -n "$PAYLOAD" ] || exit 0

TOOL="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)"
CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
[ -n "$CWD" ] || CWD="$PWD"

# Only the search/discovery tools are in scope. MCP tools (mcp__cortex__*),
# Read, Edit, etc. fall straight through.
case "$TOOL" in
  Grep|Glob|Bash) ;;
  *) exit 0 ;;
esac

# --- Target resolution -------------------------------------------------------
# Resolve a path arg (absolute / ~ / relative-to-cwd; file or dir) to its git
# root, printed on stdout. Returns non-zero (prints nothing) when the path
# doesn't exist or isn't in a git repo.
# Prefers `git rev-parse --show-toplevel`; falls back to walking up the tree
# looking for a .git entry (handles bare/fake .git dirs created in tests and
# on-disk repos not yet initialized by git).
git_root_of() {
  local p="$1"
  case "$p" in
    /*) ;;
    "~"/*) p="$HOME/${p#\~/}" ;;
    *) p="$CWD/$p" ;;
  esac
  local dir="$p"
  [ -f "$dir" ] && dir="$(dirname "$dir")"
  # Walk up to the first existing ancestor (handles paths like /repo/src/new
  # where /src doesn't exist yet but /repo does).
  while [ -n "$dir" ] && [ "$dir" != "/" ] && ! [ -d "$dir" ]; do
    dir="${dir%/*}"
  done
  [ -d "$dir" ] || return 1
  # Try git first (works for real repos).
  local root
  root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$root" ]; then
    printf '%s' "$root"
    return 0
  fi
  # Fallback: walk up looking for a .git entry (covers fake/bare repos in tests).
  local d="$dir"
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -e "$d/.git" ]; then
      printf '%s' "$d"
      return 0
    fi
    d="${d%/*}"
  done
  return 1
}

# `-s`: exists AND non-empty, so a 0-byte degraded DB reads as not-indexed.
repo_indexed() { [ -s "$1/.cortex/db" ] || [ -s "$1/.cortex/graph.db" ]; }

# First path-like token in a Bash command: starts with / ./ ../ ~ or contains
# a slash; not a -flag; not an =assignment. Quoted literals already stripped by
# the caller. Prints the first match (empty if none).
first_path_token() {
  local tok
  for tok in $1; do
    case "$tok" in
      -*) continue ;;
      *=*) continue ;;
      /*|./*|../*|"~"/*) printf '%s' "$tok"; return 0 ;;
      */*) printf '%s' "$tok"; return 0 ;;
    esac
  done
  return 0
}

# Resolve the SEARCH TARGET (not necessarily the cwd) and its git root.
TARGET_PATH=""
case "$TOOL" in
  Grep|Glob)
    TARGET_PATH="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.path // empty' 2>/dev/null)"
    ;;
  Bash)
    _CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)"
    _CMD_STRIPPED="$(printf '%s' "$_CMD" | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g")"
    TARGET_PATH="$(first_path_token "$_CMD_STRIPPED")"
    ;;
esac

TARGET_ROOT=""
if [ -n "$TARGET_PATH" ]; then
  TARGET_ROOT="$(git_root_of "$TARGET_PATH")"
fi
# Bare pattern (no path arg) or unresolvable target → fall back to cwd's root.
if [ -z "$TARGET_ROOT" ]; then
  TARGET_ROOT="$(git_root_of "$CWD")"
fi

# Index gate, now anchored to the TARGET repo. Unindexed → Cortex can't answer
# (yet) → fall through and allow (a later task adds a background-index side
# effect here).
if [ -n "$TARGET_ROOT" ] && repo_indexed "$TARGET_ROOT"; then
  indexed=1
else
  indexed=0
fi
[ "$indexed" = "1" ] || exit 0

# Code vs non-code file signals. NONCODE = grep is the right tool; CODE =
# redirect. Anchored to a separator/end so "config" in a path doesn't match
# the "conf" alternative.
NONCODE_RE='\.(md|markdown|mdx|txt|rst|json|jsonc|ya?ml|toml|lock|ini|cfg|conf|env|xml|csv|tsv|html?|svg|log|sql|gitignore|gitattributes|editorconfig|properties)([^a-zA-Z0-9]|$)'
CODE_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cc|cpp|hpp|cxx|rb|php|swift|kt|kts|scala|vue|svelte|cs|mm|sh|bash|zsh)([^a-zA-Z0-9]|$)'
CODE_TYPE_RE='^(ts|tsx|typescript|js|jsx|javascript|py|python|go|rust|rs|java|c|cpp|cxx|ruby|rb|php|swift|kotlin|kt|scala|vue|svelte|cs|csharp)$'

GREP_MSG='This repo is indexed by Cortex. Use search_code(pattern="…") — the same ripgrep search, but each hit is annotated with its enclosing function/class. For a symbol by name use search_graph(name_pattern="…"); for callers/callees use trace_path. Grep is fine for NON-code files (configs/docs/JSON) — scope it to those (a non-code glob/path) and it passes. For a genuine code grep Cortex cannot do (a regex feature search_code lacks, or Cortex already returned empty on a current index), run it as a Bash grep/rg command containing the token cortex:grep-ok.'

GLOB_MSG='This repo is indexed by Cortex. To find code by name use search_graph(name_pattern="…"), or get_architecture for structure — not Glob over source files. Glob is fine for non-code files: scope the pattern to those (e.g. **/*.md, **/*.json) and it passes.'

emit_deny() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

case "$TOOL" in
  Grep)
    GLOB="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.glob // empty' 2>/dev/null)"
    GTYPE="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.type // empty' 2>/dev/null)"
    GPATH="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.path // empty' 2>/dev/null)"
    scoped_noncode=0
    scoped_code=0
    if [ -n "$GTYPE" ]; then
      if printf '%s' "$GTYPE" | grep -Eiq "$CODE_TYPE_RE"; then scoped_code=1; else scoped_noncode=1; fi
    fi
    if [ -n "$GLOB" ]; then
      printf '%s' "$GLOB" | grep -Eiq "$NONCODE_RE" && scoped_noncode=1
      printf '%s' "$GLOB" | grep -Eiq "$CODE_RE" && scoped_code=1
    fi
    if [ -n "$GPATH" ] && printf '%s' "$GPATH" | grep -Eiq "$NONCODE_RE"; then scoped_noncode=1; fi
    # Allow only when clearly scoped to non-code; unscoped or code → redirect.
    if [ "$scoped_noncode" = "1" ] && [ "$scoped_code" = "0" ]; then exit 0; fi
    emit_deny "$GREP_MSG"
    ;;
  Glob)
    GP="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.pattern // empty' 2>/dev/null)"
    # Redirect only code-targeted globs; arbitrary/non-code file discovery has
    # no graph equivalent, so allow it.
    if printf '%s' "$GP" | grep -Eiq "$CODE_RE"; then emit_deny "$GLOB_MSG"; fi
    exit 0
    ;;
  Bash)
    CMD="$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null)"
    [ -n "$CMD" ] || exit 0
    # Does the command run a search tool against FILES (vs. merely filtering a
    # pipe)? First delete pipe-fed search invocations (`… | grep …`): a grep
    # reading stdin is filtering output, not searching the tree, so it is not in
    # scope. Then look for any remaining search token at a command position —
    # start, or after whitespace/;/&/(// — which catches `grep`, `rg`,
    # `git grep`, `xargs grep`, `command grep`, `/usr/bin/grep`, env-prefixed
    # greps, and `find … -exec grep`. (Heuristic, not a shell parser: a code
    # extension inside the search PATTERN can still over-trigger a deny — use the
    # cortex:grep-ok escape for those.)
    # NB: BSD/macOS sed has no \b — bound the tool with whitespace/end instead.
    # First strip quoted string literals so a search word inside an argument
    # (e.g. `git commit -m "…grep…"`, `echo "rg …"`) is not mistaken for a
    # command-position search invocation; a real code grep has the tool word
    # UNQUOTED at a command position, so it survives the strip. (Scope detection
    # below still runs against the original $CMD, so a quoted non-code glob like
    # `--glob '*.md'` is preserved.) Then delete pipe-fed search invocations.
    STRIPPED="$(printf '%s' "$CMD" \
      | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g" \
      | sed -E 's/\|[[:space:]]*(grep|egrep|fgrep|rg|ag|ack)([[:space:]]|$)/ /g')"
    printf '%s' "$STRIPPED" \
      | grep -Eq '(^|[[:space:];&(/])(grep|egrep|fgrep|rg|ag|ack)([[:space:]]|$)' \
      || exit 0
    # Deliberate-code-grep escape.
    printf '%s' "$CMD" | grep -q 'cortex:grep-ok' && exit 0
    # Allow when clearly scoped to non-code and not to code.
    targets_code=0
    targets_noncode=0
    printf '%s' "$CMD" | grep -Eiq "$CODE_RE" && targets_code=1
    printf '%s' "$CMD" | grep -Eiq "$NONCODE_RE" && targets_noncode=1
    if [ "$targets_noncode" = "1" ] && [ "$targets_code" = "0" ]; then exit 0; fi
    emit_deny "$GREP_MSG"
    ;;
esac
exit 0

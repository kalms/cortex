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
#   - add the token `cortex:grep-ok` to a Bash grep/rg command. This does NOT
#     authorize the grep: it converts the denial into `ask`, so the USER
#     approves it. The token is written by the model, so auto-allowing it made
#     this gate advisory rather than enforcing (decision D-7ca7).
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
# CHECKOUT-SCOPED: no canonical fallback. Under per-worktree indexing an
# unindexed worktree IS an unindexed repo — falling back to canonical would
# block the search while Cortex simultaneously refuses to answer from another
# branch's graph, leaving no retrieval path at all. The degrade-safe rule
# (allow, kick a background index) applies here as everywhere else.
#
# This used to collapse a linked worktree (or subdir) onto the repo's MAIN
# worktree root via `canonical_root()` (git --git-common-dir), matching
# decision D-b248 ("one index per repo, shared across all worktrees") from
# when `cortex index` run from a worktree wrote the main checkout's
# `.cortex/db` and never the worktree's own. Per-worktree indexing
# (graph-storage.md#two-axes) made that stale: `cortex index` now indexes the
# literal checkout it's pointed at, so a worktree genuinely gets its own
# store, and reading through to canonical here would report a worktree as
# "indexed" purely because its main checkout happens to be — while the MCP
# read path (src/mcp-server/repo-context.ts) now strictly refuses to serve
# that canonical graph for an unindexed checkout. `canonical_root()` is
# deleted along with this fallback; nothing else used it.
repo_indexed() {
  [ -s "$1/.cortex/db" ] || [ -s "$1/.cortex/graph.db" ]
}

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

# Denylist: never auto-index junk/vendored/eval-clone trees. Shared with
# hooks/check-index.sh via hooks/lib/auto-index-denylist.sh — a single
# definition sourced by both hooks — so the SessionStart auto-index and this
# gate's sibling auto-index can't drift apart. See that file for the rationale
# and the degrade-safe (fail-closed) contract when it can't be loaded.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
AUTO_INDEX_DENYLIST_RE=""
if [ -n "$HOOK_DIR" ] && [ -r "$HOOK_DIR/lib/auto-index-denylist.sh" ]; then
  # shellcheck source=lib/auto-index-denylist.sh
  . "$HOOK_DIR/lib/auto-index-denylist.sh"
fi

# Best-effort detached index of an unindexed, high-certainty git root.
# Degrade-safe: any failure simply skips indexing — the grep is already allowed.
maybe_bg_index() {
  local root="$1"
  [ -n "$root" ] || return 0
  # Index the checkout it was given (root is already `--show-toplevel`, via
  # git_root_of), NOT the canonical (main-worktree) root. `cortex index` used
  # to collapse onto the main checkout regardless of what path you pointed it
  # at (D-b248), so this used to canonicalize first to avoid writing a
  # sentinel the index could never satisfy. Since the checkout-axis work
  # (v1.11.0, see graph-storage.md#two-axes), `cortex index` indexes the
  # literal checkout it's pointed at -- a linked worktree genuinely gets its
  # own `.cortex/db` -- so collapsing here would misfile the sentinel onto the
  # main checkout while the worktree (the thing actually being searched)
  # stays unindexed forever. `repo_indexed()` above is checkout-scoped too now
  # (the canonical read-through it used to fall back to is gone), so this and
  # the gate agree on what "indexed" means for a given checkout.
  [ "${CORTEX_AUTO_INDEX:-1}" = "0" ] && return 0
  printf '%s' "$root" | grep -Eq "$AUTO_INDEX_DENYLIST_RE" && return 0

  local bin="${CORTEX_BIN:-}"
  [ -n "$bin" ] || bin="$(command -v cortex 2>/dev/null)"
  [ -n "$bin" ] || return 0

  local sentinel="$root/.cortex/.auto-index-attempted"
  # Skip only when the sentinel is provably FRESH: `-mmin -60` prints the file
  # when it's younger than 60 min. Positive-match (vs. `-z` of `-mmin +60`) so a
  # broken/absent `find` fails toward re-attempting, never toward permanent
  # suppression. (Retry is bounded by the CLI's withIndexLock and self-ends once
  # the first index succeeds — the repo then reads as indexed.)
  if [ -f "$sentinel" ] && find "$sentinel" -mmin -60 2>/dev/null | grep -q .; then
    return 0   # fresh attempt (<60 min) — skip
  fi
  # Gate the spawn on the sentinel actually being written (matches
  # check-index.sh's SessionStart discipline): if `.cortex/` can't be created
  # or the sentinel can't be touched, don't spawn either. An unrecorded spawn
  # has no recorded attempt to back off against, so it would re-fire on every
  # subsequent grep instead of backing off for 60 minutes — measured at 3
  # spawns over 3 greps with no backoff before this fix.
  mkdir -p "$root/.cortex" 2>/dev/null || return 0
  : > "$sentinel" 2>/dev/null || return 0

  local log="$root/.cortex/auto-index.log"
  # Detached subshell so the index survives this hook's exit (recipe verified
  # on macOS in the Gate 0 detachment probe). CLI form: `cortex index . <path>`
  # — the `.` makes "index" the command and <path> the positional target
  # (src/cli/commands/index.ts line 50-51). `index <path>` WITHOUT the `.` makes
  # <path> the command and errors; `index repository --path=…` is NOT a real
  # subcommand (a stale hint in RepoNotIndexedError). Verified end-to-end against
  # a throwaway repo before shipping.
  ( nohup "$bin" index . "$root" >"$log" 2>&1 </dev/null & ) 2>/dev/null || true
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
    # Pass the stripped command as a SINGLE quoted arg: first_path_token splits
    # it internally via `for tok in $1`. Unquoting here would make $1 only the
    # first word (the tool name), so the path token is never seen.
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

# Index gate, now anchored to the TARGET repo. Unindexed → kick off a detached
# index for next time (if it's a real git root), then allow immediately.
if [ -n "$TARGET_ROOT" ] && repo_indexed "$TARGET_ROOT"; then
  indexed=1
else
  # Unindexed target. If it's a real git root (high-certainty), kick off a
  # detached index for next time. Either way, allow the grep now.
  if [ -n "$TARGET_ROOT" ]; then maybe_bg_index "$TARGET_ROOT"; fi
  exit 0
fi

# Code vs non-code file signals. NONCODE = grep is the right tool; CODE =
# redirect. Anchored to a separator/end so "config" in a path doesn't match
# the "conf" alternative.
NONCODE_RE='\.(md|markdown|mdx|txt|rst|json|jsonc|ya?ml|toml|lock|ini|cfg|conf|env|xml|csv|tsv|html?|svg|log|sql|gitignore|gitattributes|editorconfig|properties)([^a-zA-Z0-9]|$)'
CODE_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|h|cc|cpp|hpp|cxx|rb|php|swift|kt|kts|scala|vue|svelte|cs|mm|sh|bash|zsh)([^a-zA-Z0-9]|$)'
CODE_TYPE_RE='^(ts|tsx|typescript|js|jsx|javascript|py|python|go|rust|rs|java|c|cpp|cxx|ruby|rb|php|swift|kotlin|kt|scala|vue|svelte|cs|csharp)$'

GREP_MSG='This repo is indexed by Cortex. Use search_code(pattern="…") — the same ripgrep search, but each hit is annotated with its enclosing function/class. For a symbol by name use search_graph(name_pattern="…"); for callers/callees use trace_path; to read the code around a hit use get_code_snippet. Grep is fine for NON-code files (configs/docs/JSON) — scope it to those (a non-code glob/path) and it passes.'

GLOB_MSG='This repo is indexed by Cortex. To find code by name use search_graph(name_pattern="…"), or get_architecture for structure — not Glob over source files. Glob is fine for non-code files: scope the pattern to those (e.g. **/*.md, **/*.json) and it passes.'

emit_deny() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# `cortex:grep-ok` no longer AUTHORIZES -- it REQUESTS. The token is written by
# the model, so auto-allowing it made the gate advisory: an observed session had
# a denied `grep … version.ts` re-issued verbatim with the token seconds later,
# no Cortex call in between. Routing it to "ask" keeps the escape usable for a
# genuine need while making the human the only party who can grant it.
emit_ask() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
  exit 0
}

ASK_MSG='cortex:grep-ok present — this needs your approval, not the agent'"'"'s. search_code is the same ripgrep with graph annotation, and covers non-code files too; a raw grep is warranted only for something it genuinely cannot express.'

# Convert a would-be denial into a request. Called INSTEAD of emit_deny on the
# Bash path, never before rule evaluation -- checking the token first would make
# it fire on any command merely containing the string.
deny_or_ask() {
  if printf '%s' "$CMD" | grep -q 'cortex:grep-ok'; then emit_ask "$ASK_MSG"; fi
  emit_deny "$1"
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
    # Allow when clearly scoped to non-code and not to code.
    targets_code=0
    targets_noncode=0
    printf '%s' "$CMD" | grep -Eiq "$CODE_RE" && targets_code=1
    printf '%s' "$CMD" | grep -Eiq "$NONCODE_RE" && targets_noncode=1
    if [ "$targets_noncode" = "1" ] && [ "$targets_code" = "0" ]; then exit 0; fi
    deny_or_ask "$GREP_MSG"
    ;;
esac
exit 0

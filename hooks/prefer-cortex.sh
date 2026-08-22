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

# Collapse a linked worktree (or subdir) onto the repo's MAIN worktree root --
# the shell mirror of src/db/git-root.ts::mainWorktreeRoot. Decision D-b248
# ("one index per repo, shared across all worktrees") makes the canonical root
# the ONLY place a graph store lives: `cortex index` run from a worktree writes
# the main checkout's .cortex/db, never the worktree's. A gate that tests the
# literal directory therefore reads every worktree as unindexed and switches
# itself off -- in exactly the place the workflow rules mandate feature work.
# `--git-common-dir` is what collapses worktrees correctly (`--show-toplevel`
# returns the worktree checkout dir; D-b248 rejected it for that reason).
# Degrade-safe: any git failure (old git without --path-format, a fake .git
# dir, no repo) returns the input unchanged, preserving prior behavior.
canonical_root() {
  local common
  common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  case "$common" in
    */.git) printf '%s' "${common%/.git}"; return 0 ;;
  esac
  printf '%s' "$1"
}

# `-s`: exists AND non-empty, so a 0-byte degraded DB reads as not-indexed.
# Literal checkout FIRST, canonical root second. Today only the canonical root
# ever holds a store, so the first pair never hits -- but per-worktree indexing
# is explicitly left open by D-b248 ("future per-worktree diffing stays open"),
# and checking the literal path first means such a store would be honored the
# day it exists instead of being silently ignored by the gate.
repo_indexed() {
  [ -s "$1/.cortex/db" ] && return 0
  [ -s "$1/.cortex/graph.db" ] && return 0
  local c
  c="$(canonical_root "$1")"
  [ "$c" = "$1" ] && return 1
  [ -s "$c/.cortex/db" ] || [ -s "$c/.cortex/graph.db" ]
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

# Denylist: never auto-index junk/vendored/eval-clone trees. `.tmp` is cortex's
# eval-corpus clone convention (the real pollution source); the others are
# build/dependency dirs that aren't real project roots. Bare system `/tmp` is
# intentionally NOT denylisted — a git repo a user actively greps there is a
# legitimate index target (and `os.tmpdir()` is `/tmp` on Linux, so denylisting
# it would also wrongly exclude every Linux temp-dir repo).
AUTO_INDEX_DENYLIST_RE='(^|/)(\.tmp|node_modules|vendor|dist|build|\.cache)(/|$)'

# Best-effort detached index of an unindexed, high-certainty git root.
# Degrade-safe: any failure simply skips indexing — the grep is already allowed.
maybe_bg_index() {
  local root="$1"
  [ -n "$root" ] || return 0
  # Index the canonical root, never the worktree: `cortex index` collapses to
  # it anyway (D-b248), so targeting the literal worktree wrote a sentinel that
  # could never be satisfied -- the observed symptom was a worktree re-indexing
  # every 60 minutes forever while still reading as unindexed.
  root="$(canonical_root "$root")"
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
  mkdir -p "$root/.cortex" 2>/dev/null || return 0
  : > "$sentinel" 2>/dev/null || true

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
# TARGET_ROOT stays the LITERAL checkout; repo_indexed and maybe_bg_index each
# canonicalize as their own semantics require. A worktree therefore answers the
# same "is this repo indexed?" question the MCP read path answers -- verified: a
# Cortex read tool called with a worktree path resolves and returns results, so
# the redirect below always names a repo_path that actually works.

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

# `find -name '*.ts'` is a Glob spelled in Bash — same intent, same redirect.
FIND_RE='(^|[[:space:];&(/])find([[:space:]]|$)'
NAME_FLAG_RE='[[:space:]]-i?name([[:space:]]|$)'
# `find -name '*.ts' -delete` / `-exec prettier --write {} +` DO work, they do not
# find work. Redirecting them to search_graph would be nonsense -- it cannot
# delete or format anything.
FIND_ACTION_RE='([[:space:]]-(delete|exec|execdir|ok|okdir|print0)([[:space:]]|$)|\|[[:space:]]*xargs)'
# An interpreter that opens a source file and scans it is a grep with extra
# steps (observed shape: `python3 - <<PY … open('src/x.ts').read() … PY`).
# Quote char class built inline so both quote styles survive shell quoting.
_Q="[\"']"
INTERP_RE='(^|[[:space:];&(/])(python3?|node|deno|bun|ruby|perl)([[:space:]]|$)'
READ_RE="(^|[^a-zA-Z_])(open|readFileSync|readFile|read_text)[[:space:]]*\\("
# Writing a source file is codegen, not discovery — never redirect it.
WRITE_RE="(writeFileSync|writeFile|appendFile|write_text|write_bytes|\\.write\\(|open\\([^)]*,[[:space:]]*$_Q[wa])"

GREP_MSG='This repo is indexed by Cortex. Use search_code(pattern="…") — the same ripgrep, same regex syntax, your pattern passed through verbatim, but each hit annotated with its enclosing function/class. It searches code and non-code files alike (including dotfile dirs like .github/), and takes path="subdir", glob="*.md", files_only=true, multiline=true, max_count=N — so scoping no longer needs a raw grep. For a symbol by name use search_graph(name_pattern="…"); for callers/callees use trace_path; to read code around a hit use get_code_snippet. Grep remains fine for genuinely non-code targets — scope it to those and it passes.'

GLOB_MSG='This repo is indexed by Cortex. To find code by name use search_graph(name_pattern="…"), or get_architecture for structure — not Glob over source files. Glob is fine for non-code files: scope the pattern to those (e.g. **/*.md, **/*.json) and it passes.'

FIND_MSG='This repo is indexed by Cortex. `find -name` over source files is a Glob in disguise — use search_graph(name_pattern="…") to find code by name, get_architecture for structure, or search_code(pattern="…", files_only=true, glob="…") to list files by content. Non-code file discovery passes unchanged.'

INTERP_MSG='This repo is indexed by Cortex. Opening a source file in an interpreter to scan it is a grep with extra steps — use search_code(pattern="…", path="…") for text, get_code_snippet(qualified_name="…") to read a symbol (it returns the full definition, so no regex extraction is needed), or trace_path for callers/callees. Writing or generating a source file is unaffected.'

ASK_MSG='cortex:grep-ok present — this needs your approval, not the agent'"'"'s. Before approving, note that search_code IS ripgrep with the pattern passed through verbatim, covers non-code files too, and now takes path/glob/files_only/multiline/max_count. A raw grep is warranted only for something that genuinely cannot express: context lines (-A/-B/-C, better served by get_code_snippet), or a target outside this repo.'

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
# Convert a would-be denial into a request when the token is present. Called
# INSTEAD of emit_deny on the Bash path, never before rule evaluation: hoisting
# the token check to the top made it fire on any command merely containing the
# string (`git commit -m "...cortex:grep-ok..."`), and turned an outright allow
# for a non-code grep into a needless prompt.
deny_or_ask() {
  if printf '%s' "$CMD" | grep -q 'cortex:grep-ok'; then emit_ask "$ASK_MSG"; fi
  emit_deny "$1"
}

emit_ask() {
  jq -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:$r}}'
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

    # Scope signals, computed once against the ORIGINAL command: a quoted glob
    # (`--glob '*.md'`, `-name '*.ts'`) must survive the literal-strip below.
    targets_code=0
    targets_noncode=0
    printf '%s' "$CMD" | grep -Eiq "$CODE_RE" && targets_code=1
    printf '%s' "$CMD" | grep -Eiq "$NONCODE_RE" && targets_noncode=1

    # Does the command RUN a search tool against FILES (vs. merely filtering a
    # pipe)? First strip quoted string literals so a search word inside an
    # argument (`git commit -m "…grep…"`, `echo "rg …"`) is not mistaken for a
    # command-position invocation; a real code grep has the tool word UNQUOTED
    # at a command position, so it survives the strip. Then delete pipe-fed
    # search invocations (`… | grep …`): a grep reading stdin is filtering
    # output, not searching the tree, so it is out of scope.
    # NB: BSD/macOS sed has no \b — bound tokens with whitespace/end instead.
    STRIPPED="$(printf '%s' "$CMD" \
      | sed -E "s/'[^']*'//g; s/\"[^\"]*\"//g" \
      | sed -E 's/\|[[:space:]]*(grep|egrep|fgrep|rg|ag|ack)([[:space:]]|$)/ /g')"

    # (a) `find … -name '*.ts'` — code-targeted file discovery. Mirrors the Glob
    # policy: only CODE-scoped patterns redirect; arbitrary discovery passes.
    if [ "$targets_code" = "1" ] \
      && printf '%s' "$STRIPPED" | grep -Eq "$FIND_RE" \
      && printf '%s' "$CMD" | grep -Eq "$NAME_FLAG_RE" \
      && ! printf '%s' "$CMD" | grep -Eq "$FIND_ACTION_RE"; then
      deny_or_ask "$FIND_MSG"
    fi

    # (b) Interpreter reading a source file. Requires all three signals —
    # interpreter at a command position, a read-shaped call, a code extension —
    # and bails on any write signal, so codegen and file-writing scripts pass.
    # (Heuristic, not a parser: the cortex:grep-ok escape above covers misses.)
    if [ "$targets_code" = "1" ] \
      && printf '%s' "$STRIPPED" | grep -Eq "$INTERP_RE" \
      && printf '%s' "$CMD" | grep -Eq "$READ_RE" \
      && ! printf '%s' "$CMD" | grep -Eq "$WRITE_RE"; then
      deny_or_ask "$INTERP_MSG"
    fi

    # (c) grep/rg proper. Any remaining search token at a command position —
    # start, or after whitespace/;/&/(// — catches `grep`, `rg`, `git grep`,
    # `xargs grep`, `command grep`, `/usr/bin/grep`, env-prefixed greps, and
    # `find … -exec grep`. (Heuristic: a code extension inside the search
    # PATTERN can still over-trigger a deny — use cortex:grep-ok for those.)
    printf '%s' "$STRIPPED" \
      | grep -Eq '(^|[[:space:];&(/])(grep|egrep|fgrep|rg|ag|ack)([[:space:]]|$)' \
      || exit 0
    # Allow when clearly scoped to non-code and not to code.
    if [ "$targets_noncode" = "1" ] && [ "$targets_code" = "0" ]; then exit 0; fi
    deny_or_ask "$GREP_MSG"
    ;;
esac
exit 0

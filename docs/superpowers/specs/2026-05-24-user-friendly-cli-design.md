# User-Friendly Cortex CLI — Design Spec

**Status:** Draft. Brainstormed with user 2026-05-24; design approved before
writing.

## Goal

Build `cortex` — a single, polished command-line front door to the cortex
knowledge graph. Wraps the existing TypeScript MCP tool handlers and the
native `cortex-indexer` binary behind a namespaced verb-object surface
(`cortex code search`, `cortex decision why`, …). Replaces today's friction
of `bin/cortex-indexer cli get_code_snippet '{"qualified_name":"…","project":"…"}'`
with `cortex code show <input>`.

Three concrete UX wins drive the design:

1. **Smart input resolution** — passing `apps/foo.vue` (a raw file path)
   instead of the canonical slash-replaced project-prefixed qualified name
   currently returns "symbol not found". The new CLI auto-resolves.
2. **Discoverable surface** — `--help` at every level with examples and
   "see also" links; `cortex tour` for new users; `cortex help <topic>`
   for the concepts (qualified names, project resolution, etc.) that
   bite people.
3. **Clean output, opt-in narrative** — default output is terse and pipe-
   friendly. `--explain` per command and `cortex tour` provide on-demand
   teaching. No always-on chatter.

## Scope

**In scope:**

- New `bin/cortex` launcher + `src/cli/` package
- Namespaces: `code`, `decision`, `graph`, `index`, `eval`, plus meta
  (`tour`, `help`, `install`, `--version`)
- `cortex install` — adds/removes `cortex` from user PATH via
  `~/.local/bin` symlink or shell-rc alias
- Auto-resolve heuristic for `<input>` arguments
- Tour that adapts to whether cwd is indexed / a git repo / unrelated
- Three tiers of help: `--help`, `cortex tour`, `cortex help <topic>`
- Test coverage for CLI-specific concerns (argv, resolution, formatting,
  error rendering)

**Out of scope (deferred):**

- PR namespace (`open_pr`, `add_pr_touch`, `merge_pr`, `get_pr`). Useful
  to cortex internals but not a daily-driver user command. Stays
  accessible via `bin/cortex-indexer cli` until usage materializes.
- Interactive mode / wizard / TUI. Pure non-interactive command surface.
- Remote / multi-instance support. The CLI talks to whatever cortex
  serves `~/.local` or `cwd` — no MCP-over-network.
- Shell completion (zsh/bash/fish). Defer until the command grid
  stabilizes; cheap to add later.

## Non-goals

- Replacing `bin/cortex-indexer cli`. The indexer's `cli` subcommand
  stays as a power-user escape hatch. `cortex` wraps it; doesn't
  obsolete it.
- A wholly independent npm package. The CLI lives in the cortex repo
  and evolves in lockstep with the MCP tool handlers it imports.

## Directory layout

```
src/cli/
  main.ts                 # entry — argv parse + dispatch
  router.ts               # namespace + command registry
  context.ts              # project detection, env loading, store opens
  resolve-input.ts        # smart input → canonical qn resolver
  format.ts               # output formatters (table / json / plain)
  help.ts                 # --help renderer
  tour.ts                 # cortex tour (context-aware)
  install.ts              # cortex install / uninstall
  errors.ts               # error classification + renderers
  commands/
    code.ts               # cortex code [search|find|show|where|calls|arch|schema]
    decision.ts           # cortex decision [list|show|why|create|update|delete|link|promote|supersede|propose]
    graph.ts              # cortex graph [query|sql]
    eval.ts               # cortex eval [run|baseline|report]  — delegates to evals/src/cli.ts
    index.ts              # cortex index [run|status|changes|list|delete]
    help.ts               # cortex help <topic>
bin/
  cortex                  # launcher: dev → tsx src/cli/main.ts, built → node dist/cli/main.js
tests/cli/
  resolve-input.test.ts
  format.test.ts
  tour.test.ts
  errors.test.ts
  commands/
    code.test.ts
    decision.test.ts
    eval.test.ts
    index.test.ts
    graph.test.ts
  integration/
    happy-paths.test.ts   # one per namespace
    disambiguation.test.ts
    tour-states.test.ts
```

**Module responsibilities:**

- `router.ts` — owns the namespace → command map. Adding a new command
  is exactly two edits: implement handler in `commands/<ns>.ts`, register
  in `router.ts`. No framework, no decorators.
- `commands/*.ts` — direct imports from `src/mcp-server/tools/` for
  TS-implemented tools. Shells out to `bin/cortex-indexer cli` for the
  C-only ones (`index_repository`, `query_graph`, `search_code`).
- `resolve-input.ts` — pure function. Tested independently with a fixture
  graph.db (same pattern as the eval harness).
- `format.ts` — TTY detection + formatter selection. `--format=json` →
  machine-readable. `--format=plain` → no color, no table. Default →
  table if stdout is a TTY, plain otherwise.
- `errors.ts` — single `tryCommand(handler)` wrapper; four exit-code
  classes (see Error handling below).
- `install.ts` — only file that touches the filesystem outside the
  repo. Idempotent.

## Distribution & PATH

The launcher `bin/cortex` is shipped in-repo, same pattern as
`bin/cortex-indexer`. To make `cortex` runnable from any directory:

1. **`cortex install`** (subcommand of the new CLI itself). Logic:
   1. If `~/.local/bin` exists and is on `$PATH`: symlink
      `~/.local/bin/cortex` → `<repo>/bin/cortex`. Done.
   2. Else: detect `$SHELL`, append a one-line alias
      (`alias cortex="<repo>/bin/cortex"`) to `~/.zshrc` (or `~/.bashrc`,
      `~/.config/fish/config.fish`). Print "open a new terminal or
      source the rc file."
   3. Idempotent: if the symlink or alias is already present and points
      at this repo's `bin/cortex`, report "already installed" and exit 0.
   4. `cortex install --uninstall` reverses both branches.
   5. `--quiet` suppresses success messaging; errors still print to
      stderr.

2. **`scripts/build-indexer.sh`** (existing npm postinstall) is extended
   to call `bin/cortex install --quiet` after the indexer builds.
   Failure of the install step does NOT fail the install — just prints a
   one-line instruction telling the user to run `cortex install`
   manually.

3. **Claude Code plugin installs** (`claude plugin add github:kalms/cortex`)
   run the postinstall via npm, so the symlink lands automatically.

Net effect: after a fresh plugin install, typing `cortex` from any
directory works. Edge cases (no `~/.local/bin`, exotic shell, no write
permission) fall back to manual instructions, never to silent failure.

## Command grid

Five user-facing namespaces. Each command maps to one or more existing
MCP/indexer tools. Tools listed in the right column are the underlying
calls; `cortex` adds the auto-resolve, output formatting, and error
rendering.

### `cortex code`

| Command | Underlying tool(s) |
|---|---|
| `cortex code search <pattern>` | `search_code` |
| `cortex code find <name-pattern>` | `search_graph` |
| `cortex code show <input>` | resolve-input → `get_code_snippet` |
| `cortex code where <input>` | resolve-input → `trace_path mode=callers` |
| `cortex code calls <input>` | resolve-input → `trace_path mode=calls` |
| `cortex code arch [--aspects=...]` | `get_architecture` |
| `cortex code schema` | `get_graph_schema` |

### `cortex decision`

| Command | Underlying tool(s) |
|---|---|
| `cortex decision list [--query=...]` | `search_decisions` |
| `cortex decision show <id>` | `get_decision` |
| `cortex decision why <input>` | resolve-input → `why_was_this_built` |
| `cortex decision create` | `create_decision` (interactive flags if no body) |
| `cortex decision update <id>` | `update_decision` |
| `cortex decision delete <id>` | `delete_decision` |
| `cortex decision link <id> <target> [--relation=GOVERNS]` | `link_decision` |
| `cortex decision promote <id>` | `promote_decision` |
| `cortex decision supersede <old-id>` | `supersede_decision` |
| `cortex decision propose` | `propose_decision` |

### `cortex graph`

| Command | Underlying tool(s) |
|---|---|
| `cortex graph query '<cypher>'` | `query_graph` |
| `cortex graph sql '<sql>'` | direct `sqlite3` against the project's graph.db (the Cypher-bug escape hatch) |

### `cortex index`

| Command | Underlying tool(s) |
|---|---|
| `cortex index [path]` | `index_repository` |
| `cortex index status` | `index_status` |
| `cortex index changes` | `detect_changes` |
| `cortex index list` | `list_projects` |
| `cortex index delete <project>` | `delete_project` |

### `cortex eval`

| Command | Underlying |
|---|---|
| `cortex eval [run]` | delegates to `evals/src/cli.ts` (all targets) |
| `cortex eval run <target> [--path=...]` | one target |
| `cortex eval baseline <target>` | capture baseline |
| `cortex eval report [--latest\|--at=<ts>]` | print summary.md |

### Meta

| Command | Notes |
|---|---|
| `cortex tour` | context-aware 60-second walkthrough |
| `cortex help <topic>` | concept-level help (`qualified-names`, `projects`, `indexing`, `decisions`, `eval`) |
| `cortex install [--uninstall] [--quiet]` | PATH integration |
| `cortex --version` / `-v` | print version |
| `cortex --help` / `-h` | top-level help |

## Auto-resolve (`resolve-input.ts`)

Single exported function:

```ts
export function resolveInput(
  input: string,
  project: string,
  dbPath: string,
): ResolvedSymbol | Disambiguation;

type ResolvedSymbol = { qn: string; file_path: string; kind: string };
type Disambiguation = { candidates: ResolvedSymbol[]; input: string };
```

**Heuristic (first hit wins):**

1. **File path** — input contains `/` OR ends with a known source
   extension (`.vue`, `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.go`, `.rs`,
   `.java`, `.cs`, `.cpp`, `.c`, `.h`, `.rb`, `.php`, `.swift`,
   `.kt`).
   → `SELECT id, qualified_name, file_path, kind FROM nodes WHERE file_path = ? OR file_path LIKE '%' || ? LIMIT 5`.
2. **Canonical qn** — starts with the project prefix
   (`<project>.`) OR contains both `.` and `::`.
   → direct lookup by `qualified_name`.
3. **Dotted path** — contains `.` but no `/`. Try
   `qualified_name`-suffix match, then `LIKE '%<input>'` fallback.
4. **Bare name** — anything else. → `search_graph(name_pattern=<input>)`
   limit 5.

**Single match** → return the `ResolvedSymbol` directly; caller proceeds.

**Zero matches** → throw a domain error (exit code 3) with a tip block
matched to which heuristic branch fired:
- File path branch → "this path doesn't match any file in project X.
  Try: cortex code find <basename> (search by name)"
- Bare name → "no symbol matched. Try: cortex code find '<input>%'"

**Multiple matches** → throw a `Disambiguation`. The wrapper renders:

```
Multiple matches for '<input>'. Pick one:

  1. <name1>       <kind1>    <file_path1>
  2. <name2>       <kind2>    <file_path2>
  ...

Run: cortex code show '<full qn from the right>'
```

No stateful `<number>` shortcut. Users re-run with the chosen qn. CLIs
that pretend to remember state across invocations are a footgun.

**`--explain` flag** prints the resolved qn and the underlying tool call
before executing:

```
[resolve] input looks like a file path
[resolve] matched 1 module node by file_path
[resolve] qn: <project>.apps.activator.app.components.ADesignSystemCard
[call]    cortex-indexer cli get_code_snippet '{"qualified_name":"...","project":"..."}'
<the actual output>
```

This is the answer to "explainers at each step" — opt-in via `--explain`,
off by default. No always-on narrative noise.

## Help & tour

### `cortex --help` (top level)

Lists namespaces with one-line descriptions, common commands ("most
people start here"), and meta. Roughly 25 lines. Always exits 0.

### `cortex <ns> --help`

Lists commands in that namespace with one-liners.

### `cortex <ns> <cmd> --help`

Full command help: usage line, args, flags, 2-4 examples, "see also"
links to related commands. ~25-30 lines per command. This is the
primary discovery surface for power users.

### `cortex help <topic>`

Narrative explainers for the concepts that bite users in practice:

- `qualified-names` — what canonical qns look like, why
  `apps/foo.vue` fails, how to find the right form via
  `cortex code find`
- `projects` — how project names are derived (slash-replaced
  absolute path), how the CLI picks the project from cwd, how to
  override
- `indexing` — what gets indexed, how to refresh, where the DB
  lives, the cache vs `.cortex/` story
- `decisions` — when to `create` vs `propose`, `GOVERNS` vs
  `REFERENCES` vs `SUPERSEDES`, how `governs` resolves targets
- `eval` — what the harness measures, how to read a report,
  baseline vs surprise semantics

Each topic is a plain markdown string in `commands/help.ts`. Output
paginated through `$PAGER` if set, else printed directly.

### `cortex tour` — context-aware

Detects cwd state via `context.ts` and renders one of three flows:

| State | Detection | Tour starts at |
|---|---|---|
| **Indexed project** | `index_status` for cwd returns `ready` | Step 3 (show source). Picks a real symbol from `search_graph(name_pattern='%', kind='function', limit=1)` so the example is from the user's actual code. |
| **Unindexed git repo** | `.git/` exists, `index_status` returns `not found` | Step 2 (`cortex index .`) — natural starting point. |
| **No project** | neither of the above | Step 1, with hint: "`cortex index list` shows what's indexed; `cd` into one and re-run." |

The detection logic lives in `context.ts`. The SessionStart hook
(`hooks/check-index.sh`) re-implements similar logic in shell today;
those are intentionally independent because the hook can't import TS,
but the rules should stay aligned by hand.

The tour content for the "indexed" state is roughly:

1. "You're in `<project>` (5524 nodes, 6379 edges). Let's explore it."
2. Find a symbol: `cortex code find <real-fn-name-from-graph>`
3. Show its source: `cortex code show <its-qn>`
4. Who calls it: `cortex code where <its-qn>`
5. Why it was built: `cortex decision why <its-qn>`
6. Deep end: `cortex graph query '<example>'`
7. Next: `cortex help projects`, `cortex --help`.

No interactivity — just printed text. If `$PAGER` is set, output is piped
through it; otherwise printed plain.

## Output formats

`format.ts` chooses output based on `--format` flag and TTY detection:

| Flag | TTY | Output |
|---|---|---|
| `--format=json` | either | strict JSON, no color, machine-readable |
| `--format=plain` | either | newline-separated text, no color, pipe-safe |
| (default) | yes (TTY) | aligned columns + ANSI color where helpful |
| (default) | no (piped) | same as `--format=plain` |

Stdout carries the result. Stderr carries diagnostics, prompts, and
error messages. This means `cortex code search ribbon | jq` (with
`--format=json`) and `cortex code search ribbon | grep .vue` always
work.

## Error handling

Single wrapper in `errors.ts`:

```ts
export async function tryCommand(handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (e) {
    renderError(e);
    process.exit(exitCodeFor(e));
  }
}
```

Four error classes:

| Code | Class | When | Renderer output |
|---|---|---|---|
| 0 | success | normal | result + newline |
| 1 | unexpected | unhandled exception | `Error: <msg>\n  (run with --debug for stack)` |
| 2 | usage | bad argv, missing flag | `Usage: ...\n\nDid you mean: ...` (Levenshtein on the registry) |
| 3 | domain | symbol not found, no decision, etc. | `<one-line msg>\n\n<2-3 lines + a concrete next command>` |
| 4 | environment | indexer binary missing, DB locked, no project in cwd | `<msg>\n\nTo fix: <command>` |

All renderers write to **stderr**; stdout stays clean. Domain errors
get a tip block with a runnable next command, not a stack trace.

`--debug` flag (global): on error, also prints the stack trace plus
the underlying MCP tool call + args. Off by default.

## Testing strategy

| Layer | Coverage |
|---|---|
| Unit | `resolve-input.ts` (every heuristic branch + each return shape), `format.ts` (each format + TTY behavior), `help.ts` (renderers compile), `errors.ts` (each error class) |
| Handler | Each `commands/*.ts` handler called with mock context; exercises the wrapping but not the underlying MCP tool |
| Integration | One happy path per namespace via `bin/cortex` spawned as subprocess; the disambiguation flow; the three tour states |

**No live-MCP tests.** The CLI imports MCP tool handlers directly; the
existing `tests/mcp-contract/` suite covers handler correctness. The CLI
tests verify CLI-specific concerns (argv, resolution, formatting,
errors) — not the underlying tools.

Heavy emphasis on `resolve-input.ts` because it's the friction-killer.
Each heuristic branch gets at least one positive test (matches the
expected input shape) and one negative test (doesn't fire when input
shouldn't trigger it).

## Open questions

- **Color library**: roll a 20-line ANSI helper, or pull in `kleur`?
  Lean toward rolling it — keeps the dep footprint at zero for the
  CLI and the color usage is minimal (kind labels, ✓/✗ marks). Worth
  revisiting if color usage grows.
- **`cortex decision create` UX without flags** — interactive prompts
  (readline) or always-flag-driven? Lean toward flag-driven first;
  interactive can come later if usage shows it's needed.
- **Project name resolution** — when cwd is not inside any indexed
  project, do we (a) error, (b) ask the user with a numbered list of
  indexed projects, or (c) require `--project=<name>`? Lean (c) for
  v1; (b) is overengineering until requested.
- **PR namespace** — confirmed out of scope for v1. Re-evaluate after
  the rest of the CLI ships and PR tools see actual day-to-day use.

These are deferred to the implementation plan.

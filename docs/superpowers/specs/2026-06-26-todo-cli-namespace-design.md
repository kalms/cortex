# `cortex todo` CLI namespace — design

> Status: approved 2026-06-26. Adds a `todo` namespace to the `cortex` CLI
> at full parity with the MCP `todo` tool's seven actions, and fixes a latent
> bug where the existing `decision` CLI reads the stale legacy decisions store.

## Problem

The TODO primitive (storage + MCP `todo` tool + `GET /api/todos` HTTP contract)
shipped in 1.0.0, but it has **no CLI surface**. The `cortex` CLI exposes
`code`, `decision`, `graph`, `index`, and `eval` namespaces; of the three
authored primitives (`decision`, `pr`, `todo`), only `decision` has a CLI
command. So a todo created in an MCP session can only be inspected or mutated
from another MCP session — never from the shell, a hook, or a script.

While scoping this, a second defect surfaced: the existing `decision` CLI opens
the **legacy in-repo** store at `join(ctx.cwd, ".cortex", "decisions.db")`
([src/cli/commands/decision.ts](../../../src/cli/commands/decision.ts) `openService`),
but the MCP server resolves the **live durable** store at
`~/.cortex/<repoId>/decisions.db` via `resolveDecisionsDbPath`
([src/mcp-server/repo-context.ts](../../../src/mcp-server/repo-context.ts) line 270).
The two diverged when decisions were relocated out of the repo; the CLI was
never repointed. So `cortex decision list` today reads a stale (often empty)
store. A naive `todo` CLI that copied the decision command verbatim would
inherit the same bug and show none of the todos the MCP tool wrote.

## Goals

1. `cortex todo` with full parity to the MCP `todo` actions:
   `list`, `show`, `search`, `propose`, `update`, `transition`, `link`.
2. The CLI reads/writes the **same live store** as the MCP server.
3. The prose-heavy commands (`propose`/`update`) are usable **by a human at a
   prompt** — no shell-script wrapping required — via a git-commit-style
   `$EDITOR` flow, while flags remain the non-interactive escape hatch.
4. Repoint the `decision` CLI to the live store too (bundled fix).

Non-goals: external-tracker mirroring, live EventBus emission, a `count`
sub-probe (no hook needs it yet — add later if one does).

## Design

### New file — `src/cli/commands/todo.ts`

`runTodoCommand(cmd: TodoCommand, ctx: ProjectContext): Promise<void>`,
structured exactly like `decision.ts`.

**`openService(ctx)`** — the single divergence from the decision command's
shape. Resolves the live store rather than the legacy in-repo path:

```ts
if (ctx.state === "no-project") {
  throw new EnvironmentError(
    "todos require a git repository — cd into a repo first",
    "cortex tour    to see what's available without a project",
  );
}
const root = ctx.gitRoot ?? ctx.cwd;
const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
const svc = new TodoService({
  db,
  todos: new TodosRepository(db),
  links: new TodoLinksRepository(db),
});
return { db, svc };
```

`openDecisionsDb(path, legacySource?)` creates the `todos` / `todo_links` /
`todos_fts` schema idempotently and runs the one-shot legacy migration. The
decisions-from-graph and id-form migrations the MCP resolver runs are
decision-specific and not needed for todos.

**Subcommands** (dispatched by `switch (cmd.command)`):

| Command | Service call | Output |
|---|---|---|
| `list [--query=…] [--format=table\|json]` | `query ? svc.search(query) : svc.list()` | `writeRows` of `{id, summary, state}` via `chooseFormat(flags.format, isTTY)` |
| `show <id>` | `svc.getWithRefs(id)` | full JSON incl. links; `DomainError` if missing |
| `search <query>` | `svc.search(query)` | same table render as `list` |
| `propose [<summary>] [--description] [--proposed-by] [--governs=a,b] [--spawns-from] [--blocked-by=a,b]` | `svc.propose(...)` | JSON of created todo |
| `update <id> [--summary] [--description] [--assignee] [--governs=a,b]` | `svc.update(id, patch)` | JSON of updated todo |
| `transition <id> <state> [--reason] [--resolved-by=a,b] [--blocked-by=a,b]` | `svc.transition(id, ...)` | JSON of updated todo |
| `link <id> <target> [--relation=GOVERNS]` | `svc.link(...)` | `linked <id> -[REL]-> <target>` |

Unknown command → `UsageError` pointing at `cortex todo --help`.

#### Editor flow for the prose-heavy commands (`propose` / `update`)

`--description` (and a propose `summary`) are multi-line prose that is painful
to pass as flags — by hand you'd end up wrapping the call in a shell script. So
`propose` and `update` open `$EDITOR` (git-commit style) when the prose isn't
supplied inline, and accept flags as the non-interactive escape hatch (hooks,
scripts, and the tests rely on the flag path).

The editor handles **summary + description only**. The link fields
(`--governs`, `--spawns-from`, `--blocked-by`) stay as flags: they're short
ID/path lists, easy to type and script, and keeping them out of the template
sidesteps a parser ambiguity between the free-text description body and any
`key: value` line in it.

- **`propose`** — opens the editor when **no** summary is given inline (neither
  a positional `<summary>` nor `--summary`). Otherwise creates directly from
  flags, no editor. Template:

  ```
  <summary goes on the first line>

  <description — every non-comment line below the summary>

  # Lines starting with '#' are ignored.
  # First non-comment line is the summary; the rest is the description.
  # Save with an empty summary to abort.
  # Links: pass --governs=a,b  --spawns-from=D-x  --blocked-by=T-y on the CLI.
  ```

- **`update <id>`** — opens the editor pre-filled with the todo's **current**
  summary + description when no `--summary`/`--description`/`--assignee`/
  `--governs` flag is given. On save, only fields that actually changed are sent
  to `svc.update`. Any field flag present → apply directly, no editor.

- **Parsing** (`parseTodoTemplate(text)` → `{ summary, description }`): drop
  lines whose first non-space char is `#`; the first remaining non-blank line is
  the summary; everything after it, trimmed, is the description (empty → omit).
  An empty summary throws a `DomainError` ("aborted — empty summary"), matching
  git's abort-on-empty.

- **Non-interactive guard:** if the editor would open but `stdout`/`stdin` is
  not a TTY (CI, a pipe, a hook), throw a `UsageError` telling the caller to
  pass `<summary>` / `--summary` (and `--description`) instead. This keeps every
  non-interactive path deterministic and flag-driven.

`transition`'s only prose field is `--reason`, which is typically a short
one-liner, so it stays flag-based; `<state>` becomes a **positional** so the
common path is `cortex todo transition T-12 done`. (An editor for `--reason` can
be added later if it proves needed — deliberately out of scope here.)

**Helpers** (local to the command file unless noted):
- `requireFlag(name, flags)` — string-or-throw (matching decision.ts).
- `parseList(v)` — `typeof v === "string" ? v.split(",").map(s => s.trim()).filter(Boolean) : undefined`,
  for the comma-list flags (`--governs`, `--blocked-by`, `--resolved-by`).
- `parseTodoTemplate(text)` — the editor-buffer parser described above.
- `transition`'s `<state>` is validated by `TodoService.transition` itself
  (throws `Invalid transition: …`); the CLI surfaces that as a `DomainError`.
  A missing positional `<state>` → `UsageError`.
- `link`'s `--relation` defaults to `GOVERNS` (matches `decision link`); the
  service validates the enum.

Every command wraps its work in `try { … } finally { db.close(); }`.

### New file — `src/cli/editor.ts`

`openEditor(template: string): string` — the small, reusable editor helper:
writes `template` to a temp file under `os.tmpdir()`, resolves the editor as
`$VISUAL || $EDITOR || "vi"`, spawns it with `spawnSync(editor, [tmpfile], { stdio: "inherit" })`
so it attaches to the user's terminal, reads the file back on exit, deletes the
temp file (in a `finally`), and returns the contents. A non-zero editor exit
throws a `DomainError` ("editor exited non-zero — aborted"). Kept separate from
`todo.ts` so it's unit-testable on its own and reusable if `decision` adopts the
same flow later.

### Wiring

- **`src/cli/main.ts`** — add `"todo"` to the `NAMESPACES` array; import
  `runTodoCommand`; add `case "todo": return runTodoCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);`
  to the dispatch switch.
- **`src/cli/help.ts`** — add a `todo` block to the `NAMESPACES` doc map (one
  `CommandDoc` per subcommand), a `describeNamespace` entry
  (`todo: "Planned work — tasks and their lifecycle"`), and a `todo` line in
  `renderTopLevelHelp`'s Namespaces section.

### Bundled bug fix — `src/cli/commands/decision.ts`

Repoint `openService` from:

```ts
const dbPath = join(ctx.cwd, ".cortex", "decisions.db");
const db = openDecisionsDb(dbPath);
```

to:

```ts
const root = ctx.gitRoot ?? ctx.cwd;
const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
```

so the decision CLI reads the same live store as the MCP server. No other
decision-command behavior changes.

## Testing — `tests/cli/`

Mirror the existing `tests/cli/decision-count.test.ts` harness (spawn the CLI
entry with a temp `$CORTEX_DECISIONS_DB` so no real `cortex.json` / `~/.cortex`
is written).

1. **`todo` round-trip (flag path)** — `propose "summary" --governs=… --spawns-from=…`
   → `list` shows it → `show <id>` returns it with the links → `transition <id>
   in_progress` → `transition <id> done` → `search` finds it. Asserts state
   transitions and that links round-trip through `show`.
2. **invalid transition** — `transition <id> done` from `open` exits non-zero
   with a clear message (service rejects `open → done`).
3. **editor path** — set `$EDITOR` to a tiny script the test writes (e.g.
   `printf '...' > "$1"`) so `cortex todo propose` (no summary) reads
   summary+description from the "edited" buffer; assert the created todo matches.
   A second case points `$EDITOR` at a script that writes an **empty** summary
   and asserts the abort (non-zero, "empty summary"). Also a non-TTY case:
   bare `propose` with stdout piped → `UsageError` telling the caller to pass
   `--summary`.
4. **`parseTodoTemplate` unit test** — comment stripping, summary/description
   split, empty-summary detection. Pure function, no spawn.
5. **`openEditor` unit test** — with `$EDITOR` set to a fixture script, asserts
   the round-tripped buffer and that the temp file is cleaned up.
6. **decision path-fix regression** — write a decision row at
   `resolveDecisionsDbPath(tmpRepo)` (via the service against the override
   path) and assert `cortex decision list` now surfaces it — proving the CLI
   reads the live store.

## Process / merge

- Worktree `feature/cli/todo-namespace`; TDD.
- No UI surface → **Gate-0 visual QA skipped** (backend/CLI only).
- Gate-1 `/review` on the diff before completion.
- This is a code change → **patch version bump** across `package.json`,
  `plugin.json`, `.claude-plugin/marketplace.json` + a `CHANGELOG.md` entry,
  committed as `chore(release): <version>`.
- Release via **PR** to `main`; wait for the **"CI gate"** check to pass; stop
  for user hand-verify before merge.

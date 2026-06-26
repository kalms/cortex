# `cortex todo` CLI namespace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `todo` namespace to the `cortex` CLI at full parity with the MCP `todo` tool, with a git-commit-style `$EDITOR` flow for prose-heavy commands, and fix the `decision` CLI so it reads the live durable store.

**Architecture:** A new `src/cli/commands/todo.ts` mirrors `decision.ts` but resolves the **live** decisions store via `resolveDecisionsDbPath` (not the legacy in-repo path). A small reusable `src/cli/editor.ts` opens `$EDITOR` for `propose`/`update` when prose isn't passed inline; flags stay as the non-interactive escape hatch. The same one-line path fix is applied to `decision.ts`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `tsx` runner, `vitest`, `better-sqlite3`, existing `src/todos/` service layer.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` files (e.g. `import … from "./errors.js"`).
- Every command opens the DB and closes it in a `finally` block.
- The CLI must read/write the **same** store the MCP server uses: resolve via `resolveDecisionsDbPath(root)` with `legacyDecisionsDbPath(root)` as the one-shot migration source — never a hardcoded `join(cwd, ".cortex", "decisions.db")`.
- Error types: `UsageError` (bad invocation, exit 2), `DomainError` (valid request, domain failure, exit 3), `EnvironmentError` (no git repo, exit 4). All from `src/cli/errors.ts`.
- The editor handles **summary + description only**; link fields stay flags.
- Tests must not write to the real `~/.cortex` or a real `cortex.json`: always pin `$CORTEX_DECISIONS_DB` to a temp file for subprocess tests, or call `runTodoCommand` in-process against a no-git tmpdir (where `resolveDecisionsDbPath` falls back to `<dir>/.cortex/decisions.db`).

## Prerequisites (one-time worktree setup)

This worktree lacks the gitignored `node_modules` and `bin/cortex-indexer`. Before running any test:

```bash
cd /Users/rka/Development/cortex-wt-todo-cli
ln -s /Users/rka/Development/cortex/node_modules node_modules
mkdir -p bin && ln -s /Users/rka/Development/cortex/bin/cortex-indexer bin/cortex-indexer
node_modules/.bin/tsx --version   # sanity: prints a version
```

(The CLI tests only need `tsx` + `better-sqlite3`; the indexer symlink is for completeness.)

---

## Reference: existing APIs this plan consumes

From `src/todos/service.ts` — `TodoService` (constructed `new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) })`):
- `propose(input: { summary: string; description?: string; proposed_by?: string; governs?: string[]; spawns_from?: string; blocked_by?: string[] }): Todo`
- `get(idOrSeq: string): Todo | null`
- `getWithRefs(idOrSeq: string): TodoWithRefs | null`
- `update(idOrSeq: string, input: { summary?: string; description?: string; assignee?: string | null; governs?: string[] }): Todo`
- `transition(idOrSeq: string, input: { to: "open"|"in_progress"|"blocked"|"done"|"cancelled"; reason?: string; resolved_by?: string[]; blocked_by?: string[] }): Todo` — throws `Invalid transition: <from> → <to>` on illegal moves and `Todo not found: <ref>` on a bad id.
- `search(query: string): Todo[]`
- `list(): Todo[]`
- `link(input: { todo_id: string; target: string; relation: "GOVERNS"|"BLOCKED_BY"|"RELATED_TO"|"SPAWNS_FROM"|"RESOLVED_BY" }): void`

`Todo` has at least `{ id: string; seq: number; summary: string; description: string | null; state: string; … }`.

From `src/decisions/db.ts`: `openDecisionsDb(path: string, legacySource?: string): Database` — idempotent schema create (incl. `todos`/`todo_links`/`todos_fts`) + one-shot legacy migration.

From `src/db/resolve-path.ts`: `resolveDecisionsDbPath(startDir?: string): string`, `legacyDecisionsDbPath(startDir?: string): string`.

From `src/cli/format.ts`: `chooseFormat(flag: string | undefined, isTTY: boolean): Format`, `writeRows(rows: Row[], format: Format, emptyMessage: string): void`.

From `src/cli/context.ts`: `ProjectContext = { state: "indexed"|"unindexed-repo"|"no-project"; cwd: string; gitRoot: string | null; projectName: string | null; graphDbPath: string | null }`.

---

## Task 1: `openEditor` helper

**Files:**
- Create: `src/cli/editor.ts`
- Test: `tests/cli/editor.test.ts`

**Interfaces:**
- Produces: `openEditor(template: string): string` — writes `template` to a temp file, launches `$VISUAL || $EDITOR || "vi"` on it, returns the file contents after the editor exits; throws `DomainError` on launch failure or non-zero exit; always cleans up the temp file.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/editor.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openEditor } from "../../src/cli/editor.js";

/** Write a throwaway shell script that overwrites the edit file with `body`,
 *  set it as $EDITOR, and return a cleanup fn. */
function withFakeEditor(body: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cortex-fakeed-"));
  const script = join(dir, "ed.sh");
  // $1 is the path to the edit file passed by openEditor.
  writeFileSync(script, `#!/bin/sh\ncat > "$1" <<'CORTEX_EOF'\n${body}\nCORTEX_EOF\n`, "utf-8");
  chmodSync(script, 0o755);
  const prev = process.env.EDITOR;
  process.env.EDITOR = script;
  return { dir, cleanup: () => { if (prev === undefined) delete process.env.EDITOR; else process.env.EDITOR = prev; rmSync(dir, { recursive: true, force: true }); } };
}

describe("openEditor", () => {
  it("returns the buffer the editor wrote", () => {
    const { cleanup } = withFakeEditor("hello from editor");
    try {
      expect(openEditor("seed template").trim()).toBe("hello from editor");
    } finally { cleanup(); }
  });

  it("throws DomainError when the editor exits non-zero", () => {
    const dir = mkdtempSync(join(tmpdir(), "cortex-fakeed-"));
    const script = join(dir, "ed.sh");
    writeFileSync(script, `#!/bin/sh\nexit 1\n`, "utf-8");
    chmodSync(script, 0o755);
    const prev = process.env.EDITOR; process.env.EDITOR = script;
    try {
      expect(() => openEditor("x")).toThrow(/non-zero/);
    } finally {
      if (prev === undefined) delete process.env.EDITOR; else process.env.EDITOR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/cli/editor.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/editor.js` / `openEditor` is not a function.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cli/editor.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "./errors.js";

/**
 * Open the user's editor on a seed `template`, return the edited buffer.
 *
 * Resolves the editor as $VISUAL → $EDITOR → "vi". The editor string is run
 * through a shell so multi-word commands ("code -w", "emacs -nw") work; the
 * temp file path is appended as the final argument. The temp file is always
 * removed, even on throw.
 */
export function openEditor(template: string): string {
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  const dir = mkdtempSync(join(tmpdir(), "cortex-edit-"));
  const file = join(dir, "CORTEX_EDITMSG");
  try {
    writeFileSync(file, template, "utf-8");
    const res = spawnSync(`${editor} "${file}"`, { stdio: "inherit", shell: true });
    if (res.error) {
      throw new DomainError(
        `could not launch editor '${editor}': ${res.error.message}`,
        "Set $EDITOR to a valid editor command.",
      );
    }
    if (typeof res.status === "number" && res.status !== 0) {
      throw new DomainError("editor exited non-zero — aborted", undefined);
    }
    return readFileSync(file, "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run tests/cli/editor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/editor.ts tests/cli/editor.test.ts
git commit -m "feat(cli): add openEditor helper for editor-driven input"
```

---

## Task 2: `todo` read commands + namespace wiring

**Files:**
- Create: `src/cli/commands/todo.ts`
- Modify: `src/cli/main.ts` (add `todo` namespace + dispatch)
- Modify: `src/cli/help.ts` (doc map + `describeNamespace` + top-level list)
- Test: `tests/cli/commands/todo.test.ts` (in-process unit), `tests/cli/todo-read.test.ts` (subprocess)

**Interfaces:**
- Consumes: `openEditor` (Task 1, used in Task 4); `TodoService`; `resolveDecisionsDbPath`/`legacyDecisionsDbPath`; `writeRows`/`chooseFormat`.
- Produces:
  - `export type TodoCommand = { command: string; positionals: string[]; flags: Record<string, string | boolean> }`
  - `export async function runTodoCommand(cmd: TodoCommand, ctx: ProjectContext): Promise<void>`
  - `export function parseTodoTemplate(text: string): { summary: string; description: string | undefined }`

- [ ] **Step 1: Write the failing test (parseTodoTemplate + read commands, in-process)**

```ts
// tests/cli/commands/todo.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTodoCommand, parseTodoTemplate } from "../../../src/cli/commands/todo.js";
import type { ProjectContext } from "../../../src/cli/context.js";

function ctxFor(dir: string): ProjectContext {
  // No real .git → resolveDecisionsDbPath falls back to <dir>/.cortex/decisions.db,
  // keeping the store inside the tmpdir (cleaned up afterEach).
  return { state: "indexed", cwd: dir, gitRoot: null, projectName: "test", graphDbPath: null };
}

describe("parseTodoTemplate", () => {
  it("splits summary from description and strips comment lines", () => {
    const r = parseTodoTemplate("My summary\n\nLine one\nLine two\n# a comment\n");
    expect(r.summary).toBe("My summary");
    expect(r.description).toBe("Line one\nLine two");
  });
  it("treats a comments-only / blank buffer as empty summary", () => {
    expect(parseTodoTemplate("# only comments\n\n").summary).toBe("");
    expect(parseTodoTemplate("Just a title\n").description).toBeUndefined();
  });
});

describe("cortex todo read commands", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-todo-cmd-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("list with no todos does not throw", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runTodoCommand({ command: "list", positionals: [], flags: {} }, ctxFor(dir));
    spy.mockRestore(); errSpy.mockRestore();
  });

  it("propose then show round-trips via the service", async () => {
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runTodoCommand({ command: "propose", positionals: ["Test todo"], flags: {} }, ctxFor(dir));
    const created = JSON.parse(spy.mock.calls.map((c) => String(c[0])).join(""));
    spy.mockRestore();

    const spy2 = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runTodoCommand({ command: "show", positionals: [created.id], flags: {} }, ctxFor(dir));
    const shown = JSON.parse(spy2.mock.calls.map((c) => String(c[0])).join(""));
    spy2.mockRestore();
    expect(shown.summary).toBe("Test todo");
    expect(shown.state).toBe("open");
  });

  it("show of an unknown id throws DomainError", async () => {
    await expect(runTodoCommand({ command: "show", positionals: ["T-nope"], flags: {} }, ctxFor(dir)))
      .rejects.toThrow(/no todo/i);
  });

  it("unknown sub-command throws UsageError", async () => {
    await expect(runTodoCommand({ command: "frob", positionals: [], flags: {} }, ctxFor(dir)))
      .rejects.toThrow(/unknown command/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/cli/commands/todo.test.ts`
Expected: FAIL — cannot resolve `todo.js` / `runTodoCommand` undefined.

- [ ] **Step 3: Write minimal implementation (read commands + helpers; write commands stubbed in Task 3/4)**

```ts
// src/cli/commands/todo.ts
import { openDecisionsDb } from "../../decisions/db.js";
import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../db/resolve-path.js";
import { TodoService } from "../../todos/service.js";
import { TodosRepository } from "../../todos/repository.js";
import { TodoLinksRepository } from "../../todos/links-repository.js";
import type { ProjectContext } from "../context.js";
import { UsageError, DomainError, EnvironmentError } from "../errors.js";
import { writeRows, chooseFormat } from "../format.js";
import { openEditor } from "../editor.js";

export type TodoCommand = {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
};

function openService(ctx: ProjectContext) {
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
}

function requireFlag(name: string, flags: Record<string, unknown>, usage: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) throw new UsageError(`missing --${name}`, usage);
  return v;
}

function parseList(v: unknown): string[] | undefined {
  return typeof v === "string"
    ? v.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
}

/** Parse an editor buffer into summary + description. Comment lines (first
 *  non-space char '#') are dropped; the first remaining non-blank line is the
 *  summary; everything after it (trimmed) is the description. */
export function parseTodoTemplate(text: string): { summary: string; description: string | undefined } {
  const lines = text.split("\n").filter((l) => !l.trimStart().startsWith("#"));
  while (lines.length && lines[0].trim() === "") lines.shift();
  const summary = (lines.shift() ?? "").trim();
  const description = lines.join("\n").trim();
  return { summary, description: description.length ? description : undefined };
}

export async function runTodoCommand(cmd: TodoCommand, ctx: ProjectContext): Promise<void> {
  switch (cmd.command) {
    case "list":       return cmdList(cmd, ctx);
    case "show":       return cmdShow(cmd, ctx);
    case "search":     return cmdSearch(cmd, ctx);
    case "propose":    return cmdPropose(cmd, ctx);
    case "update":     return cmdUpdate(cmd, ctx);
    case "transition": return cmdTransition(cmd, ctx);
    case "link":       return cmdLink(cmd, ctx);
    default:
      throw new UsageError(`unknown command 'cortex todo ${cmd.command}'`, "Run: cortex todo --help");
  }
}

function cmdList(cmd: TodoCommand, ctx: ProjectContext): void {
  const { db, svc } = openService(ctx);
  try {
    const query = typeof cmd.flags.query === "string" ? cmd.flags.query : "";
    const results = query ? svc.search(query) : svc.list();
    const rows = results.map((t) => ({ id: t.id, summary: t.summary, state: t.state }));
    const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY ?? false);
    writeRows(rows, fmt, query ? `no todos matched '${query}'` : "no todos yet — try `cortex todo propose`");
  } finally { db.close(); }
}

function cmdShow(cmd: TodoCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex todo show <id>");
  const { db, svc } = openService(ctx);
  try {
    const t = svc.getWithRefs(id);
    if (!t) throw new DomainError(`no todo with id '${id}'`, "Try: cortex todo list");
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdSearch(cmd: TodoCommand, ctx: ProjectContext): void {
  const query = cmd.positionals[0];
  if (!query) throw new UsageError("missing <query>", "Usage: cortex todo search <query>");
  const { db, svc } = openService(ctx);
  try {
    const rows = svc.search(query).map((t) => ({ id: t.id, summary: t.summary, state: t.state }));
    const fmt = chooseFormat(cmd.flags.format as string | undefined, process.stdout.isTTY ?? false);
    writeRows(rows, fmt, `no todos matched '${query}'`);
  } finally { db.close(); }
}

// --- write commands: minimal flag-only forms; editor flow added in Task 4 ---

function cmdPropose(cmd: TodoCommand, ctx: ProjectContext): void {
  const summary = cmd.positionals[0] ?? (typeof cmd.flags.summary === "string" ? cmd.flags.summary : undefined);
  if (!summary) throw new UsageError("missing <summary>", "Usage: cortex todo propose <summary> [--description=...]");
  const { db, svc } = openService(ctx);
  try {
    const t = svc.propose({
      summary,
      description: typeof cmd.flags.description === "string" ? cmd.flags.description : undefined,
      proposed_by: typeof cmd.flags["proposed-by"] === "string" ? cmd.flags["proposed-by"] : undefined,
      governs: parseList(cmd.flags.governs),
      spawns_from: typeof cmd.flags["spawns-from"] === "string" ? cmd.flags["spawns-from"] : undefined,
      blocked_by: parseList(cmd.flags["blocked-by"]),
    });
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdUpdate(cmd: TodoCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex todo update <id> [--summary=...] [--description=...]");
  const { db, svc } = openService(ctx);
  try {
    const patch: { summary?: string; description?: string; assignee?: string | null; governs?: string[] } = {};
    if (typeof cmd.flags.summary === "string") patch.summary = cmd.flags.summary;
    if (typeof cmd.flags.description === "string") patch.description = cmd.flags.description;
    if (typeof cmd.flags.assignee === "string") patch.assignee = cmd.flags.assignee;
    const governs = parseList(cmd.flags.governs);
    if (governs) patch.governs = governs;
    const t = svc.update(id, patch);
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } finally { db.close(); }
}

function cmdTransition(cmd: TodoCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  const to = cmd.positionals[1];
  if (!id || !to) throw new UsageError("missing args", "Usage: cortex todo transition <id> <state> [--reason=...]");
  const { db, svc } = openService(ctx);
  try {
    const t = svc.transition(id, {
      to: to as "open" | "in_progress" | "blocked" | "done" | "cancelled",
      reason: typeof cmd.flags.reason === "string" ? cmd.flags.reason : undefined,
      resolved_by: parseList(cmd.flags["resolved-by"]),
      blocked_by: parseList(cmd.flags["blocked-by"]),
    });
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Invalid transition|not found/i.test(msg)) throw new DomainError(msg, "Try: cortex todo show " + id);
    throw e;
  } finally { db.close(); }
}

function cmdLink(cmd: TodoCommand, ctx: ProjectContext): void {
  const [id, target] = cmd.positionals;
  if (!id || !target) throw new UsageError("missing args", "Usage: cortex todo link <id> <target> [--relation=GOVERNS]");
  const relation = (typeof cmd.flags.relation === "string" ? cmd.flags.relation : "GOVERNS") as
    "GOVERNS" | "BLOCKED_BY" | "RELATED_TO" | "SPAWNS_FROM" | "RESOLVED_BY";
  const { db, svc } = openService(ctx);
  try {
    svc.link({ todo_id: id, target, relation });
    process.stdout.write(`linked ${id} -[${relation}]-> ${target}\n`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found/i.test(msg)) throw new DomainError(msg, "Try: cortex todo list");
    throw e;
  } finally { db.close(); }
}

// Re-export so Task 4 can wire the editor without touching the dispatch.
export { openEditor };
```

> Note: `cmdPropose`/`cmdUpdate` here are the flag-only forms. Task 4 adds the `$EDITOR` branch when prose is absent. The `import { openEditor }` + re-export is present now so Task 4 is a localized edit. (If your linter flags the unused import before Task 4, leave it — Task 4 lands immediately after.)

- [ ] **Step 4: Wire the namespace into `main.ts`**

In `src/cli/main.ts`:
1. Add the import near the other command imports (after line 11, `runEvalCommand`):
```ts
import { runTodoCommand } from "./commands/todo.js";
```
2. Add `"todo"` to the `NAMESPACES` array (line 21):
```ts
const NAMESPACES = ["code", "decision", "graph", "index", "eval", "todo"];
```
3. Add a dispatch case in the `switch (argv.namespace)` block (after the `eval` case, ~line 136):
```ts
    case "todo":
      return runTodoCommand({ command: argv.command ?? "", positionals: argv.positionals, flags: argv.flags }, ctx);
```

- [ ] **Step 5: Wire help into `help.ts`**

In `src/cli/help.ts`:
1. Add a `todo` block to the `NAMESPACES` doc map (after the `eval` block, before the closing `}` of the map):
```ts
  todo: {
    list:       { usage: "cortex todo list [--query=…]",                              description: "List or search todos.", examples: ["cortex todo list", "cortex todo list --query='viewer'"] },
    show:       { usage: "cortex todo show <id>",                                     description: "Show a todo (with links) by id.", examples: ["cortex todo show T-12"] },
    search:     { usage: "cortex todo search <query>",                                description: "Full-text search todos.", examples: ["cortex todo search drawer"] },
    propose:    { usage: "cortex todo propose [<summary>] [--description=…] [--governs=a,b] [--spawns-from=…] [--blocked-by=a,b]", description: "Create a todo. With no summary, opens $EDITOR for summary + description.", examples: ["cortex todo propose", "cortex todo propose 'Fix drawer' --governs=src/x.ts"] },
    update:     { usage: "cortex todo update <id> [--summary=…] [--description=…] [--assignee=…] [--governs=a,b]", description: "Update a todo. With no field flags, opens $EDITOR pre-filled.", examples: ["cortex todo update T-12 --assignee=rka"] },
    transition: { usage: "cortex todo transition <id> <state> [--reason=…] [--resolved-by=a,b] [--blocked-by=a,b]", description: "Move a todo between states (open|in_progress|blocked|done|cancelled).", examples: ["cortex todo transition T-12 in_progress", "cortex todo transition T-12 done --resolved-by=#42"] },
    link:       { usage: "cortex todo link <id> <target> [--relation=GOVERNS]",       description: "Link a todo to a file, symbol, decision, PR, or another todo.", examples: ["cortex todo link T-12 src/x.ts", "cortex todo link T-12 D-0j21 --relation=SPAWNS_FROM"] },
  },
```
2. Add a `describeNamespace` entry (in the object returned by `describeNamespace`):
```ts
    todo: "Planned work — tasks and their lifecycle",
```
3. In `renderTopLevelHelp`, add a namespace line after the `eval` line (~line 116):
```ts
    `  ${name("todo".padEnd(10))}  Planned work — tasks and their lifecycle`,
```

- [ ] **Step 6: Write the subprocess read test**

```ts
// tests/cli/todo-read.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../src/decisions/db.js";
import { TodosRepository } from "../../src/todos/repository.js";
import { TodoLinksRepository } from "../../src/todos/links-repository.js";
import { TodoService } from "../../src/todos/service.js";

const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

function run(args: string[], cwd: string, dbPath: string): string {
  return execFileSync(TSX, [CLI, "todo", ...args], {
    cwd, encoding: "utf-8", env: { ...process.env, CORTEX_DECISIONS_DB: dbPath },
  });
}

describe("cortex todo list/show (subprocess, live store)", () => {
  it("lists a todo seeded into the resolved store", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-todo-read-"));
    const dbPath = join(root, "todos.db");
    try {
      const db = openDecisionsDb(dbPath);
      const svc = new TodoService({ db, todos: new TodosRepository(db), links: new TodoLinksRepository(db) });
      const t = svc.propose({ summary: "Seeded task" });
      db.close();
      const out = run(["list", "--format=plain"], root, dbPath);
      expect(out).toContain(t.id);
      expect(out).toContain("Seeded task");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 7: Run all Task-2 tests**

Run: `node_modules/.bin/vitest run tests/cli/commands/todo.test.ts tests/cli/todo-read.test.ts tests/cli/help.test.ts`
Expected: PASS. (Include `help.test.ts` to confirm the help wiring didn't break the existing help snapshot/assertions; if `help.test.ts` asserts an exact namespace count or list, update it to include `todo`.)

- [ ] **Step 8: Manual smoke check**

Run: `node_modules/.bin/tsx src/cli/main.ts todo --help`
Expected: prints the `todo` command list including `list`, `show`, `propose`, `transition`, `link`.

- [ ] **Step 9: Commit**

```bash
git add src/cli/commands/todo.ts src/cli/main.ts src/cli/help.ts tests/cli/commands/todo.test.ts tests/cli/todo-read.test.ts tests/cli/help.test.ts
git commit -m "feat(cli): add todo namespace (read commands + flag writes + wiring)"
```

---

## Task 3: Flag-path write round-trip + invalid-transition tests

> The write command bodies already landed in Task 2 (flag-only forms). This task adds the behavioral tests that lock them in, exercised through the real CLI subprocess.

**Files:**
- Test: `tests/cli/todo-write.test.ts`

**Interfaces:**
- Consumes: the `todo` subprocess CLI from Task 2; `CORTEX_DECISIONS_DB` override.

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/todo-write.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

function run(args: string[], cwd: string, dbPath: string): string {
  return execFileSync(TSX, [CLI, "todo", ...args], {
    cwd, encoding: "utf-8", env: { ...process.env, CORTEX_DECISIONS_DB: dbPath },
  });
}
function runFail(args: string[], cwd: string, dbPath: string): { status: number; stderr: string } {
  try {
    execFileSync(TSX, [CLI, "todo", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CORTEX_DECISIONS_DB: dbPath } });
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: Buffer | string };
    return { status: err.status ?? 1, stderr: typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() ?? "" };
  }
}

describe("cortex todo write round-trip (flag path)", () => {
  it("propose → show (links) → transition → done", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-todo-w-"));
    const dbPath = join(root, "todos.db");
    try {
      const created = JSON.parse(run(["propose", "Wire it up", "--governs=src/a.ts", "--spawns-from=D-0j21"], root, dbPath));
      expect(created.summary).toBe("Wire it up");
      expect(created.state).toBe("open");

      const shown = JSON.parse(run(["show", created.id], root, dbPath));
      expect(shown.governs.map((g: { target_ref: string }) => g.target_ref)).toContain("src/a.ts");
      expect(shown.spawns_from.target_ref).toBe("D-0j21");

      JSON.parse(run(["transition", created.id, "in_progress"], root, dbPath));
      const done = JSON.parse(run(["transition", created.id, "done"], root, dbPath));
      expect(done.state).toBe("done");

      const search = run(["search", "Wire", "--format=plain"], root, dbPath);
      expect(search).toContain(created.id);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects an illegal transition (open → done) with a non-zero exit", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-todo-w-"));
    const dbPath = join(root, "todos.db");
    try {
      const created = JSON.parse(run(["propose", "Skip a step"], root, dbPath));
      const { status, stderr } = runFail(["transition", created.id, "done"], root, dbPath);
      expect(status).toBe(3); // DomainError
      expect(stderr).toMatch(/Invalid transition/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run test to verify it passes (commands already implemented in Task 2)**

Run: `node_modules/.bin/vitest run tests/cli/todo-write.test.ts`
Expected: PASS. If `propose`/`transition` behavior is wrong, fix `src/cli/commands/todo.ts` until green (this is the gate that proves the flag path).

- [ ] **Step 3: Commit**

```bash
git add tests/cli/todo-write.test.ts
git commit -m "test(cli): todo write round-trip + invalid-transition coverage"
```

---

## Task 4: `$EDITOR` flow for `propose` / `update`

**Files:**
- Modify: `src/cli/commands/todo.ts` (`cmdPropose`, `cmdUpdate`, add `ensureInteractive`)
- Test: extend `tests/cli/commands/todo.test.ts`

**Interfaces:**
- Consumes: `openEditor` (Task 1), `parseTodoTemplate` (Task 2).
- Produces: editor branch in `cmdPropose`/`cmdUpdate`; `ensureInteractive()` guard.

- [ ] **Step 1: Write the failing tests (append to `tests/cli/commands/todo.test.ts`)**

```ts
// add to tests/cli/commands/todo.test.ts
import * as editor from "../../../src/cli/editor.js";

describe("cortex todo propose/update — editor flow", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cortex-todo-ed-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  function ctx(): ProjectContext {
    return { state: "indexed", cwd: dir, gitRoot: null, projectName: "test", graphDbPath: null };
  }

  it("propose with no summary reads summary+description from the editor", async () => {
    const prevTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(editor, "openEditor").mockReturnValue("Editor summary\n\nEditor body\n# ignored");
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runTodoCommand({ command: "propose", positionals: [], flags: {} }, ctx());
      const created = JSON.parse(spy.mock.calls.map((c) => String(c[0])).join(""));
      expect(created.summary).toBe("Editor summary");
      expect(created.description).toBe("Editor body");
    } finally {
      spy.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });

  it("propose aborts when the editor returns an empty summary", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(editor, "openEditor").mockReturnValue("# only comments\n\n");
    await expect(runTodoCommand({ command: "propose", positionals: [], flags: {} }, ctx()))
      .rejects.toThrow(/empty summary/i);
  });

  it("propose without a summary in a non-TTY context throws UsageError", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await expect(runTodoCommand({ command: "propose", positionals: [], flags: {} }, ctx()))
      .rejects.toThrow(/summary/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run tests/cli/commands/todo.test.ts`
Expected: FAIL — `propose` with no summary currently throws `missing <summary>` (UsageError) instead of consulting the editor; the empty-summary and non-TTY assertions don't match yet.

- [ ] **Step 3: Implement the editor branch**

In `src/cli/commands/todo.ts`, add the guard helper near the other helpers:

```ts
function ensureInteractive(what: string): void {
  if (!process.stdin.isTTY) {
    throw new UsageError(
      `${what} needs a summary in a non-interactive context`,
      `Pass it inline, e.g. cortex todo ${what} "<summary>" --description=...`,
    );
  }
}
```

Replace `cmdPropose` with the editor-aware version:

```ts
function cmdPropose(cmd: TodoCommand, ctx: ProjectContext): void {
  let summary = cmd.positionals[0] ?? (typeof cmd.flags.summary === "string" ? cmd.flags.summary : undefined);
  let description = typeof cmd.flags.description === "string" ? cmd.flags.description : undefined;

  if (!summary) {
    ensureInteractive("propose");
    const template =
      "\n\n" +
      "# Lines starting with '#' are ignored.\n" +
      "# First non-comment line is the summary; the rest is the description.\n" +
      "# Save with an empty summary to abort.\n" +
      "# Links: pass --governs=a,b --spawns-from=D-x --blocked-by=T-y on the CLI.\n";
    const parsed = parseTodoTemplate(openEditor(template));
    if (!parsed.summary) throw new DomainError("aborted — empty summary", undefined);
    summary = parsed.summary;
    description = description ?? parsed.description;
  }

  const { db, svc } = openService(ctx);
  try {
    const t = svc.propose({
      summary,
      description,
      proposed_by: typeof cmd.flags["proposed-by"] === "string" ? cmd.flags["proposed-by"] : undefined,
      governs: parseList(cmd.flags.governs),
      spawns_from: typeof cmd.flags["spawns-from"] === "string" ? cmd.flags["spawns-from"] : undefined,
      blocked_by: parseList(cmd.flags["blocked-by"]),
    });
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } finally { db.close(); }
}
```

Replace `cmdUpdate` with the editor-aware version (opens the editor pre-filled when no field flag is given):

```ts
function cmdUpdate(cmd: TodoCommand, ctx: ProjectContext): void {
  const id = cmd.positionals[0];
  if (!id) throw new UsageError("missing <id>", "Usage: cortex todo update <id> [--summary=...] [--description=...]");

  const hasFieldFlag =
    typeof cmd.flags.summary === "string" ||
    typeof cmd.flags.description === "string" ||
    typeof cmd.flags.assignee === "string" ||
    typeof cmd.flags.governs === "string";

  const { db, svc } = openService(ctx);
  try {
    const patch: { summary?: string; description?: string; assignee?: string | null; governs?: string[] } = {};

    if (!hasFieldFlag) {
      ensureInteractive("update");
      const current = svc.get(id);
      if (!current) throw new DomainError(`no todo with id '${id}'`, "Try: cortex todo list");
      const seed =
        `${current.summary}\n\n${current.description ?? ""}\n` +
        "# Lines starting with '#' are ignored.\n" +
        "# First non-comment line is the summary; the rest is the description.\n" +
        "# Save with an empty summary to abort.\n";
      const parsed = parseTodoTemplate(openEditor(seed));
      if (!parsed.summary) throw new DomainError("aborted — empty summary", undefined);
      if (parsed.summary !== current.summary) patch.summary = parsed.summary;
      if ((parsed.description ?? null) !== (current.description ?? null)) patch.description = parsed.description ?? "";
    } else {
      if (typeof cmd.flags.summary === "string") patch.summary = cmd.flags.summary;
      if (typeof cmd.flags.description === "string") patch.description = cmd.flags.description;
      if (typeof cmd.flags.assignee === "string") patch.assignee = cmd.flags.assignee;
      const governs = parseList(cmd.flags.governs);
      if (governs) patch.governs = governs;
    }

    const t = svc.update(id, patch);
    process.stdout.write(JSON.stringify(t, null, 2) + "\n");
  } finally { db.close(); }
}
```

Remove the now-unnecessary `export { openEditor }` re-export at the bottom of the file (the import is now used directly).

- [ ] **Step 4: Run the tests**

Run: `node_modules/.bin/vitest run tests/cli/commands/todo.test.ts`
Expected: PASS (read tests, parseTodoTemplate, and the three editor-flow tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/todo.ts tests/cli/commands/todo.test.ts
git commit -m "feat(cli): editor-driven propose/update for todo (git-commit style)"
```

---

## Task 5: Repoint the `decision` CLI to the live store + regression

**Files:**
- Modify: `src/cli/commands/decision.ts` (`openService`; drop unused `join` import)
- Modify: `tests/cli/decision-count.test.ts` (pin `$CORTEX_DECISIONS_DB`)
- Test: `tests/cli/commands/decision-livestore.test.ts` (new regression)

**Interfaces:**
- Consumes: `resolveDecisionsDbPath`, `legacyDecisionsDbPath`.

- [ ] **Step 1: Write the failing regression test**

```ts
// tests/cli/commands/decision-livestore.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDecisionsDb } from "../../../src/decisions/db.js";
import { DecisionsRepository } from "../../../src/decisions/repository.js";
import { DecisionLinksRepository } from "../../../src/decisions/links-repository.js";
import { DecisionService } from "../../../src/decisions/service.js";

const TSX = join(process.cwd(), "node_modules/.bin/tsx");
const CLI = join(process.cwd(), "src/cli/main.ts");

describe("cortex decision list reads the resolved live store", () => {
  it("surfaces a decision written at resolveDecisionsDbPath (honors CORTEX_DECISIONS_DB)", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-dec-live-"));
    const dbPath = join(root, "decisions.db");
    try {
      const db = openDecisionsDb(dbPath);
      new DecisionService({ db, decisions: new DecisionsRepository(db), links: new DecisionLinksRepository(db) })
        .create({ title: "Live store wins", description: "d", rationale: "r" });
      db.close();
      // Without the fix, the CLI reads <cwd>/.cortex/decisions.db and ignores
      // this override → output would be empty and this assertion fails.
      const out = execFileSync(TSX, [CLI, "decision", "list", "--format=plain"], {
        cwd: root, encoding: "utf-8", env: { ...process.env, CORTEX_DECISIONS_DB: dbPath },
      });
      expect(out).toContain("Live store wins");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node_modules/.bin/vitest run tests/cli/commands/decision-livestore.test.ts`
Expected: FAIL — output does not contain "Live store wins" (CLI still reads the legacy in-repo path, ignoring the override).

- [ ] **Step 3: Apply the path fix in `decision.ts`**

In `src/cli/commands/decision.ts`:
1. Replace the `node:path` import (line 1) — `join` is only used in `openService`, which is changing, so drop it:
```ts
// remove: import { join } from "node:path";
import { resolveDecisionsDbPath, legacyDecisionsDbPath } from "../../db/resolve-path.js";
```
   (Keep this `resolve-path` import even if another `node:path` symbol is needed elsewhere — verify with a quick search that `join(` has no other uses in the file before deleting the import; if it does, keep `import { join } from "node:path"` and only add the `resolve-path` import.)
2. In `openService`, replace:
```ts
  const dbPath = join(ctx.cwd, ".cortex", "decisions.db");
  const db = openDecisionsDb(dbPath);
```
   with:
```ts
  const root = ctx.gitRoot ?? ctx.cwd;
  const db = openDecisionsDb(resolveDecisionsDbPath(root), legacyDecisionsDbPath(root));
```

- [ ] **Step 4: Run the regression test (now passes)**

Run: `node_modules/.bin/vitest run tests/cli/commands/decision-livestore.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the now-broken `decision-count.test.ts`**

The "prints the number of decisions present" case writes to the legacy in-repo path; after the fix the CLI reads the resolved path, so pin both to the same temp DB via `$CORTEX_DECISIONS_DB`. Replace the file's `runCli` helper and that test:

```ts
function runCli(cwd: string, env: Record<string, string> = {}): string {
  return execFileSync(TSX, [CLI, "decision", "count"], {
    cwd, encoding: "utf-8", env: { ...process.env, ...env },
  }).trim();
}
```

```ts
  it("prints the number of decisions present", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-count-"));
    try {
      mkdirSync(join(root, ".git"));
      const dbPath = join(root, "decisions.db");
      const db = openDecisionsDb(dbPath);
      const service = new DecisionService({
        db,
        decisions: new DecisionsRepository(db),
        links: new DecisionLinksRepository(db),
      });
      service.create({ title: "a", description: "d", rationale: "r" });
      service.create({ title: "b", description: "d", rationale: "r" });
      db.close();
      expect(runCli(root, { CORTEX_DECISIONS_DB: dbPath })).toBe("2");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
```

(The "prints 0" and "no git repo" cases are unaffected — `count` returns "0" for an empty/absent store and short-circuits to "0" for `no-project`. Leave them.)

- [ ] **Step 6: Run the full CLI test suite**

Run: `node_modules/.bin/vitest run tests/cli/`
Expected: PASS across the board (todo tests, editor, decision-count, decision-livestore, decision command, rehome, help, etc.). If `help.test.ts` asserts the namespace set, it should already include `todo` from Task 2.

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/decision.ts tests/cli/decision-count.test.ts tests/cli/commands/decision-livestore.test.ts
git commit -m "fix(cli): decision CLI reads the live durable store, not legacy in-repo db"
```

---

## Final verification (before review / release)

- [ ] `node_modules/.bin/vitest run tests/cli/` — all green.
- [ ] `node_modules/.bin/tsc --noEmit` (or the project's typecheck script) — no new type errors in `src/cli/`.
- [ ] Manual: `tsx src/cli/main.ts todo propose "smoke test" --description="hi"` in a temp git repo with `CORTEX_DECISIONS_DB` set, then `todo list` shows it, `todo show <id>` prints links, `todo transition <id> in_progress`.
- [ ] Gate-1 `/review` on `git diff main`.
- [ ] Release: patch bump `package.json` + `plugin.json` + `.claude-plugin/marketplace.json`, add `CHANGELOG.md` entry, `chore(release): <version>`, push, open PR, wait for "CI gate", hand to user for verification before merge.

## Self-review notes (author)

- **Spec coverage:** list/show/search (Task 2), propose/update/transition/link flag path (Task 2+3), editor flow + non-TTY guard + empty-summary abort (Task 4), editor.ts helper (Task 1), main.ts/help.ts wiring (Task 2), decision path fix + regression + broken-test repair (Task 5). All spec sections mapped.
- **Type consistency:** `runTodoCommand`/`TodoCommand`/`parseTodoTemplate` names match across tasks; `openEditor` signature consistent; `TodoService` method shapes copied from `src/todos/service.ts`.
- **Known interaction:** the decision fix breaks exactly one existing assertion (`decision-count` test #2), repaired in Task 5 Step 5. `rehome` uses its own explicit paths and is unaffected.

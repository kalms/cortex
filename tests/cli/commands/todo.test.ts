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

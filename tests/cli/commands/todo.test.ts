import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTodoCommand, parseTodoTemplate } from "../../../src/cli/commands/todo.js";
import type { ProjectContext } from "../../../src/cli/context.js";
import * as editor from "../../../src/cli/editor.js";

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
    const prevTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.spyOn(editor, "openEditor").mockReturnValue("# only comments\n\n");
    try {
      await expect(runTodoCommand({ command: "propose", positionals: [], flags: {} }, ctx()))
        .rejects.toThrow(/empty summary/i);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });

  it("propose without a summary in a non-TTY context throws UsageError", async () => {
    const prevTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await expect(runTodoCommand({ command: "propose", positionals: [], flags: {} }, ctx()))
        .rejects.toThrow(/summary/i);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });

  it("update with no field flags edits summary via the editor", async () => {
    const prevTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const c = ctx();
    // seed a todo through the command layer (flag path, no editor)
    const s1 = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runTodoCommand({ command: "propose", positionals: ["Original summary"], flags: {} }, c);
    const created = JSON.parse(s1.mock.calls.map((x) => String(x[0])).join(""));
    s1.mockRestore();
    // now update with no flags -> editor opens, returns new content
    vi.spyOn(editor, "openEditor").mockReturnValue("Edited summary\n\nEdited body");
    const s2 = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runTodoCommand({ command: "update", positionals: [created.id], flags: {} }, c);
      const updated = JSON.parse(s2.mock.calls.map((x) => String(x[0])).join(""));
      expect(updated.summary).toBe("Edited summary");
      expect(updated.description).toBe("Edited body");
    } finally {
      s2.mockRestore();
      Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    }
  });
});

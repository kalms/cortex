import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { GraphStore } from "../../../src/graph/store.js";
import { runCodeCommand } from "../../../src/cli/commands/code.js";
import type { ProjectContext } from "../../../src/cli/context.js";

describe("cortex code commands", () => {
  let dir: string;
  let dbPath: string;
  let store: GraphStore;
  let ctx: ProjectContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-code-cmd-"));
    dbPath = join(dir, "graph.db");
    store = new GraphStore(dbPath);
    ctx = { state: "indexed", cwd: dir, gitRoot: dir, projectName: "test", graphDbPath: dbPath };

    // GraphStore.createNode does not set the `project` column; code-query helpers
    // filter by project = ?, so we set it directly after insert.
    const n1 = store.createNode({ kind: "function", name: "foo", qualified_name: "test.src.foo", file_path: "src/foo.ts" });
    const n2 = store.createNode({ kind: "function", name: "bar", qualified_name: "test.src.bar", file_path: "src/bar.ts" });
    const n3 = store.createNode({ kind: "route", name: "fooRoute", qualified_name: "test.src.fooRoute", file_path: "src/r.ts" });
    const n4 = store.createNode({ kind: "section", name: "foofoo", qualified_name: "test.docs.foofoo", file_path: "docs/x.md" });
    const n5 = store.createNode({ kind: "function", name: "fooThing", qualified_name: "test.thing.fooThing", file_path: "thing.ts" });
    writeFileSync(join(dir, "thing.ts"), "export function fooThing() {\n  return 1;\n}\n");
    writeFileSync(join(dir, "notes.md"), "# Notes\nfoo appears in prose here\n");
    const db = new Database(dbPath);
    db.prepare("UPDATE nodes SET project = ? WHERE id IN (?, ?, ?, ?, ?)").run("test", n1.id, n2.id, n3.id, n4.id, n5.id);
    db.prepare("UPDATE nodes SET start_line = 1, end_line = 3 WHERE id = ?").run(n5.id);
    db.close();
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("find: returns matching nodes", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "find", positionals: ["foo"], flags: {} }, ctx);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("test.src.foo");
    writeSpy.mockRestore();
  });

  it("find: excludes sections by default and notes them on stderr", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "find", positionals: ["foo"], flags: { format: "plain" } }, ctx);
    const out = outSpy.mock.calls.map((c) => String(c[0])).join("");
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).not.toContain("test.docs.foofoo"); // section excluded from stdout
    expect(err).toMatch(/section node.* hidden/);   // but reported on stderr
    expect(err).toContain("--kind=section");
    outSpy.mockRestore(); errSpy.mockRestore();
  });

  it("find --kind=section: includes sections and emits no hidden note", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "find", positionals: ["foo"], flags: { kind: "section", format: "plain" } }, ctx);
    const out = outSpy.mock.calls.map((c) => String(c[0])).join("");
    const err = errSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("test.docs.foofoo");
    expect(err).not.toContain("hidden");
    outSpy.mockRestore(); errSpy.mockRestore();
  });

  it("find --kind=function: narrows to functions", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "find", positionals: ["foo"], flags: { kind: "function", format: "plain" } }, ctx);
    const out = outSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("test.src.foo");
    expect(out).not.toContain("test.src.fooRoute"); // route filtered out
    vi.restoreAllMocks();
  });

  it("find --limit=1: returns a single ranked row", async () => {
    const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "find", positionals: ["foo"], flags: { limit: "1", format: "plain" } }, ctx);
    const out = outSpy.mock.calls.map((c) => String(c[0])).join("").trim();
    expect(out.split("\n").length).toBe(1);
    expect(out).toContain("test.src.foo"); // exact-name function ranks first
    vi.restoreAllMocks();
  });

  it("schema: emits node + edge counts", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runCodeCommand({ command: "schema", positionals: [], flags: {} }, ctx);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("function");
    writeSpy.mockRestore();
  });

  it("unknown sub-command throws UsageError", async () => {
    await expect(runCodeCommand({ command: "badcmd", positionals: [], flags: {} }, ctx))
      .rejects.toThrow("unknown command");
  });

  describe("cmdSearch", () => {
    it("ranks code-symbol hits above doc/prose hits", async () => {
      const outSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await runCodeCommand({ command: "search", positionals: ["foo"], flags: { format: "plain" } }, ctx);
      const out = outSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("thing.ts");
      expect(out.indexOf("thing.ts")).toBeLessThan(out.indexOf("notes.md")); // code before doc
      vi.restoreAllMocks();
    });

    it("emits a redirect-to-find hint on stderr when --kind is passed", async () => {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await runCodeCommand({ command: "search", positionals: ["foo"], flags: { kind: "function", format: "plain" } }, ctx);
      const err = errSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(err).toContain("cortex code find");
      vi.restoreAllMocks();
    });
  });
});

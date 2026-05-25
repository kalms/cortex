import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
    ctx = { state: "indexed", cwd: dir, projectName: "test", graphDbPath: dbPath };

    // GraphStore.createNode does not set the `project` column; code-query helpers
    // filter by project = ?, so we set it directly after insert.
    const n1 = store.createNode({ kind: "function", name: "foo", qualified_name: "test.src.foo", file_path: "src/foo.ts" });
    const n2 = store.createNode({ kind: "function", name: "bar", qualified_name: "test.src.bar", file_path: "src/bar.ts" });
    const db = new Database(dbPath);
    db.prepare("UPDATE nodes SET project = ? WHERE id IN (?, ?)").run("test", n1.id, n2.id);
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
});

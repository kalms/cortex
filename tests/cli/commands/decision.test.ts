import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDecisionCommand } from "../../../src/cli/commands/decision.js";
import type { ProjectContext } from "../../../src/cli/context.js";

describe("cortex decision commands", () => {
  let dir: string;
  let ctx: ProjectContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cortex-dec-cmd-"));
    ctx = { state: "indexed", cwd: dir, projectName: "test", graphDbPath: join(dir, "graph.db") };
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("list with no decisions returns empty output", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({ command: "list", positionals: [], flags: {} }, ctx);
    writeSpy.mockRestore();
    // Nothing thrown, that's the success path.
  });

  it("create with required flags persists the decision", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runDecisionCommand({
      command: "create",
      positionals: [],
      flags: { title: "Test", description: "d", rationale: "r" },
    }, ctx);
    const out = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(out).toContain("Test");
    writeSpy.mockRestore();
  });

  it("create without --title throws UsageError", async () => {
    await expect(runDecisionCommand({
      command: "create",
      positionals: [],
      flags: { description: "d", rationale: "r" },
    }, ctx)).rejects.toThrow("missing --title");
  });

  it("unknown sub-command throws UsageError", async () => {
    await expect(runDecisionCommand({ command: "frobnicate", positionals: [], flags: {} }, ctx))
      .rejects.toThrow("unknown command");
  });
});

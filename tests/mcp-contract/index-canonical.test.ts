import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexerBinPath } from "../../src/cli/paths.js";
import { Registry } from "../../src/db/registry.js";
import { deriveProjectName } from "../../src/cli/context.js";
import { registerTool, RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { registerCodeTools } from "../../src/mcp-server/tools/code-tools.js";

const hasIndexer = existsSync(indexerBinPath());

describe.skipIf(!hasIndexer)("index_repository — canonical rooting", () => {
  it("indexing a subdir registers the project at the git root, not the subdir", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "cortex-idx-")));
    execSync(`git init -q "${root}"`);
    // minimal indexable content
    execSync(`git -C "${root}" commit -q --allow-empty -m init`);
    mkdirSync(join(root, "pkg"), { recursive: true });

    const registryPath = join(realpathSync(mkdtempSync(join(tmpdir(), "cortex-reg-"))), "registry.db");
    process.env.CORTEX_REGISTRY_DB = registryPath;

    // Drive the real MCP index_repository handler against the SUBDIR.
    const { handler } = makeIndexHandler(); // see helper below
    await handler({ repo_path: join(root, "pkg") });

    const reg = new Registry(registryPath);
    try {
      const names = reg.list().map((r) => r.root_path);
      expect(names).toContain(root);                 // canonical registered
      expect(names).not.toContain(join(root, "pkg")); // no subdir orphan
    } finally {
      reg.close();
      delete process.env.CORTEX_REGISTRY_DB;
    }
    expect(existsSync(join(root, ".cortex", "db"))).toBe(true);
    expect(existsSync(join(root, "pkg", ".cortex", "db"))).toBe(false);
  });

  // Ruling B (per-worktree-indexes spec, tasks 4+6): the MCP index_repository
  // handler is a second, independent index path with its own canonicalization
  // and its own registry write — it must get the identical checkout-axis
  // treatment as the CLI entry (src/cli/commands/index.ts), or MCP-driven
  // indexing (the path agents actually use) keeps writing a worktree's index
  // into the canonical store and registers worktree_of = null, which the
  // doctor carve-out (Task 7) would then fail to protect.
  it("indexing a linked worktree writes its own store and registers worktree_of/branch", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "cortex-idx-wt-")));
    const main = join(base, "main");
    mkdirSync(main);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    git(main, "init", "-b", "main");
    git(main, "config", "user.email", "t@t.t");
    git(main, "config", "user.name", "t");
    writeFileSync(join(main, "a.txt"), "a");
    git(main, "add", "-A");
    git(main, "commit", "-m", "init");
    const wt = join(base, "wt");
    git(main, "worktree", "add", "-b", "feature/x", wt);

    const registryPath = join(base, "registry.db");
    process.env.CORTEX_REGISTRY_DB = registryPath;

    const { handler } = makeIndexHandler();
    try {
      await handler({ repo_path: wt });

      expect(existsSync(join(wt, ".cortex", "db"))).toBe(true);
      expect(existsSync(join(main, ".cortex", "db"))).toBe(false);

      const reg = new Registry(registryPath);
      try {
        const row = reg.findByName(deriveProjectName(wt))!;
        expect(row.worktree_of).toBe(main);
        expect(row.branch).toBe("feature/x");
      } finally {
        reg.close();
      }
    } finally {
      delete process.env.CORTEX_REGISTRY_DB;
    }
  });
});

function makeIndexHandler(): { handler: (args: any) => Promise<unknown> } {
  const resolver = new RepoContextResolver({ poolCapacity: 4 });
  let handler: ((args: any) => Promise<unknown>) | null = null;
  const fakeServer = {
    tool(name: string, _desc: string, _shape: unknown, wrapped: (args: any) => Promise<unknown>) {
      if (name === "index_repository") handler = wrapped;
    },
  } as any;
  registerCodeTools(fakeServer, resolver);
  if (!handler) throw new Error("index_repository not registered");
  return { handler };
}

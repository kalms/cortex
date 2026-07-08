import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, realpathSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexerBinPath } from "../../src/cli/paths.js";
import { Registry } from "../../src/db/registry.js";
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

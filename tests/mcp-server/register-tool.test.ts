import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerTool, MissingRepoPathError, RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeIndexedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-repo-"));
  execSync(`git init -q "${root}"`);
  mkdirSync(join(root, ".cortex"));
  writeFileSync(join(root, ".cortex/db"), "");
  return root;
}

describe("registerTool — default (per-repo) mode", () => {
  const repo = makeIndexedRepo();
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  it("calls handler with (context, args) when repo_path is valid", async () => {
    const schema = z.object({ repo_path: z.string(), name: z.string() });
    let received: { ctxPath: string; name: string } | null = null;
    const wrapped = registerTool("noop_tool", schema, async (ctx, args) => {
      received = { ctxPath: ctx.repoPath, name: args.name };
      return { ok: true };
    }, { resolver });

    await wrapped({ repo_path: repo, name: "hello" });
    expect(received).toEqual({ ctxPath: repo, name: "hello" });
  });

  it("throws MissingRepoPathError when repo_path is absent", async () => {
    // Schema declares repo_path as required (the natural shape for per-repo
    // tools). The wrapper pre-checks repo_path BEFORE schema.parse, so the
    // friendly MissingRepoPathError with available_projects beats the raw
    // ZodError that would otherwise fire on the missing required field.
    const schema = z.object({ repo_path: z.string(), name: z.string() });
    const wrapped = registerTool("noop_tool", schema, async () => ({ ok: true }), { resolver });
    await expect(wrapped({ name: "hello" } as any)).rejects.toThrow(MissingRepoPathError);
  });
});

describe("registerTool — crossRepo mode", () => {
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  it("passes the resolver (not a context) to the handler and ignores repo_path", async () => {
    const schema = z.object({});
    let receivedResolver: RepoContextResolver | null = null;
    const wrapped = registerTool("list_projects", schema, async (r) => {
      receivedResolver = r;
      return [];
    }, { resolver, crossRepo: true });

    await wrapped({});
    expect(receivedResolver).toBe(resolver);
  });

  it("does NOT throw MissingRepoPathError when repo_path is absent", async () => {
    const schema = z.object({});
    const wrapped = registerTool("list_projects", schema, async () => [], { resolver, crossRepo: true });
    await expect(wrapped({})).resolves.toEqual([]);
  });
});

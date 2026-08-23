import { describe, expect, it } from "vitest";
import { z } from "zod";
import { registerTool, MissingRepoPathError, RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
    // ctx.repoPath is realpath-normalized to the checkout axis (worktreeRoot),
    // so on macOS `repo` (/tmp/...) becomes `/private/tmp/...`. Compare via
    // realpath. This repo has no linked worktree, so the checkout and
    // repo-identity axes coincide.
    expect(received).toEqual({ ctxPath: realpathSync(repo), name: "hello" });
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

describe("registerTool — allowUnindexed mode", () => {
  const resolver = new RepoContextResolver({ poolCapacity: 8 });

  it("hands the resolver to the handler WITHOUT calling resolve()", async () => {
    // The path below has no .cortex/db. Default-mode tools would throw
    // RepoNotIndexedError here; allowUnindexed tools (index_repository)
    // must instead receive the raw path and run their own validation.
    const unindexed = mkdtempSync(join(tmpdir(), "cortex-unindexed-"));
    execSync(`git init -q "${unindexed}"`);

    const schema = z.object({ repo_path: z.string() });
    let received: { resolver: RepoContextResolver | null; repoPath: string | null } = {
      resolver: null,
      repoPath: null,
    };
    const wrapped = registerTool(
      "index_repository",
      schema,
      async (r, args) => {
        received = { resolver: r, repoPath: args.repo_path };
        return { ok: true };
      },
      { resolver, allowUnindexed: true },
    );

    const result = await wrapped({ repo_path: unindexed });
    expect(result).toEqual({ ok: true });
    expect(received.resolver).toBe(resolver);
    expect(received.repoPath).toBe(unindexed);
  });

  it("still throws MissingRepoPathError when repo_path is absent", async () => {
    // allowUnindexed bypasses the *indexed* check, not the *required-path*
    // check. An agent calling index_repository without telling us WHICH
    // repo to index is just as broken as one calling search_graph without
    // a target.
    const schema = z.object({ repo_path: z.string() });
    const wrapped = registerTool(
      "index_repository",
      schema,
      async () => ({ ok: true }),
      { resolver, allowUnindexed: true },
    );
    await expect(wrapped({} as any)).rejects.toThrow(MissingRepoPathError);
  });
});

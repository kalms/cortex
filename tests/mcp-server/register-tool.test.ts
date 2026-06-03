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
    // Schema declares repo_path optional so the wrapper's missing-path guard
    // fires instead of a generic ZodError; the wrapper is the canonical place
    // to surface friendly "you forgot repo_path" errors with project hints.
    const schema = z.object({ repo_path: z.string().optional(), name: z.string() });
    const wrapped = registerTool("noop_tool", schema, async () => ({ ok: true }), { resolver });
    await expect(wrapped({ name: "hello" } as any)).rejects.toThrow(MissingRepoPathError);
  });
});

import { describe, expect, it } from "vitest";
import { RepoContextPool } from "../../src/mcp-server/repo-context.js";
import type { RepoContext } from "../../src/mcp-server/repo-context.js";

function makeStubContext(path: string): RepoContext {
  // Minimal stub for pool tests — DB handles aren't exercised here.
  return {
    repoPath: path,
    graphDb: { close: () => {} } as any,
    decisionsDb: { close: () => {} } as any,
    store: {} as any,
    decisionsRepo: {} as any,
    decisionLinksRepo: {} as any,
  };
}

describe("RepoContextPool", () => {
  it("returns the stored context for a known path", () => {
    const pool = new RepoContextPool({ capacity: 8 });
    const ctx = makeStubContext("/repo/a");
    pool.set("/repo/a", ctx);
    expect(pool.get("/repo/a")).toBe(ctx);
  });

  it("returns undefined for an unknown path", () => {
    const pool = new RepoContextPool({ capacity: 8 });
    expect(pool.get("/repo/missing")).toBeUndefined();
  });
});

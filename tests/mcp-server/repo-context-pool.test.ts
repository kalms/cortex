import { describe, expect, it } from "vitest";
import { RepoContextPool } from "../../src/mcp-server/repo-context.js";
import type { RepoContext } from "../../src/mcp-server/repo-context.js";

function makeStubContext(path: string): RepoContext {
  // Minimal stub for pool tests — DB handles aren't exercised here.
  return {
    repoPath: path,
    graphDb: { close: () => {} } as any,
    decisionsDb: { close: () => {} } as any,
    store: { close: () => {} } as any,
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

  it("does not grow unbounded; closes DB handles on eviction", () => {
    const closed: string[] = [];
    const make = (path: string): RepoContext => ({
      repoPath: path,
      graphDb: { close: () => closed.push(`${path}:graph`) } as any,
      decisionsDb: { close: () => closed.push(`${path}:decisions`) } as any,
      store: { close: () => {} } as any,
      decisionsRepo: {} as any,
      decisionLinksRepo: {} as any,
    });

    const pool = new RepoContextPool({ capacity: 2 });
    pool.set("/r/a", make("/r/a"));
    pool.set("/r/b", make("/r/b"));
    pool.set("/r/c", make("/r/c"));  // should evict /r/a

    expect(pool.get("/r/a")).toBeUndefined();
    expect(pool.get("/r/b")).toBeDefined();
    expect(pool.get("/r/c")).toBeDefined();
    expect(closed).toContain("/r/a:graph");
    expect(closed).toContain("/r/a:decisions");
  });

  it("shutdown() closes every remaining handle and empties the pool", () => {
    const closed: string[] = [];
    const make = (path: string): RepoContext => ({
      repoPath: path,
      graphDb: { close: () => closed.push(`${path}:graph`) } as any,
      decisionsDb: { close: () => closed.push(`${path}:decisions`) } as any,
      store: { close: () => {} } as any,
      decisionsRepo: {} as any,
      decisionLinksRepo: {} as any,
    });

    const pool = new RepoContextPool({ capacity: 4 });
    pool.set("/r/a", make("/r/a"));
    pool.set("/r/b", make("/r/b"));
    pool.shutdown();

    expect(closed).toEqual(expect.arrayContaining([
      "/r/a:graph", "/r/a:decisions", "/r/b:graph", "/r/b:decisions",
    ]));
    expect(pool.get("/r/a")).toBeUndefined();
    expect(pool.get("/r/b")).toBeUndefined();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createHarness, callTool, type HarnessContext } from "./harness.js";
import { computeCacheKey, cachePath } from "../../src/db/cache.js";

describe("index_repository content-hash cache", () => {
  let h: HarnessContext;
  let repo: string;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    h = await createHarness();
    // Build a tiny git repo with a single commit; this is what we'll index.
    repo = mkdtempSync(join(tmpdir(), "cortex-idxcache-"));
    writeFileSync(join(repo, "hello.ts"), "export const hello = 1;\n");
    execSync(
      [
        "git -c user.email=t@t -c user.name=t init",
        "git -c user.email=t@t -c user.name=t add .",
        "git -c user.email=t@t -c user.name=t commit -m init",
      ].join(" && "),
      { cwd: repo, stdio: "ignore" },
    );
  });

  afterAll(async () => {
    await h.close();
    rmSync(repo, { recursive: true, force: true });
    while (createdKeys.length) {
      const k = createdKeys.pop()!;
      rmSync(cachePath(k), { force: true });
    }
  });

  it("hits cache on second call with unchanged repo", async () => {
    // Capture the key we'll be writing so afterAll can clean it up.
    const key = computeCacheKey(repo);
    createdKeys.push(key);

    const r1 = await callTool(h, "index_repository", { path: repo });
    expect(r1.isError).toBeFalsy();

    const r2 = await callTool(h, "index_repository", { path: repo });
    expect(r2.isError).toBeFalsy();
    expect(r2.content[0].text).toMatch(/imported from cache key/);
  });
});

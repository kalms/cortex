import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { setIndexSignalEmitter } from "../../src/index-signal.js";
import type { IndexSignalMsg } from "../../src/events/types.js";
import { indexRepositoryForTest } from "../../src/mcp-server/tools/code-tools.js";

const temps: string[] = [];

/** A git-init'd repo with one indexable source file. Realpath'd because the
 *  handler canonicalizes its repo_path and macOS tmpdir is a symlink. */
function makeTempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cortex-idx-signal-")));
  temps.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "a.ts"), "export function alpha(): number { return 1; }\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

afterEach(() => {
  setIndexSignalEmitter(null);
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("index_repository emits lifecycle signals", () => {
  it("brackets a successful index with started and completed", async () => {
    const repo = makeTempRepo();
    const seen: IndexSignalMsg[] = [];
    setIndexSignalEmitter((m) => seen.push(m));

    await indexRepositoryForTest({ repo_path: repo });

    expect(seen.map((s) => s.phase)).toEqual(["started", "completed"]);
    expect(seen[0].repo_path).toBe(repo);
    expect(seen[1].stats?.elapsed_ms).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("emits failed when the index throws, and still rethrows", async () => {
    const seen: IndexSignalMsg[] = [];
    setIndexSignalEmitter((m) => seen.push(m));

    // withIndexLock's first act is a synchronous mkdirSync under repo_path, so
    // an unwritable path throws rather than returning an error envelope. The
    // throw must still reach the caller — only the signal is added.
    await expect(
      indexRepositoryForTest({ repo_path: "/nonexistent/path/xyz" }),
    ).rejects.toThrow(/ENOENT/);

    expect(seen.map((s) => s.phase)).toEqual(["started", "failed"]);
    expect(seen[1].error).toBeTruthy();
    expect(seen[1].stats).toBeUndefined();
  }, 120_000);
});

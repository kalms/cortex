// tests/frame-extraction/co-change.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { collectCoChange, parseCoChangeLog } from "../../scripts/frame-extraction/co-change.js";

let root: string;

function git(args: string, opts: { cwd: string }) {
  return execSync(`git ${args}`, { ...opts, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(repo: string, message: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(join(repo, path.split("/").slice(0, -1).join("/") || "."), { recursive: true });
    writeFileSync(full, content);
    git(`add ${path}`, { cwd: repo });
  }
  git(`-c user.email=test@example.com -c user.name=test commit -m "${message}"`, { cwd: repo });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-co-change-"));
  git("init -q", { cwd: root });
  // Commit 1: a + b touched together
  commit(root, "feat: auth", { "src/auth.ts": "x", "src/middleware.ts": "x" });
  // Commit 2: a + b touched together again
  commit(root, "fix: auth", { "src/auth.ts": "y", "src/middleware.ts": "y" });
  // Commit 3: a + c touched (b not touched)
  commit(root, "feat: c", { "src/auth.ts": "z", "src/api.ts": "x" });
  // Commit 4: only c (no pair generated)
  commit(root, "tweak: c", { "src/api.ts": "y" });
  // Commit 5: huge format-pass commit (60 files) — should be dropped
  const big: Record<string, string> = {};
  for (let i = 0; i < 60; i++) big[`big/f${i}.txt`] = "x";
  commit(root, "chore: format", big);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("parseCoChangeLog (pure)", () => {
  it("yields one pair per file-pair per commit", () => {
    const log =
      "abc123\n" +
      "src/auth.ts\n" +
      "src/middleware.ts\n" +
      "\n" +
      "def456\n" +
      "src/auth.ts\n" +
      "src/middleware.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    // 2 commits × 1 pair each = 2 raw pair events. parseCoChangeLog yields
    // the raw events; aggregation is collectCoChange's job.
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({ a: "src/auth.ts", b: "src/middleware.ts", count: 1 });
    expect(pairs[1]).toEqual({ a: "src/auth.ts", b: "src/middleware.ts", count: 1 });
  });

  it("drops commits with >= big_commit_threshold files", () => {
    const files = Array.from({ length: 60 }, (_, i) => `big/f${i}.txt`).join("\n");
    const log = `abc123\n${files}\n\ndef456\nsrc/auth.ts\nsrc/middleware.ts\n`;
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    // Only the small commit's pair survives.
    expect(pairs).toEqual([{ a: "src/auth.ts", b: "src/middleware.ts", count: 1 }]);
  });

  it("sorts pair endpoints so (a, b) and (b, a) collapse", () => {
    const log = "abc123\nz.ts\na.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs[0]).toEqual({ a: "a.ts", b: "z.ts", count: 1 });
  });

  it("skips commits with fewer than 2 files (no pair possible)", () => {
    const log = "abc123\nonly.ts\n\ndef456\na.ts\nb.ts\n";
    const pairs = [...parseCoChangeLog(log, { big_commit_threshold: 50 })];
    expect(pairs).toEqual([{ a: "a.ts", b: "b.ts", count: 1 }]);
  });
});

describe("collectCoChange (integration over git log)", () => {
  it("aggregates pairs across commits and applies min_count filter", () => {
    const pairs = collectCoChange({
      repo_path: root,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 1,
    });
    // auth ↔ middleware appears in 2 commits → count 2
    // auth ↔ api appears in 1 commit → count 1
    const am = pairs.find((p) => p.a === "src/auth.ts" && p.b === "src/middleware.ts");
    const aa = pairs.find((p) => p.a === "src/api.ts" && p.b === "src/auth.ts");
    expect(am?.count).toBe(2);
    expect(aa?.count).toBe(1);
  });

  it("drops the 60-file format-pass commit", () => {
    const pairs = collectCoChange({
      repo_path: root,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 1,
    });
    // No pair containing big/f*.txt should appear.
    expect(pairs.some((p) => p.a.startsWith("big/") || p.b.startsWith("big/"))).toBe(false);
  });

  it("min_count filter removes singletons", () => {
    const pairs = collectCoChange({
      repo_path: root,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 2,
    });
    // Only the auth↔middleware pair has count >= 2.
    expect(pairs).toEqual([
      { a: "src/auth.ts", b: "src/middleware.ts", count: 2 },
    ]);
  });

  it("returns pairs sorted desc by count", () => {
    const pairs = collectCoChange({
      repo_path: root,
      since_days: 365,
      big_commit_threshold: 50,
      min_count: 1,
    });
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1]!.count).toBeGreaterThanOrEqual(pairs[i]!.count);
    }
  });
});

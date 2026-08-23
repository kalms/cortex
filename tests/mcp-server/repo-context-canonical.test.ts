import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { RepoContextResolver } from "../../src/mcp-server/repo-context.js";
import { resolveCortexDbPath } from "../../src/db/resolve-path.js";
import { GraphStore } from "../../src/graph/store.js";

const git = (r: string, a: string[]) =>
  execFileSync("git", ["-C", r, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { encoding: "utf8" });

// Minimal populated .cortex/db (via GraphStore so the schema matches) so
// resolveGraphDbForRead picks the canonical file over any fallback.
function seedCanonicalDb(repo: string) {
  const p = resolveCortexDbPath(repo);
  mkdirSync(join(repo, ".cortex"), { recursive: true });
  const store = new GraphStore(p);
  store.createNode({ kind: "file", name: "a.txt" });
  store.close();
}

describe("RepoContext.canonical", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "cortex-canon-"));
    git(repo, ["init"]); writeFileSync(join(repo, "a.txt"), "x");
    git(repo, ["add", "."]); git(repo, ["commit", "-m", "init"]);
    seedCanonicalDb(repo);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reports canonical=true when reading the .cortex/db", () => {
    const r = new RepoContextResolver({ poolCapacity: 4 });
    const ctx = r.resolve(repo);
    // Use ctx.repoPath (realpath'd checkout root — worktreeRoot; this plain
    // repo has no linked worktree, so it coincides with the canonical root)
    // on both sides — macOS tmpdir lives under /var → /private/var, so
    // comparing to the raw `repo` path would mismatch on the symlink prefix.
    expect(ctx.graphDbPath).toBe(resolveCortexDbPath(ctx.repoPath));
    expect(ctx.canonical).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameCandidates } from "../../../src/decisions/seed/frame-candidates.js";

function git(cwd: string, args: string[]) { execFileSync("git", args, { cwd, stdio: "ignore" }); }

function repoWithDocsAndCommits(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-frame-"));
  git(root, ["init"]);
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  writeFileSync(join(root, "docs/adr/0001-x.md"), "# X\n## Context\na\n## Decision\nb\n");
  writeFileSync(join(root, "a.ts"), "x");
  git(root, ["add", "."]);
  git(root, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feat(core): seed"]);
  return root;
}

describe("frameCandidates", () => {
  it("includes both doc and commit candidates, docs ranked first", () => {
    const root = repoWithDocsAndCommits();
    try {
      const out = frameCandidates({ repo_path: root });
      expect(out).toHaveLength(2);
      expect(out[0].kind).toBe("adr");          // high-confidence first
      expect(out.some((c) => c.kind === "commit_cluster")).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("caps the manifest at max_candidates", () => {
    const root = repoWithDocsAndCommits();
    try {
      expect(frameCandidates({ repo_path: root, max_candidates: 1 })).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clusterCommitCandidates } from "../../../src/decisions/seed/commit-clustering.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function commit(cwd: string, file: string, msg: string): void {
  writeFileSync(join(cwd, file), `${Math.random()}`);
  git(cwd, ["add", "."]);
  git(cwd, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", msg]);
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "cortex-commits-"));
  git(root, ["init"]);
  return root;
}

describe("clusterCommitCandidates", () => {
  it("groups conventional commits by scope", () => {
    const root = repo();
    try {
      commit(root, "a.ts", "feat(frames): add extraction");
      commit(root, "b.ts", "fix(frames): venv path");
      commit(root, "c.ts", "feat(decisions): provenance column");
      const cands = clusterCommitCandidates(root, 100);
      const scopes = cands.map((c) => c.title_hint);
      expect(scopes.some((s) => s.includes("frames"))).toBe(true);
      expect(scopes.some((s) => s.includes("decisions"))).toBe(true);
      const frames = cands.find((c) => c.title_hint.includes("frames"))!;
      expect(frames.kind).toBe("commit_cluster");
      expect(frames.confidence).toBe("low");
      expect(frames.provenance.commit_shas?.length).toBe(2);
      expect(frames.provenance.files_touched.sort()).toEqual(["a.ts", "b.ts"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("returns an empty array for a repo with no commits", () => {
    const root = repo();
    try {
      expect(clusterCommitCandidates(root, 100)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

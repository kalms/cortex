/**
 * Branch-scoped candidate manifest (P4 warm path): with `base` set,
 * frameCandidates clusters only base..HEAD commits and restricts doc
 * candidates to markdown files touched in base...HEAD — so a warm-path
 * caller sees the merged branch's decisions, not the whole history.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { frameCandidates } from "../../../src/decisions/seed/frame-candidates.js";

let repo: string;
let baseSha: string;
let branchSha: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
}

const MAIN_ADR = `# ADR 0001: main-line-adr-marker

## Context

x

## Decision

y
`;

const BRANCH_ADR = `# ADR 0002: branch-line-adr-marker

## Context

x

## Decision

y
`;

describe("frameCandidates with base (branch scoping)", () => {
  beforeAll(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "cortex-candidates-base-")));
    execFileSync("git", ["init", "--initial-branch=main", repo]);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    // Commit A on main: an ADR + a source file.
    mkdirSync(join(repo, "docs", "adr"), { recursive: true });
    writeFileSync(join(repo, "docs", "adr", "0001-main.md"), MAIN_ADR);
    writeFileSync(join(repo, "core.ts"), "export const a = 1;\n");
    git("add", ".");
    git("commit", "--no-gpg-sign", "-m", "feat(core): seed main line");
    baseSha = git("rev-parse", "HEAD");

    // Commit B on a branch: a second ADR + a different source file.
    git("checkout", "-b", "feature/x");
    writeFileSync(join(repo, "docs", "adr", "0002-branch.md"), BRANCH_ADR);
    writeFileSync(join(repo, "api.ts"), "export const b = 2;\n");
    git("add", ".");
    git("commit", "--no-gpg-sign", "-m", "feat(api): branch change");
    branchSha = git("rev-parse", "HEAD");
  });

  afterAll(() => {
    try { rmSync(repo, { recursive: true }); } catch { /* ignore */ }
  });

  it("without base, both history and all docs are candidates", () => {
    const all = frameCandidates({ repo_path: repo });
    const text = JSON.stringify(all);
    expect(text).toContain("main-line-adr-marker");
    expect(text).toContain("branch-line-adr-marker");
    const shas = all.flatMap((c) => c.provenance.commit_shas ?? []);
    expect(shas).toContain(baseSha);
    expect(shas).toContain(branchSha);
  });

  it("with base, commit clusters cover only base..HEAD", () => {
    const scoped = frameCandidates({ repo_path: repo, base: "main" });
    const shas = scoped.flatMap((c) => c.provenance.commit_shas ?? []);
    expect(shas).toContain(branchSha);
    expect(shas).not.toContain(baseSha);
  });

  it("with base, doc candidates are restricted to branch-touched markdown", () => {
    const scoped = frameCandidates({ repo_path: repo, base: "main" });
    const text = JSON.stringify(scoped);
    expect(text).toContain("branch-line-adr-marker");
    expect(text).not.toContain("main-line-adr-marker");
  });

  it("an invalid base ref throws", () => {
    expect(() => frameCandidates({ repo_path: repo, base: "no-such-ref" }))
      .toThrow(/invalid base ref/);
  });
});

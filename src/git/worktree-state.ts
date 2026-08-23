import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** True when `repo` is inside a git work tree. */
export function isGitRepo(repo: string): boolean {
  return git(repo, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/** Current HEAD commit SHA, or null when unavailable (non-git / no commits). */
export function gitHead(repo: string): string | null {
  const out = git(repo, ["rev-parse", "HEAD"]);
  return out ? out.trim() : null;
}

/** sha1 of `git status --porcelain` — a stable signature of the working-tree
 *  state (tracked modifications + non-ignored untracked). null outside git.
 *  Empty/clean tree still yields a (constant) hash of the empty string. */
export function gitDirtySig(repo: string): string | null {
  const out = git(repo, ["status", "--porcelain", "--untracked-files=normal"]);
  if (out === null) return null;
  return createHash("sha1").update(out).digest("hex");
}

/** Number of commits on HEAD since `base`, or null if uncomputable (e.g. base
 *  was rebased away). */
export function gitCommitsBehind(repo: string, base: string): number | null {
  const out = git(repo, ["rev-list", "--count", `${base}..HEAD`]);
  if (out === null) return null;
  const n = parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** Current branch name, or null when detached / not a git repo. */
export function gitBranch(repoPath: string): string | null {
  const out = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!out) return null;
  const name = out.trim();
  return name && name !== "HEAD" ? name : null;
}

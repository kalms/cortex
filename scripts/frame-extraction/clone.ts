// scripts/frame-extraction/clone.ts
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoSpec } from "./types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const CORPUS_DIR = join(REPO_ROOT, ".tmp", "frame-extraction", "corpus");

export interface CloneResult {
  ok: boolean;
  path: string;
  commit_sha: string | null;
  error?: string;
}

/** Idempotent: if the destination already exists, leave it untouched and
 *  return its current HEAD sha — deterministic within a single survey run.
 *  Wipe the destination manually for a fresh clone. */
export function ensureClone(repo: RepoSpec): CloneResult {
  if (repo.git === null) {
    const path = repo.local_path
      ? resolve(REPO_ROOT, repo.local_path)
      : REPO_ROOT;
    return { ok: true, path, commit_sha: gitHead(path) };
  }
  mkdirSync(CORPUS_DIR, { recursive: true });
  const dest = join(CORPUS_DIR, repo.slug.replace("/", "__"));
  if (!existsSync(dest)) {
    const res = spawnSync("git", ["clone", "--depth=1", repo.git, dest], {
      encoding: "utf-8",
    });
    if (res.status !== 0) {
      return { ok: false, path: dest, commit_sha: null, error: res.stderr };
    }
  } else {
    // Already cloned — leave as is for determinism within a run.
  }
  return { ok: true, path: dest, commit_sha: gitHead(dest) };
}

function gitHead(path: string): string | null {
  const res = spawnSync("git", ["-C", path, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

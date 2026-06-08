// src/db/repo-id.ts
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Committed, repo-root config file that carries the stable repo identity. */
export function repoIdFile(repoRoot: string): string {
  return join(repoRoot, "cortex.json");
}

/** Read the committed repo-id, or null if absent / malformed / missing key. */
export function readRepoId(repoRoot: string): string | null {
  const file = repoIdFile(repoRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { repoId?: unknown };
    return typeof parsed.repoId === "string" && parsed.repoId.length > 0
      ? parsed.repoId
      : null;
  } catch {
    return null;
  }
}

/**
 * Return the repo-id, minting and persisting a fresh UUID into `cortex.json`
 * (preserving any existing keys) when none is present. Idempotent.
 */
export function ensureRepoId(repoRoot: string): string {
  const existing = readRepoId(repoRoot);
  if (existing) return existing;

  const file = repoIdFile(repoRoot);
  let obj: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { obj = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>; }
    catch { obj = {}; }
  }
  const repoId = randomUUID();
  obj.repoId = repoId;
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
  return repoId;
}

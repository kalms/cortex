// src/mcp-server/beacon-target.ts
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalRepoPath } from "../db/git-root.js";

/** The checkout a beacon belongs to, resolved against the registry. */
export interface BeaconTarget {
  /** Registry name — becomes the event envelope's `project_id`. */
  name: string;
  /** The registry row's `root_path` — becomes the payload's `repo_path`. */
  root_path: string;
}

/** The slice of `Registry` this module needs; keeps the resolver trivially
 *  fakeable and free of a better-sqlite3 dependency in consumers' types. */
export interface BeaconRegistry {
  findByRootPath(root_path: string): { name: string; root_path: string } | null;
  list(): Array<{ name: string; root_path: string }>;
}

/** Realpath when the path exists, else the absolute literal. Mirrors
 *  `canonicalRepoPath`'s never-throw contract. */
function realpathOrSelf(p: string): string {
  const trimmed = p.replace(/\/+$/, "") || "/";
  try {
    return realpathSync(trimmed);
  } catch {
    return resolve(trimmed);
  }
}

/** Registry lookup tolerant of the symlink mismatch between how a path was
 *  registered and how it was posted (macOS `/var` vs `/private/var`, and the
 *  reverse). Two point lookups first; the linear scan runs only when both miss,
 *  which is the reject path — never the hot path. */
function findByPath(registry: BeaconRegistry, p: string): BeaconTarget | null {
  const real = realpathOrSelf(p);
  const direct = registry.findByRootPath(real) ?? registry.findByRootPath(p);
  if (direct) return { name: direct.name, root_path: direct.root_path };
  const scanned = registry.list().find((r) => realpathOrSelf(r.root_path) === real);
  return scanned ? { name: scanned.name, root_path: scanned.root_path } : null;
}

/**
 * Which registered checkout owns a beacon's `repo_path`, or null when none does.
 *
 * Two axes, in order (see decision `D-d5k3`):
 *   1. **Checkout** — the posted path itself. A linked worktree is a first-class
 *      registry row, so a per-thread worktree resolves to itself and its own
 *      graph, which is what the beacon's repo-relative refs were resolved against.
 *   2. **Repo identity** — `canonicalRepoPath`, which collapses subdirs and
 *      worktrees to the main checkout root. Catches a beacon posted from a
 *      subdirectory, and a worktree with no row of its own.
 *
 * Null is the reject signal: the route answers `{accepted:false}` and emits
 * nothing, so a beacon from a repo Cortex has never indexed is dropped quietly —
 * the same property the previous single-home-repo gate provided.
 */
export function resolveBeaconTarget(
  repoPath: string,
  registry: BeaconRegistry,
): BeaconTarget | null {
  const onCheckout = findByPath(registry, repoPath);
  if (onCheckout) return onCheckout;

  const canonical = canonicalRepoPath(repoPath);
  if (canonical === repoPath) return null;   // nothing new to try
  return findByPath(registry, canonical);
}

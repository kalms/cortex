import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { mainWorktreeRoot } from "./git-root.js";
import type { Registry, RegistryRepo } from "./registry.js";

export interface OrphanEntry {
  name: string;
  root_path: string;
  /** The canonical git root this entry should have collapsed to. */
  canonical: string;
}

type Entry = Pick<RegistryRepo, "name" | "root_path" | "worktree_of">;

/** The canonical root an entry SHOULD live at, or null when it is already
 *  canonical (a real git root, or a supported non-git project). A non-null
 *  return means the entry is an orphan — a subdir or worktree that collapses
 *  elsewhere under the canonical-rooting model.
 *
 *  Carve-out (anticipated by D-b248): a linked worktree is now a legitimate,
 *  first-class registry entry, not an orphan collapse target — but only when
 *  it actually holds its own store. A worktree row that declares
 *  `worktree_of` but has no (or an empty/aborted) `.cortex/db` is still a
 *  stale collapse target and must stay an orphan. A subdirectory can never
 *  qualify for the carve-out: `worktreeRoot()` collapses subdirs to their
 *  enclosing checkout, so nothing ever indexes a subdir in its own right and
 *  nothing ever writes it a `worktree_of` pointer — the check below is
 *  structurally unreachable for a subdir, not a special case bolted on top. */
function orphanCanonical(entry: Entry): string | null {
  const root = mainWorktreeRoot(entry.root_path);
  if (root === null) return null; // non-git project — supported, keep
  let real: string;
  try {
    real = realpathSync(entry.root_path);
  } catch {
    return null; // path gone — handled by findDeadEntries, not here
  }
  if (real === root) return null;

  if (entry.worktree_of && statSize(join(entry.root_path, ".cortex", "db")) > 0) return null;

  return root;
}

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function isOrphanEntry(entry: Entry): boolean {
  return orphanCanonical(entry) !== null;
}

export function findOrphans(entries: Entry[]): OrphanEntry[] {
  const out: OrphanEntry[] = [];
  for (const e of entries) {
    const canonical = orphanCanonical(e);
    if (canonical) out.push({ name: e.name, root_path: e.root_path, canonical });
  }
  return out;
}

export function findDeadEntries(entries: Entry[]): Entry[] {
  return entries.filter((e) => !existsSync(e.root_path));
}

export function pruneEntries(registry: Registry, names: string[]): void {
  for (const name of names) registry.remove(name);
}

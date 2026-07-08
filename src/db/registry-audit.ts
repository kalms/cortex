import { existsSync, realpathSync } from "node:fs";
import { mainWorktreeRoot } from "./git-root.js";
import type { Registry, RegistryRepo } from "./registry.js";

export interface OrphanEntry {
  name: string;
  root_path: string;
  /** The canonical git root this entry should have collapsed to. */
  canonical: string;
}

type Entry = Pick<RegistryRepo, "name" | "root_path">;

/** The canonical root an entry SHOULD live at, or null when it is already
 *  canonical (a real git root, or a supported non-git project). A non-null
 *  return means the entry is an orphan — a subdir or worktree that collapses
 *  elsewhere under the canonical-rooting model. */
function orphanCanonical(entry: Entry): string | null {
  const root = mainWorktreeRoot(entry.root_path);
  if (root === null) return null; // non-git project — supported, keep
  let real: string;
  try {
    real = realpathSync(entry.root_path);
  } catch {
    return null; // path gone — handled by findDeadEntries, not here
  }
  return real === root ? null : root;
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

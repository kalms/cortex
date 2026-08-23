/**
 * Fold linked-checkout rows under their canonical parent so `list_projects`
 * shows one entry per repo instead of one per worktree. Under the two-axis
 * model a worktree is a first-class project, but a flat listing buries the
 * repo you care about under per-thread slugs like
 * `Users-rka--mesh-worktrees-d21a6e6c-composer-cortex`.
 *
 * A row whose parent is absent from `rows` stays top-level — never drop a row
 * just because its parent was not registered.
 */
export function groupCheckouts<T extends { root_path: string; worktree_of?: string | null }>(
  rows: T[],
): Array<T & { worktrees: T[] }> {
  const byPath = new Map(rows.map((r) => [r.root_path, r]));
  const out: Array<T & { worktrees: T[] }> = [];
  const index = new Map<string, T & { worktrees: T[] }>();

  for (const r of rows) {
    if (r.worktree_of && byPath.has(r.worktree_of)) continue; // attached below
    const entry = { ...r, worktrees: [] as T[] };
    out.push(entry);
    index.set(r.root_path, entry);
  }
  for (const r of rows) {
    if (!r.worktree_of) continue;
    index.get(r.worktree_of)?.worktrees.push(r);
  }
  return out;
}

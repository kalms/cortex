/** Friendly display ids: D-<seq> / T-<seq>, canonical id fallback. */
export function decisionDisplayId(d: { seq?: number | null; id: string }): string {
  return d.seq != null ? `D-${d.seq}` : d.id;
}
export function todoDisplayId(t: { seq?: number | null; id: string }): string {
  return t.seq != null ? `T-${t.seq}` : t.id;
}

/** Display name for a project: basename of root_path, falling back to the
 *  raw slug (name) when root_path is absent — e.g. legacy/pre-migration rows. */
export function projectDisplayName(p: { name: string; root_path?: string | null }): string {
  if (!p.root_path) return p.name;
  const parts = p.root_path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p.name;
}

/** Friendly display ids: D-<seq> / T-<seq>, canonical id fallback. */
export function decisionDisplayId(d: { seq?: number | null; id: string }): string {
  return d.seq != null ? `D-${d.seq}` : d.id;
}
export function todoDisplayId(t: { seq?: number | null; id: string }): string {
  return t.seq != null ? `T-${t.seq}` : t.id;
}

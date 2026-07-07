/** Friendly display ids: D-<seq> / T-<seq>, canonical id fallback. */
export function decisionDisplayId(d: { seq?: number | null; id: string }): string {
  return d.seq != null ? `D-${d.seq}` : d.id;
}
export function todoDisplayId(t: { seq?: number | null; id: string }): string {
  return t.seq != null ? `T-${t.seq}` : t.id;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

/** Absolute clock format, e.g. "January 21, 2026 2:34pm". */
function absoluteDate(d: Date): string {
  let h = d.getHours();
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${h}:${mm}${ampm}`;
}

/** Relative time for recent record timestamps ("1 min ago", "2 days ago"),
 *  falling back to an absolute clock ("January 21, 2026 2:34pm") once the
 *  gap reaches 3 days. Returns "" for empty input and the raw string for an
 *  unparseable one, so callers can pass proposedAt straight through. */
export function formatRelativeDate(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  if (day >= 3) return absoluteDate(d);
  if (day >= 1) return `${day} day${day === 1 ? "" : "s"} ago`;
  if (hr >= 1) return `${hr} hr${hr === 1 ? "" : "s"} ago`;
  if (min >= 1) return `${min} min${min === 1 ? "" : "s"} ago`;
  return "just now";
}

/** Display name for a project: basename of root_path, falling back to the
 *  raw slug (name) when root_path is absent — e.g. legacy/pre-migration rows. */
export function projectDisplayName(p: { name: string; root_path?: string | null }): string {
  if (!p.root_path) return p.name;
  const parts = p.root_path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p.name;
}

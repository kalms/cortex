import { fuzzyScore } from "./fuzzy";
import { decisionDisplayId, todoDisplayId } from "../display";

export type IndexEntry = {
  group: "actions" | "stories" | "frames" | "files" | "symbols" | "decisions" | "todos";
  label: string; sublabel: string; haystack: string; ref: any;
};
const GROUP_ORDER: IndexEntry["group"][] = ["actions", "stories", "frames", "files", "symbols", "decisions", "todos"];
const SYMBOL_KINDS = new Set(["function", "class", "method", "interface", "type", "route"]);

export function buildSearchIndex(bundle: any, _projects: any[], stories: any[] = []): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const s of stories)
    out.push({ group: "stories", label: `${s.id} · ${s.title}`,
      sublabel: `${s.stepCount} steps · ${s.status}`,
      haystack: `${s.id} ${s.title}`, ref: { kind: "story", id: s.id } });
  for (const f of bundle.frames)
    out.push({ group: "frames", label: f.name, sublabel: f.layer || "frame",
      haystack: f.name, ref: { kind: "frame", id: f.id } });
  for (const n of bundle.rawNodes) {
    if (n.kind === "file" && n.file_path)
      out.push({ group: "files", label: n.name, sublabel: n.file_path,
        haystack: n.file_path, ref: { kind: "file", path: n.file_path } });
    else if (SYMBOL_KINDS.has(n.kind) && n.file_path)
      out.push({ group: "symbols", label: n.name, sublabel: `${n.kind} · ${n.file_path}`,
        haystack: `${n.name} ${n.file_path}`, ref: { kind: "symbol", name: n.name, path: n.file_path } });
  }
  for (const d of bundle.decisions)
    out.push({ group: "decisions", label: `${decisionDisplayId(d)} · ${d.summary}`,
      sublabel: d.state, haystack: `${decisionDisplayId(d)} ${d.summary}`,
      ref: { kind: "decision", id: d.id } });
  for (const t of bundle.allTodos)
    out.push({ group: "todos", label: `${todoDisplayId(t)} · ${t.summary}`,
      sublabel: t.state, haystack: `${todoDisplayId(t)} ${t.summary}`,
      ref: { kind: "todo", id: t.id } });
  return out;
}

/** Returns one array per non-empty group, in GROUP_ORDER, each sorted by score desc, capped. */
export function searchIndex(entries: IndexEntry[], query: string, limitPerGroup = 5): IndexEntry[][] {
  const scored = entries
    .map((e) => ({ e, s: fuzzyScore(query, e.haystack) }))
    .filter((x) => x.s > 0);
  return GROUP_ORDER
    .map((g) => scored.filter((x) => x.e.group === g)
      .sort((a, b) => b.s - a.s).slice(0, limitPerGroup).map((x) => x.e))
    .filter((g) => g.length > 0);
}

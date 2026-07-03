const CONN_RELATIONS = new Set(["CALLS", "IMPORTS"]);
const SYMBOL_KINDS = new Set(["function", "class", "method", "interface", "type", "variable", "route"]);
const TOP_N = 8;

export function fileCardData(bundle: any, path: string) {
  const byId = new Map(bundle.rawNodes.map((n: any) => [n.id, n]));
  const fileNode = bundle.rawNodes.find((n: any) => n.kind === "file" && n.file_path === path) ?? null;
  const frameId = bundle.framePathIndex?.get?.(path) ?? null;
  const frame = frameId ? bundle.frames.find((f: any) => f.id === frameId) ?? null : null;

  const inCounts = new Map<string, number>(), outCounts = new Map<string, number>();
  let fanIn = 0, fanOut = 0;
  const coChange: { path: string }[] = [];
  if (fileNode) for (const e of bundle.rawEdges) {
    const isIn = e.target === fileNode.id, isOut = e.source === fileNode.id;
    if (!isIn && !isOut) continue;
    const other: any = byId.get(isIn ? e.source : e.target);
    const otherPath = other?.file_path;
    if (CONN_RELATIONS.has(e.relation) && otherPath && otherPath !== path) {
      const m = isIn ? inCounts : outCounts;
      m.set(otherPath, (m.get(otherPath) || 0) + 1);
      isIn ? fanIn++ : fanOut++;
    } else if (e.relation === "FILE_CHANGES_WITH" && otherPath && otherPath !== path) {
      if (!coChange.some((c) => c.path === otherPath)) coChange.push({ path: otherPath });
    }
  }
  const top = (m: Map<string, number>) => [...m.entries()]
    .map(([p, count]) => ({ path: p, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)).slice(0, TOP_N);

  const symbols = bundle.rawNodes
    .filter((n: any) => n.file_path === path && SYMBOL_KINDS.has(n.kind))
    .map((n: any) => ({ kind: n.kind, name: n.name, id: n.id }))
    .sort((a: any, b: any) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  const governsPath = (ent: any) => (ent.governs || []).some((g: any) => g.path === path);
  return {
    path, frameId, frameName: frame?.name ?? null, layer: frame?.layer ?? null,
    fanIn, fanOut, coChange,
    symbols, connectionsIn: top(inCounts), connectionsOut: top(outCounts),
    decisions: bundle.decisions.filter(governsPath),
    todos: bundle.allTodos.filter(governsPath),
  };
}

/** Resolve a todo for the drawer: ambient (live) → allTodos (incl. closed) → removed snapshot.
 *  isRemoved is true ONLY for the snapshot case — closed todos are not "removed". */
export function resolveTodo(
  ambient: Record<string, any>,
  allTodos: any[] | undefined,
  removed: Record<string, any>,
  id: string,
): { todo: any | null; isRemoved: boolean } {
  const live = ambient[id];
  if (live) return { todo: live, isRemoved: false };
  const closed = (allTodos || []).find((t) => t.id === id);
  if (closed) return { todo: closed, isRemoved: false };
  const snap = removed[id];
  return snap ? { todo: snap, isRemoved: true } : { todo: null, isRemoved: false };
}

import type { GraphStore } from "../graph/store.js";
import { deriveModule } from "./module-path.js";
import { CODE_KINDS, type HotspotArea, type HotspotOpts } from "./types.js";

/**
 * Rank source modules by external inbound fan-in (distinct CALLS/IMPORTS source
 * nodes from outside the module). `nodes` and `governing_paths` are display
 * annotations only — the sort key is fan-in. Deterministic.
 */
export function computeHotspots(
  store: GraphStore,
  project: string,
  governedPaths: string[] = [],
  opts: HotspotOpts = {},
): HotspotArea[] {
  const limit = opts.limit ?? 12;

  const nodeRows = store.queryRaw<{ id: string; file_path: string | null; kind: string }>(
    `SELECT id, file_path, kind FROM nodes WHERE project = ?`,
    [project],
  );
  const moduleOf = new Map<string, string>();
  const nodeCount = new Map<string, number>();
  for (const r of nodeRows) {
    const mod = deriveModule(r.file_path);
    if (!mod) continue;
    moduleOf.set(r.id, mod);
    if (CODE_KINDS.has(r.kind)) nodeCount.set(mod, (nodeCount.get(mod) ?? 0) + 1);
  }

  const edgeRows = store.queryRaw<{ source_id: string; target_id: string }>(
    `SELECT DISTINCT source_id, target_id FROM edges
       WHERE project = ? AND relation IN ('CALLS','IMPORTS')`,
    [project],
  );
  const callers = new Map<string, Set<string>>();
  for (const e of edgeRows) {
    const tgt = moduleOf.get(e.target_id);
    if (!tgt) continue;
    if (moduleOf.get(e.source_id) === tgt) continue; // intra-module
    let set = callers.get(tgt);
    if (!set) { set = new Set(); callers.set(tgt, set); }
    set.add(e.source_id);
  }

  const decisions = new Map<string, number>();
  for (const p of governedPaths) {
    const mod = deriveModule(p);
    if (mod) decisions.set(mod, (decisions.get(mod) ?? 0) + 1);
  }

  const areas: HotspotArea[] = [];
  for (const mod of new Set([...nodeCount.keys(), ...callers.keys()])) {
    areas.push({
      module: mod.includes("/") ? mod.slice(mod.lastIndexOf("/") + 1) : mod,
      path: mod,
      in_edges: callers.get(mod)?.size ?? 0,
      nodes: nodeCount.get(mod) ?? 0,
      governing_paths: decisions.get(mod) ?? 0,
    });
  }
  areas.sort((a, b) =>
    b.in_edges - a.in_edges || b.nodes - a.nodes || a.path.localeCompare(b.path));
  return areas.slice(0, limit);
}

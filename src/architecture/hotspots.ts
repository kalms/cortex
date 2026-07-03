import type { GraphStore } from "../graph/store.js";
import { deriveModule } from "./module-path.js";
import type { Governance, GovernanceRef } from "./governed.js";
import { CODE_KINDS, type HotspotArea, type HotspotOpts } from "./types.js";

const EMPTY_GOVERNANCE: Governance = { decisions: [], todos: [] };

/** Bucket governance refs by module → set of DISTINCT governing-entity ids. */
function bucketByModule(refs: GovernanceRef[]): Map<string, Set<string>> {
  const byMod = new Map<string, Set<string>>();
  for (const { id, ref } of refs) {
    const mod = deriveModule(ref);
    if (!mod) continue;
    let set = byMod.get(mod);
    if (!set) { set = new Set(); byMod.set(mod, set); }
    set.add(id);
  }
  return byMod;
}

/**
 * Rank source modules by external inbound fan-in (distinct CALLS/IMPORTS source
 * nodes from outside the module). `nodes`, `governing_decisions` (distinct active
 * decisions) and `open_todos` (distinct non-terminal todos) are display
 * annotations only — the sort key is fan-in. Deterministic.
 */
export function computeHotspots(
  store: GraphStore,
  project: string,
  governance: Governance = EMPTY_GOVERNANCE,
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

  const decisionsByMod = bucketByModule(governance.decisions);
  const todosByMod = bucketByModule(governance.todos);

  const areas: HotspotArea[] = [];
  for (const mod of new Set([...nodeCount.keys(), ...callers.keys()])) {
    areas.push({
      module: mod.includes("/") ? mod.slice(mod.lastIndexOf("/") + 1) : mod,
      path: mod,
      in_edges: callers.get(mod)?.size ?? 0,
      nodes: nodeCount.get(mod) ?? 0,
      governing_decisions: decisionsByMod.get(mod)?.size ?? 0,
      open_todos: todosByMod.get(mod)?.size ?? 0,
    });
  }
  areas.sort((a, b) =>
    b.in_edges - a.in_edges || b.nodes - a.nodes || a.path.localeCompare(b.path));
  return areas.slice(0, limit);
}

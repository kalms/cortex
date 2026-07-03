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
 * Rank source modules by a composite hotspot score: external inbound fan-in
 * (dependency risk), distinct active governing decisions, and distinct open
 * todos — each max-normalized to 0–1 across the modules, then weighted-summed
 * (equal weight by default) and scaled to 0–100. `nodes` is an annotation only,
 * not scored. Deterministic: ties break on fan-in, then module path.
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
      score: 0, // filled in below once per-signal maxima are known
      in_edges: callers.get(mod)?.size ?? 0,
      nodes: nodeCount.get(mod) ?? 0,
      governing_decisions: decisionsByMod.get(mod)?.size ?? 0,
      open_todos: todosByMod.get(mod)?.size ?? 0,
    });
  }

  // Composite score: max-normalize each signal to 0–1, weighted-sum, scale to 0–100.
  const { fanIn = 1, decisions = 1, todos = 1 } = opts.weights ?? {};
  const wSum = fanIn + decisions + todos || 1;
  const maxIn = areas.reduce((m, a) => Math.max(m, a.in_edges), 0) || 1;
  const maxDec = areas.reduce((m, a) => Math.max(m, a.governing_decisions), 0) || 1;
  const maxTodo = areas.reduce((m, a) => Math.max(m, a.open_todos), 0) || 1;
  for (const a of areas) {
    const composite =
      (fanIn * (a.in_edges / maxIn) +
        decisions * (a.governing_decisions / maxDec) +
        todos * (a.open_todos / maxTodo)) / wSum;
    a.score = Math.round(composite * 100);
  }

  areas.sort((a, b) =>
    b.score - a.score || b.in_edges - a.in_edges || a.path.localeCompare(b.path));
  return areas.slice(0, limit);
}

import type { GraphStore } from "../graph/store.js";
import { computeHotspots } from "../architecture/hotspots.js";
import { loadGovernance } from "../architecture/governed.js";
import { entrypoints } from "./entrypoints.js";
import { formatOnboarding } from "./format.js";

export function composeOnboarding(deps: {
  store: GraphStore; project: string; root: string;
}): { headline: string } {
  const { store, project, root } = deps;
  const hotspots = computeHotspots(store, project, loadGovernance(root));
  const files = store.queryRaw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM nodes WHERE project = ? AND kind = 'file'`, [project])[0]?.n ?? 0;
  const nodes = store.queryRaw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM nodes WHERE project = ?`, [project])[0]?.n ?? 0;
  const edges = store.queryRaw<{ n: number }>(
    `SELECT COUNT(*) AS n FROM edges WHERE project = ?`, [project])[0]?.n ?? 0;
  const eps = entrypoints(root, store, project);
  return { headline: formatOnboarding({ files, nodes, edges, hotspots, entrypoints: eps }) };
}

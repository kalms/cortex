/**
 * Client-side LOD projection for the 2D viewer.
 *
 * Takes the full graph state + UX inputs (zoom, focus, filters, search) and
 * returns the visible set + synthesized groups + (possibly aggregate) edges.
 *
 * The projection is the sole authority for what the simulation and renderer
 * see. Everything is derived from the raw state — server protocol unchanged.
 */

import { derivePathGroups, deriveTerritories, pathGroupId } from './groups.js';
import { edgeKey } from './state.js';
import { supernodeDims } from './sizing.js';

/**
 * Band table — structure-primary. Depth-2 dir supernodes form the backbone
 * at overview; decisions are always visible and positioned via governance
 * gravity (see layout.js) near their territories.
 *
 * dirDepth = max filesystem depth of emitted dir groups. Dir groups deeper
 * than dirDepth collapse up into their depth-`dirDepth` ancestor.
 */
export const BAND_TABLE = [
  { maxZoom: 0.4, visibleKinds: new Set(['decision']),
    dirDepth: 2, emitDirGroups: true, emitFileGroups: false, emitLeafFiles: false },
  { maxZoom: 1.0, visibleKinds: new Set(['decision']),
    dirDepth: 3, emitDirGroups: true, emitFileGroups: false, emitLeafFiles: false },
  { maxZoom: 2.0, visibleKinds: new Set(['decision', 'file']),
    dirDepth: Infinity, emitDirGroups: false, emitFileGroups: true, emitLeafFiles: true },
  { maxZoom: Infinity,
    visibleKinds: new Set(['decision', 'file', 'function', 'component',
      'reference', 'path', 'variable', 'section', 'type', 'project']),
    dirDepth: Infinity, emitDirGroups: false, emitFileGroups: false, emitLeafFiles: true },
];

function bandFor(zoom) {
  for (const b of BAND_TABLE) {
    if (zoom < b.maxZoom) return b;
  }
  return BAND_TABLE[BAND_TABLE.length - 1];
}

/**
 * Pure projection function — sole authority for what the simulation and
 * renderer see. Reads full state + UX inputs, returns visible nodes/edges
 * and synthesized groups (path aggregations + decision territories).
 *
 * inputs: { zoom, focus, filters, search }
 *   focus:    null | { root, depth }
 *   filters:  Set<kind> — kind filter from the UI checkboxes
 *   search:   lowercase string; empty = no search
 *
 * Output:
 *   visibleNodes: Map<id, node | groupRepresentative>
 *   visibleEdges: Map<key, edge | aggregateEdge>
 *   groups:       Array<groupSpec>   (for hull / territory rendering)
 *
 * @param state {{ nodes: Map, edges: Map }}
 * @param inputs {{ zoom, focus, filters, search }}
 * @returns {{ visibleNodes: Map, visibleEdges: Map, groups: Array }}
 */
export function project(state, inputs) {
  const { zoom, focus, filters, search } = inputs;
  const band = bandFor(zoom);

  const allNodes = [...state.nodes.values()];
  const allEdges = [...state.edges.values()];

  // Precompute focus neighborhood once per call (O(E) build, O(1) lookup).
  let focusNeighbors = null;
  if (focus) {
    focusNeighbors = new Set([focus.root]);
    if (focus.depth >= 1) {
      for (const e of allEdges) {
        if (e.source_id === focus.root) focusNeighbors.add(e.target_id);
        else if (e.target_id === focus.root) focusNeighbors.add(e.source_id);
      }
    }
  }

  // Derive groups once per call.
  const pathGroups = derivePathGroups(allNodes, { depth: band.dirDepth });
  const territories = deriveTerritories(allNodes, allEdges);

  const groupById = new Map(pathGroups.map((g) => [g.id, g]));

  // Build lookup: leaf id → ancestor group id (its file group, or dir group).
  // Each leaf sits in at most one file group (if applicable) and one dir
  // group; we pick the closest (file > dir).
  const leafAncestor = new Map();
  for (const g of pathGroups) {
    if (g.kind !== 'dir') continue;
    for (const m of g.members) leafAncestor.set(m, g.id);
  }
  for (const g of pathGroups) {
    if (g.kind !== 'file') continue;
    for (const m of g.members) leafAncestor.set(m, g.id);
  }

  // Determine which groups to emit as visible supernodes.
  // derivePathGroups was called with { depth: band.dirDepth }, so all dir groups
  // in pathGroups are already capped to the correct depth — emit all of them.
  const emittedGroupIds = new Set();
  if (band.emitDirGroups) {
    for (const g of pathGroups) {
      if (g.kind === 'dir') emittedGroupIds.add(g.id);
    }
  }
  if (band.emitFileGroups) {
    for (const g of pathGroups) {
      if (g.kind === 'file') emittedGroupIds.add(g.id);
    }
  }

  // Resolve each leaf to the *nearest emitted* supernode ancestor (walk up
  // the path tree). If none of its ancestors are emitted, the leaf has no
  // supernode and surfaces directly (subject to band visibility).
  const leafEmittedAncestor = new Map();
  for (const n of allNodes) {
    if (n.kind === 'decision') continue;
    let cur = leafAncestor.get(n.id);
    while (cur && !emittedGroupIds.has(cur)) {
      const g = groupById.get(cur);
      cur = g ? parentPathGroupIdFromSpec(g, groupById) : null;
    }
    if (cur) leafEmittedAncestor.set(n.id, cur);
  }

  // ---- Decide which leaf nodes are visible ----
  const visibleLeafIds = new Set();

  for (const n of allNodes) {
    if (!filters.has(n.kind) && n.kind !== 'decision') continue;
    if (focus && !focusNeighbors.has(n.id)) continue;

    // Decisions are always visible (when not filtered out).
    if (n.kind === 'decision') {
      visibleLeafIds.add(n.id);
      continue;
    }

    // If a supernode ancestor is emitted, the leaf folds into it.
    if (leafEmittedAncestor.has(n.id)) continue;

    // Otherwise the leaf must be in the band's visible kind set.
    if (!band.visibleKinds.has(n.kind)) continue;
    if (n.kind === 'file' && !band.emitLeafFiles) continue;
    visibleLeafIds.add(n.id);
  }

  // Search force-visible: any node whose name matches, plus its ancestor path.
  // Matched leaves surface by un-emitting their ancestor group chain.
  if (search) {
    const q = String(search).toLowerCase();
    for (const n of allNodes) {
      if (!filters.has(n.kind) && n.kind !== 'decision') continue;
      if (focus && !focusNeighbors.has(n.id)) continue;
      if (!nameMatches(n, q)) continue;
      visibleLeafIds.add(n.id);
      // Un-emit every ancestor group covering this leaf so the leaf doesn't
      // stay hidden behind them.
      let ancestor = leafAncestor.get(n.id);
      while (ancestor) {
        emittedGroupIds.delete(ancestor);
        const g = groupById.get(ancestor);
        ancestor = g ? parentPathGroupIdFromSpec(g, groupById) : null;
      }
      leafEmittedAncestor.delete(n.id);
    }
    // Rebuild leafEmittedAncestor now that some groups may have been un-emitted,
    // so edge representative resolution reflects the new set.
    leafEmittedAncestor.clear();
    for (const n of allNodes) {
      if (n.kind === 'decision') continue;
      if (visibleLeafIds.has(n.id)) continue;
      let cur = leafAncestor.get(n.id);
      while (cur && !emittedGroupIds.has(cur)) {
        const g = groupById.get(cur);
        cur = g ? parentPathGroupIdFromSpec(g, groupById) : null;
      }
      if (cur) leafEmittedAncestor.set(n.id, cur);
    }
  }

  // ---- Assemble visibleNodes: leaves + emitted group representatives ----
  const visibleNodes = new Map();
  for (const id of visibleLeafIds) visibleNodes.set(id, state.nodes.get(id));

  for (const id of emittedGroupIds) {
    const g = groupById.get(id);
    if (!g) continue;
    const label = labelFor(g);
    const dims = supernodeDims(label);
    // Group representative: synthetic node with id === g.id.
    visibleNodes.set(g.id, {
      id: g.id,
      kind: 'group',
      name: label,
      groupKind: g.kind,          // 'dir' or 'file'
      members: g.members,
      memberCount: g.memberCount,
      dirPath: g.dirPath,
      filePath: g.filePath,
      boxW: dims.w,
      boxH: dims.h,
      radius: dims.radius,
      // x/y filled in by syncSimulation's inherit-from-centroid logic later.
    });
  }

  // ---- Edges: emit raw or aggregate ----
  const representative = (leafId) => {
    if (visibleNodes.has(leafId)) return leafId;
    const a = leafEmittedAncestor.get(leafId);
    if (a && visibleNodes.has(a)) return a;
    return null;
  };

  const visibleEdges = new Map();
  const aggBuckets = new Map();   // key → { source_id, target_id, count, relations: Map<rel, n> }

  for (const e of allEdges) {
    const srcRep = representative(e.source_id);
    const tgtRep = representative(e.target_id);
    if (!srcRep || !tgtRep) continue;
    if (srcRep === tgtRep) continue;  // edge collapsed onto a single representative; drop

    if (srcRep === e.source_id && tgtRep === e.target_id) {
      // Pass-through raw edge.
      visibleEdges.set(edgeKey(e), e);
    } else {
      // Aggregate.
      const key = `agg:${srcRep}→${tgtRep}`;
      if (!aggBuckets.has(key)) {
        aggBuckets.set(key, {
          aggregate: true,
          source_id: srcRep,
          target_id: tgtRep,
          count: 0,
          relations: new Map(),
        });
      }
      const b = aggBuckets.get(key);
      b.count += 1;
      b.relations.set(e.relation, (b.relations.get(e.relation) ?? 0) + 1);
    }
  }

  for (const [key, b] of aggBuckets) {
    const relationEntries = [...b.relations.entries()].sort((x, y) => y[1] - x[1]);
    const majority = relationEntries[0][0];
    visibleEdges.set(key, {
      aggregate: true,
      source_id: b.source_id,
      target_id: b.target_id,
      count: b.count,
      relation: majority,
      relations: Object.fromEntries(relationEntries),
    });
  }

  // ---- Territories: overlay groups — returned for hull rendering, not
  // emitted as visible nodes. ----
  const visibleTerritories = territories.filter((t) =>
    t.members.some((m) => visibleNodes.has(m) || visibleNodes.has(leafAncestor.get(m) ?? '')),
  );

  return {
    visibleNodes,
    visibleEdges,
    groups: [...pathGroups.filter((g) => emittedGroupIds.has(g.id)), ...visibleTerritories],
  };
}

/**
 * True iff the visible node or edge id sets differ between projections.
 * Used to gate sim reheat — pure visual changes (size at current zoom)
 * are not considered interesting.
 */
export function projectionDeltaIsInteresting(previous, current) {
  if (!previous) return true;
  if (previous.visibleNodes.size !== current.visibleNodes.size) return true;
  if (previous.visibleEdges.size !== current.visibleEdges.size) return true;
  for (const k of current.visibleNodes.keys()) {
    if (!previous.visibleNodes.has(k)) return true;
  }
  for (const k of current.visibleEdges.keys()) {
    if (!previous.visibleEdges.has(k)) return true;
  }
  return false;
}

// ---- helpers ----

function nameMatches(node, query) {
  return (node.name && node.name.toLowerCase().includes(query))
      || (node.qualified_name && node.qualified_name.toLowerCase().includes(query));
}

function labelFor(group) {
  if (group.kind === 'dir') {
    const parts = group.dirPath.split('/');
    return parts[parts.length - 1] + '/';
  }
  if (group.kind === 'file') {
    const parts = (group.filePath ?? '').split('/');
    return parts[parts.length - 1];
  }
  return group.id;
}

/**
 * Parent group id for a derived group spec, within the derived set.
 * For a dir group, walks the directory path up until it finds an emitted
 * dir group (or returns null). For a file group, walks up the file's
 * directory chain.
 */
function parentPathGroupIdFromSpec(g, groupById) {
  if (g.kind === 'dir') {
    return nearestDirAncestor(g.dirPath, new Set(
      [...groupById.values()].filter((x) => x.kind === 'dir').map((x) => x.id),
    ));
  }
  if (g.kind === 'file') {
    // file group's parent: walk its dirPath up through the dir-group set.
    if (!g.dirPath) return null;
    const dirIds = new Set(
      [...groupById.values()].filter((x) => x.kind === 'dir').map((x) => x.id),
    );
    // Check the dir itself first, then walk up.
    const own = pathGroupId(g.dirPath);
    if (dirIds.has(own)) return own;
    return nearestDirAncestor(g.dirPath, dirIds);
  }
  return null;
}

/**
 * Nearest strict ancestor dir-group id of `dirPath`, or null.
 */
function nearestDirAncestor(dirPath, dirGroupIds) {
  const parts = dirPath.split('/');
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join('/');
    const pid = pathGroupId(ancestor);
    if (dirGroupIds.has(pid)) return pid;
  }
  return null;
}

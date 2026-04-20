/**
 * Group derivation for the 2D viewer's projection layer.
 *
 * Two group sources:
 *   a) path hierarchy — derived from `file_path` on each leaf node. A directory
 *      with 2+ members becomes a group; singletons collapse up. Files with
 *      owned functions (via qualified_name prefix match) also get a group so
 *      the projection can treat "contains children" uniformly.
 *   b) decision-governance territories — each decision's outgoing GOVERNS set.
 *      Rendered as a translucent convex hull overlay, cutting across paths.
 *
 * All group IDs are deterministic from source: same graph → same ids → same
 * positions across reloads. Nothing persisted.
 */

export function pathGroupId(dirPath) {
  return `group:path:${dirPath}`;
}

export function territoryId(decisionId) {
  return `group:decision:${decisionId}`;
}

export function parentPathGroupId(dirPath) {
  const idx = dirPath.lastIndexOf('/');
  if (idx <= 0) return null;
  return pathGroupId(dirPath.slice(0, idx));
}

/**
 * derivePathGroups(nodes) → Array<GroupSpec>
 *
 * Groups are of two shapes:
 *   - directory group:  { id, kind: 'dir',  dirPath, members: [nodeIds], memberCount }
 *   - file group:       { id, kind: 'file', dirPath, filePath, members: [fnIds], memberCount }
 *
 * A file node is included in its dir's group (as a member), AND if it has
 * child function/reference nodes, those are grouped under a file-kind group
 * so the projection can fold functions into the file.
 */
export function derivePathGroups(nodes, opts = {}) {
  const maxDepth = opts.depth ?? Infinity;
  const groups = new Map();   // id → group spec

  // Bucket leaves by their file_path's dir, and file → children.
  const dirMembers = new Map();   // dirPath → Set<nodeId>
  const fileMembers = new Map();  // filePath → Set<nodeId>

  for (const n of nodes) {
    if (n.kind === 'decision') continue;  // top-level, never in a path group

    // Extract a file path this node is associated with.
    // Prefer file_path for file kind; qualified_name (when it encodes a file
    // path via `::` separator) for functions/refs; fall back to file_path
    // for anything else that has one (components, variables, sections, paths).
    let ownerFilePath = null;
    if (n.kind === 'file' && n.file_path) {
      ownerFilePath = n.file_path;
    } else if (n.qualified_name) {
      ownerFilePath = qualifiedNameFile(n.qualified_name);
    }
    if (!ownerFilePath && n.file_path) {
      ownerFilePath = n.file_path;
    }
    if (!ownerFilePath) continue;

    // Bucket under the owning file (for file-group aggregation).
    if (n.kind !== 'file') {
      if (!fileMembers.has(ownerFilePath)) fileMembers.set(ownerFilePath, new Set());
      fileMembers.get(ownerFilePath).add(n.id);
    }

    // Bucket under the directory (for dir-group aggregation). Every non-decision
    // node with an owning file path contributes to its dir's group count.
    const rawDir = dirOf(ownerFilePath);
    if (rawDir !== null) {
      const dir = capToDepth(rawDir, maxDepth);
      if (!dirMembers.has(dir)) dirMembers.set(dir, new Set());
      dirMembers.get(dir).add(n.id);
    }
  }

  // Directory groups: keep only those with 2+ members.
  for (const [dir, memberSet] of dirMembers) {
    if (memberSet.size < 2) continue;
    const id = pathGroupId(dir);
    groups.set(id, {
      id,
      kind: 'dir',
      dirPath: dir,
      members: [...memberSet].sort(),
      memberCount: memberSet.size,
    });
  }

  // File groups: files that own functions/references.
  for (const [filePath, memberSet] of fileMembers) {
    if (memberSet.size === 0) continue;
    const id = pathGroupId(filePath);
    groups.set(id, {
      id,
      kind: 'file',
      dirPath: dirOf(filePath) ?? '',
      filePath,
      members: [...memberSet].sort(),
      memberCount: memberSet.size,
    });
  }

  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * deriveTerritories(nodes, edges) → Array<TerritorySpec>
 *   { id, kind: 'territory', decisionId, members: [nodeIds], memberCount }
 *
 * A decision with zero GOVERNS targets produces no territory.
 */
export function deriveTerritories(nodes, edges) {
  const decisions = new Set(nodes.filter((n) => n.kind === 'decision').map((n) => n.id));
  const territories = new Map();   // decisionId → Set<memberId>

  for (const e of edges) {
    if (e.relation !== 'GOVERNS') continue;
    if (!decisions.has(e.source_id)) continue;
    if (!territories.has(e.source_id)) territories.set(e.source_id, new Set());
    territories.get(e.source_id).add(e.target_id);
  }

  const out = [];
  for (const [decisionId, memberSet] of territories) {
    if (memberSet.size === 0) continue;
    out.push({
      id: territoryId(decisionId),
      kind: 'territory',
      decisionId,
      members: [...memberSet].sort(),
      memberCount: memberSet.size,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ---- helpers ----

function dirOf(path) {
  if (!path) return null;
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return null;
  return path.slice(0, idx);
}

function capToDepth(dirPath, maxDepth) {
  if (!Number.isFinite(maxDepth)) return dirPath;
  const parts = dirPath.split('/');
  if (parts.length <= maxDepth) return dirPath;
  return parts.slice(0, maxDepth).join('/');
}

function qualifiedNameFile(qn) {
  const idx = qn.indexOf('::');
  if (idx < 0) return null;
  return qn.slice(0, idx);
}

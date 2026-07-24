// src/viewer/adapters.js
/**
 * Pure helpers for transforming live API data into shapes the viewer's
 * canvas-drawing code consumes.
 */

/** Parse data into a plain object whether it arrives as JSON string or object. */
function parseData(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Group file nodes by data.frame_id.
 * Returns: [{ frame_id, frame_label, member_count, members: NodeRow[] }]
 *  sorted by frame_id asc.
 */
export function groupNodesIntoFrames(nodes) {
  const byFrame = new Map();
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    const data = parseData(n.data);
    if (typeof data.frame_id !== "number") continue;
    if (!byFrame.has(data.frame_id)) {
      byFrame.set(data.frame_id, {
        frame_id: data.frame_id,
        frame_label: typeof data.frame_label === "string" ? data.frame_label : `frame:${data.frame_id}`,
        members: [],
      });
    }
    byFrame.get(data.frame_id).members.push(n);
  }
  const out = [];
  for (const f of byFrame.values()) {
    out.push({
      frame_id: f.frame_id,
      frame_label: f.frame_label,
      member_count: f.members.length,
      members: f.members,
    });
  }
  out.sort((a, b) => a.frame_id - b.frame_id);
  return out;
}

/**
 * Frame-coverage summary for a project's nodes.
 *
 * `zeroFrames` is true when the graph has file nodes but NONE carry a numeric
 * `frame_id` — the signature of a graph built by the raw C indexer (which
 * skips the TS frame-extraction pass) rather than via `cortex index` / the MCP
 * `index_repository` tool. A project with no file nodes at all (unindexed /
 * empty) is NOT flagged. Mirrors `groupNodesIntoFrames`' file-node + parseData
 * handling so the two never disagree about what counts as "framed".
 * Returns: { fileNodes, framedNodes, zeroFrames }.
 */
export function frameCoverage(nodes) {
  let fileNodes = 0;
  let framedNodes = 0;
  for (const n of nodes) {
    if (n.kind !== "file") continue;
    fileNodes++;
    const data = parseData(n.data);
    if (typeof data.frame_id === "number") framedNodes++;
  }
  return { fileNodes, framedNodes, zeroFrames: fileNodes > 0 && framedNodes === 0 };
}

/** First N basenames from a list of nodes' file_path values. */
export function basenames(nodes, limit) {
  const out = [];
  for (const n of nodes) {
    if (!n.file_path) continue;
    const i = n.file_path.lastIndexOf("/");
    out.push(i >= 0 ? n.file_path.slice(i + 1) : n.file_path);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Generalized governance rollup: { [frameIdStr]: entityId[] } from any list of
 * items with `.id` and a `.governs[]` carrying `kind: 'frame'` refs. Deduped,
 * insertion order preserved. Used for both decisions and TODOs.
 */
export function buildGovernance(entities) {
  const out = {};
  for (const e of entities || []) {
    for (const g of e.governs || []) {
      if (g.kind !== "frame") continue;
      if (!out[g.id]) out[g.id] = [];
      if (!out[g.id].includes(e.id)) out[g.id].push(e.id);
    }
  }
  return out;
}

/** Decision frame-governance (kept as a named wrapper so callers don't churn). */
export function buildFrameGovernance(decisions) {
  return buildGovernance(decisions);
}

/** { [decisionId]: todoId[] } from each todo's `spawnsFrom` (null ignored). */
export function buildSpawnsFromIndex(todos) {
  const out = {};
  for (const t of todos || []) {
    const parent = t.spawnsFrom;
    if (!parent) continue;
    if (!out[parent]) out[parent] = [];
    if (!out[parent].includes(t.id)) out[parent].push(t.id);
  }
  return out;
}

/** Ambient canvas excludes closed work; done/cancelled are drawer/search-only. */
export function filterAmbientTodos(todos) {
  return (todos || []).filter((t) => t.state !== "done" && t.state !== "cancelled");
}

const TODO_YELLOW = [250, 204, 21];
const TODO_AMBER = [245, 158, 11];

/** Pure state -> dot color. `in_progress` returns the yellow base; the draw
 *  layer substitutes the assignee identity color when one is available. */
export function todoDotColor(state) {
  // Return fresh arrays — never the shared module constants — so a draw-layer
  // caller that blends an assignee color in place can't corrupt them for later calls.
  return { rgb: [...TODO_YELLOW], ring: state === "blocked" ? [...TODO_AMBER] : null };
}

// Default footprint (stage px) for a promoted frame when the frame-map carries
// no size for it.
const PROMOTED_FRAME_W = 150;
const PROMOTED_FRAME_H = 120;

/**
 * Ensure every decision-governed frame is actually rendered.
 *
 * Reachability fallback for decision-governed frames the server did not
 * position. Non-ambient frames are normally server-positioned (gravity-centroid
 * placement, D-bj3n) and rendered de-emphasized by the caller, so a governed
 * frame is almost always already in the rendered set. The rare exception — a
 * governed frame with no server position at all (no frame-pair ties, or the
 * degenerate zero-ambient case) — would otherwise be undrawn, hiding its
 * decision's governance pills (this is why cortex-indexer's two non-ambient
 * governed frames once didn't show). This appends any such still-missing
 * governed frame in a de-emphasized bottom margin so its decision keeps an
 * on-screen anchor; the renderer clamps it fully on-screen.
 *
 * Pure: returns a NEW array (existing frames first, then any appended
 * fallbacks). `frameMeta` is `Map<frameIdStr, {name,w,h,count,layer}>` over ALL
 * frames. Guarantees reachability, not optimal placement (no longer a top strip).
 */
export function withGovernedFramesRendered(ambientFrames, frameGovernance, frameMeta) {
  const present = new Set(ambientFrames.map((f) => String(f.id)));
  const missing = Object.keys(frameGovernance || {}).filter((id) => !present.has(String(id)));
  if (missing.length === 0) return ambientFrames;

  const meta = frameMeta || new Map();
  const n = missing.length;
  const promoted = missing.map((id, i) => {
    const m = meta.get(String(id)) || {};
    return {
      id: String(id),
      name: m.name || `frame ${id}`,
      // Bottom-right margin band; renderer clamps to keep on-screen.
      x: n === 1 ? 0.9 : 0.1 + (0.8 * i) / (n - 1),
      y: 0.93,
      w: m.w || PROMOTED_FRAME_W,
      h: m.h || PROMOTED_FRAME_H,
      count: m.count || 0,
      layer: m.layer,
      promotedForGovernance: true,
      deemphasized: true,
    };
  });
  return [...ambientFrames, ...promoted];
}

/**
 * Build a `file_path → frameIdStr` lookup from grouped frame summaries
 * (the `groupNodesIntoFrames` shape; `members[].file_path`). Frame ids are
 * stringified to match `FRAMES[].id`. Used to associate a decision's
 * file-governed path with the frame that actually CONTAINS that file — i.e.
 * cluster membership — rather than guessing from the frame's display label.
 */
export function buildFramePathIndex(summaries) {
  const byPath = new Map();
  for (const s of summaries || []) {
    const sid = String(s.frame_id);
    for (const m of s.members || []) {
      if (m && m.file_path) byPath.set(m.file_path, sid);
    }
  }
  return byPath;
}

/**
 * Resolve the frame id (string) that owns a decision-governed path:
 *   1. exact file membership, else
 *   2. the frame of any member sitting under `path/` (directory-level
 *      governance — a decision that governs a whole directory).
 * Returns null when nothing matches. Deliberately does NOT fall back to
 * label resemblance: a frame label is a topical summary, not a real path
 * prefix, so matching `path.startsWith(label + '/')` produced false
 * associations (especially now that labels can contain `/`).
 */
export function frameIdForPath(index, path) {
  if (!index || !path) return null;
  const exact = index.get(path);
  if (exact !== undefined) return exact;
  const prefix = path.endsWith("/") ? path : path + "/";
  for (const [fp, sid] of index) {
    if (fp.startsWith(prefix)) return sid;
  }
  return null;
}

/** Quick membership check: does an edge between (a,b) exist? */
export function edgesInternalIndex(edges) {
  const set = new Set();
  for (const e of edges) {
    set.add(`${e.source_id}::${e.target_id}`);
  }
  return set;
}

/** Resolve presence refs (paths, "path::symbol" qns, decision/todo ids) to frame ids.
 *  Decision/todo ids have no frame anchor and are skipped; unresolvable paths drop. */
export function frameIdsForRefs(pathIndex, refs) {
  const out = [];
  for (const ref of refs) {
    if (/^[DT]-/.test(ref)) continue;
    const path = ref.includes("::") ? ref.split("::")[0] : ref;
    const fid = frameIdForPath(pathIndex, path);
    if (fid != null && !out.includes(fid)) out.push(fid);
  }
  return out;
}

/**
 * Partition spotlight refs into frame ids, decision ids, todo ids, and unresolved paths.
 *
 * Unlike `frameIdsForRefs`, which skips D-/T- refs and silently drops unresolvable paths,
 * `partitionSpotlightRefs` captures them:
 *   - D-* refs → decisionIds (verbatim, deduped)
 *   - T-* refs → todoIds (verbatim, deduped)
 *   - Path refs (with :: suffix stripped like `frameIdsForRefs`) → frameIds if resolved via
 *     `frameIdForPath`, or unresolved if no frame matches
 *
 * Returns: { frameIds: string[], decisionIds: string[], todoIds: string[], unresolved: string[] }
 * Insertion order preserved within each bucket; all deduped.
 */
export function partitionSpotlightRefs(pathIndex, refs) {
  const frameIds = [];
  const decisionIds = [];
  const todoIds = [];
  const unresolved = [];

  for (const ref of refs || []) {
    if (ref.startsWith("D-")) {
      if (!decisionIds.includes(ref)) decisionIds.push(ref);
    } else if (ref.startsWith("T-")) {
      if (!todoIds.includes(ref)) todoIds.push(ref);
    } else {
      // Path ref: strip :: suffix and resolve via frameIdForPath
      const path = ref.includes("::") ? ref.split("::")[0] : ref;
      const fid = frameIdForPath(pathIndex, path);
      if (fid != null) {
        if (!frameIds.includes(fid)) frameIds.push(fid);
      } else {
        if (!unresolved.includes(path)) unresolved.push(path);
      }
    }
  }

  return { frameIds, decisionIds, todoIds, unresolved };
}

/** The path (not qn) of the FIRST ref that resolves to a frame — i.e. the ref
 *  anchoring `frameIdsForRefs(...)[0]`, the session's traversal target. Used to
 *  target the presence cursor at that file's actual dot (dot-level approach)
 *  when the dot is currently drawn. null when no ref resolves. */
export function primaryRefPath(pathIndex, refs) {
  for (const ref of refs || []) {
    if (/^[DT]-/.test(ref)) continue;
    const path = ref.includes("::") ? ref.split("::")[0] : ref;
    if (frameIdForPath(pathIndex, path) != null) return path;
  }
  return null;
}

/** Undirected frame adjacency from inter-frame pairs [{a, b}]. */
export function buildFrameAdjacency(pairs) {
  const adj = new Map();
  const add = (x, y) => {
    if (!adj.has(x)) adj.set(x, new Set());
    adj.get(x).add(y);
  };
  for (const { a, b } of pairs) {
    if (a == null || b == null || a === b) continue;
    add(String(a), String(b)); add(String(b), String(a));
  }
  return adj;
}

/** Shortest frame-to-frame path (inclusive). [] when unreachable/unknown. */
export function frameBfsPath(adj, fromId, toId) {
  if (fromId === toId) return fromId == null ? [] : [fromId];
  if (!adj.has(fromId) || !adj.has(toId)) return [];
  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of adj.get(cur) ?? []) {
      if (prev.has(nxt)) continue;
      prev.set(nxt, cur);
      if (nxt === toId) {
        const path = [toId];
        for (let p = cur; p != null; p = prev.get(p)) path.unshift(p);
        return path;
      }
      queue.push(nxt);
    }
  }
  return [];
}

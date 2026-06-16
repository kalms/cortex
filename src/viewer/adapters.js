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
 * Build the FRAME_GOVERNANCE shape: { [frameIdStr]: decisionId[] }.
 * Sources from decisions[].governs[].kind === 'frame' refs.
 */
export function buildFrameGovernance(decisions) {
  const out = {};
  for (const d of decisions) {
    for (const g of d.governs || []) {
      if (g.kind !== "frame") continue;
      if (!out[g.id]) out[g.id] = [];
      if (!out[g.id].includes(d.id)) out[g.id].push(d.id);
    }
  }
  return out;
}

// Default footprint (stage px) for a promoted frame when the frame-map carries
// no size for it.
const PROMOTED_FRAME_W = 150;
const PROMOTED_FRAME_H = 120;

/**
 * Ensure every decision-governed frame is actually rendered.
 *
 * The server frame-ranking marks only the top frames `ambient` (positioned);
 * the rest are never drawn. A decision can govern a non-ambient frame (a
 * low-ranked cluster, an unnamed `cluster:N`, or a duplicate-label twin) — its
 * governance pills then have no on-screen frame to attach to, so the decision
 * is invisible (this is exactly why cortex-indexer's decisions didn't show: its
 * two governed frames were both non-ambient). A frame that carries a decision
 * is important enough to render, so promote any governed frame missing from the
 * rendered set, laid out in a reserved strip along the top (normalized x/y;
 * the renderer clamps them fully on-screen).
 *
 * Pure: returns a NEW array (ambient frames first, then promoted). `frameMeta`
 * is `Map<frameIdStr, {name,w,h,count}>` over ALL frames (ambient + not).
 *
 * NOTE: a stopgap until frames+decisions get their planned redesign (how
 * governance renders at 200+ decisions, grouping, etc.). It guarantees
 * reachability, not optimal placement.
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

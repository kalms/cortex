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

/** Quick membership check: does an edge between (a,b) exist? */
export function edgesInternalIndex(edges) {
  const set = new Set();
  for (const e of edges) {
    set.add(`${e.source_id}::${e.target_id}`);
  }
  return set;
}

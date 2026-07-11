// src/viewer/canvas/adapt.js
/** Pure data-adaptation: turns the six raw API payloads into the bundle shape
 *  `engine.setData` expects. Lives in canvas/ so the whole engine unit is
 *  vendorable without the app's fetch layer (moved verbatim from app/data.ts). */
import {
  groupNodesIntoFrames, basenames, buildFrameGovernance, withGovernedFramesRendered,
  buildFramePathIndex, frameIdForPath, buildGovernance, buildSpawnsFromIndex, filterAmbientTodos,
} from "./adapters.js";

const MAX_FRAME_NODES = 22; // keep in sync with canvas/engine.js

export function adaptProjectData({ graph, decs, aggs, fileEdges, frameMap, todosResp }) {
  const summaries = groupNodesIntoFrames(graph.nodes);
  const framePathIndex = buildFramePathIndex(summaries);
  const stage = frameMap.stage || { w: 1000, h: 800 };
  let frames = (frameMap.frames || [])
    .filter((f) => f.x !== null && f.y !== null)
    .map((f) => ({ id: String(f.id), name: f.name, x: f.x / stage.w, y: f.y / stage.h,
      w: f.w, h: f.h, count: f.count, layer: f.layer, deemphasized: !f.ambient }));
  const nodeCfg = {}, fileNames = {}, frameFilePaths = {};
  for (const s of summaries) {
    const sid = String(s.frame_id);
    const visible = s.members.slice(0, MAX_FRAME_NODES);
    nodeCfg[sid] = { count: visible.length };
    fileNames[sid] = basenames(visible, MAX_FRAME_NODES);
    frameFilePaths[sid] = visible.map((m) => m.file_path || null);
  }
  const ambientTodos = filterAmbientTodos(todosResp.todos || []);
  const ambientTodoMap = {}; for (const t of ambientTodos) ambientTodoMap[t.id] = t;
  const decisionMap = {}; for (const d of decs.decisions) decisionMap[d.id] = d;
  const frameGovernance = buildFrameGovernance(decs.decisions);
  for (const d of decs.decisions) for (const g of d.governs || []) {
    if (g.kind !== "file") continue;
    const fid = frameIdForPath(framePathIndex, g.path);
    if (!fid) continue;
    (frameGovernance[fid] ||= []).includes(d.id) || frameGovernance[fid].push(d.id);
  }
  const todoGovernance = buildGovernance(ambientTodos);
  for (const t of ambientTodos) for (const g of t.governs || []) {
    if (g.kind !== "file") continue;
    const fid = frameIdForPath(framePathIndex, g.path);
    if (!fid) continue;
    (todoGovernance[fid] ||= []).includes(t.id) || todoGovernance[fid].push(t.id);
  }
  const spawnsFrom = buildSpawnsFromIndex(todosResp.todos || []);
  const frameMeta = new Map((frameMap.frames || []).map((f) =>
    [String(f.id), { name: f.name, w: f.w, h: f.h, count: f.count, layer: f.layer }]));
  frames = withGovernedFramesRendered(frames, frameGovernance, frameMeta);
  return {
    frames, nodeCfg, fileNames, frameFilePaths, framePathIndex,
    frameGovernance, todoGovernance, spawnsFrom,
    aggregates: aggs.aggregates || [], fileEdges: fileEdges.file_edges || [],
    frameMeta, decisionMap, ambientTodoMap,
    rawNodes: graph.nodes, rawEdges: graph.edges,
    allTodos: todosResp.todos || [], decisions: decs.decisions,
    rawFrameMap: frameMap,
  };
}

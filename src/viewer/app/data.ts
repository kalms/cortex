// src/viewer/app/data.ts
/** Pure data-adaptation layer: turns the seven raw API payloads into the
 *  bundle shape `engine.setData` expects, plus the extra raw fields the
 *  drawer/palette (later tasks) and resync path need to retain.
 *
 *  `adaptProjectData` is the old `loadGraph` body between the fetches and
 *  `buildGraph()`, made pure (exact source: old viewer.js 164-246). */
import { groupNodesIntoFrames, basenames, buildFrameGovernance, withGovernedFramesRendered, buildFramePathIndex, frameIdForPath, buildGovernance, buildSpawnsFromIndex, filterAmbientTodos } from "../canvas/adapters.js";
import { fetchGraph, fetchDecisions, fetchAggregates, fetchFileEdges, fetchFrames, fetchTodos } from "./api";

const MAX_FRAME_NODES = 22; // keep in sync with canvas/engine.js

export function adaptProjectData({ graph, decs, aggs, fileEdges, frameMap, todosResp }: any) {
  const summaries = groupNodesIntoFrames(graph.nodes);
  const framePathIndex = buildFramePathIndex(summaries);
  const stage = frameMap.stage || { w: 1000, h: 800 };
  let frames = (frameMap.frames || [])
    .filter((f: any) => f.x !== null && f.y !== null)
    .map((f: any) => ({ id: String(f.id), name: f.name, x: f.x / stage.w, y: f.y / stage.h,
      w: f.w, h: f.h, count: f.count, layer: f.layer, deemphasized: !f.ambient }));
  const nodeCfg: any = {}, fileNames: any = {}, frameFilePaths: any = {};
  for (const s of summaries) {
    const sid = String(s.frame_id);
    const visible = s.members.slice(0, MAX_FRAME_NODES);
    nodeCfg[sid] = { count: visible.length };
    fileNames[sid] = basenames(visible, MAX_FRAME_NODES);
    frameFilePaths[sid] = visible.map((m: any) => m.file_path || null);
  }
  const ambientTodos = filterAmbientTodos(todosResp.todos || []);
  const ambientTodoMap: any = {}; for (const t of ambientTodos) ambientTodoMap[t.id] = t;
  const decisionMap: any = {}; for (const d of decs.decisions) decisionMap[d.id] = d;
  // Both rollups fold file-kind refs through membership (frameIdForPath), so
  // the load path agrees with the engine's live-update path (applyGovernanceFor
  // resolves file refs the same way) — a file-governed decision gets its pills,
  // anchors, and promoted frame at load, not only after its first live change.
  const frameGovernance = buildFrameGovernance(decs.decisions) as Record<string, string[]>;
  for (const d of decs.decisions) for (const g of d.governs || []) {
    if (g.kind !== "file") continue;
    const fid = frameIdForPath(framePathIndex, g.path);
    if (!fid) continue;
    (frameGovernance[fid] ||= []).includes(d.id) || frameGovernance[fid].push(d.id);
  }
  const todoGovernance = buildGovernance(ambientTodos) as Record<string, string[]>;
  for (const t of ambientTodos) for (const g of t.governs || []) {
    if (g.kind !== "file") continue;
    const fid = frameIdForPath(framePathIndex, g.path);
    if (!fid) continue;
    (todoGovernance[fid] ||= []).includes(t.id) || todoGovernance[fid].push(t.id);
  }
  const spawnsFrom = buildSpawnsFromIndex(todosResp.todos || []);
  const frameMeta = new Map((frameMap.frames || []).map((f: any) =>
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

export async function loadProject(project: string | null) {
  const [graph, decs, aggs, fileEdges, frameMap, todosResp] = await Promise.all([
    fetchGraph(project), fetchDecisions(project), fetchAggregates(project),
    fetchFileEdges(project), fetchFrames(project), fetchTodos(project),
  ]);
  return adaptProjectData({ graph, decs, aggs, fileEdges, frameMap, todosResp });
}

/** Entity-only refresh (decisions/todos changed; structure didn't): re-runs the
 *  adaptation with the ORIGINAL frameMap payload retained on the bundle, so
 *  frame positions are preserved exactly. */
export async function resyncProject(project: string | null, prevBundle: any) {
  const [decs, todosResp] = await Promise.all([fetchDecisions(project), fetchTodos(project)]);
  return adaptProjectData({
    graph: { nodes: prevBundle.rawNodes, edges: prevBundle.rawEdges },
    decs, aggs: { aggregates: prevBundle.aggregates },
    fileEdges: { file_edges: prevBundle.fileEdges },
    frameMap: prevBundle.rawFrameMap,
    todosResp,
  });
}

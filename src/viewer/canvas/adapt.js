// src/viewer/canvas/adapt.js
/** Pure data-adaptation: turns the six raw API payloads into the bundle shape
 *  `engine.setData` expects. Lives in canvas/ so the whole engine unit is
 *  vendorable without the app's fetch layer (moved verbatim from app/data.ts). */
import {
  groupNodesIntoFrames, basenames, buildFrameGovernance, withGovernedFramesRendered,
  buildFramePathIndex, frameIdForPath, buildGovernance, buildSpawnsFromIndex, filterAmbientTodos,
} from "./adapters.js";

export function adaptProjectData({ graph, decs, aggs, fileEdges, frameMap, todosResp }) {
  const summaries = groupNodesIntoFrames(graph.nodes);
  const framePathIndex = buildFramePathIndex(summaries);
  // The server sizes the stage to the frames it must hold (frame-layout
  // `stageFor`), so the stage is no longer a constant. Positions normalize by it
  // as before; SIZES are rescaled back to the 1000x800 REFERENCE stage by the
  // same uniform factor (the server preserves the aspect ratio). That keeps the
  // engine's coordinate space fixed — every downstream consumer of `w`/`h`
  // (framePxFocused, LOD, hit-testing) is unchanged, and a bigger stage simply
  // means each frame occupies a smaller share of the map, which is what a denser
  // repo should look like.
  const stage = frameMap.stage || { w: 1000, h: 800 };
  const sizeK = 1000 / stage.w;
  let frames = (frameMap.frames || [])
    .filter((f) => f.x !== null && f.y !== null)
    .map((f) => ({ id: String(f.id), name: f.name, x: f.x / stage.w, y: f.y / stage.h,
      w: f.w * sizeK, h: f.h * sizeK, count: f.count, layer: f.layer, deemphasized: !f.ambient }));
  const nodeCfg = {}, fileNames = {}, frameFilePaths = {};
  for (const s of summaries) {
    const sid = String(s.frame_id);
    // Full member lists: the engine's LOD budget decides how many draw per tick.
    nodeCfg[sid] = { count: s.members.length };
    fileNames[sid] = basenames(s.members, s.members.length);
    frameFilePaths[sid] = s.members.map((m) => m.file_path || null);
  }
  const ambientTodos = filterAmbientTodos(todosResp.todos || []);
  const ambientTodoMap = {}; for (const t of ambientTodos) ambientTodoMap[t.id] = t;
  const decisionMap = {}; for (const d of decs.decisions) decisionMap[d.id] = d;
  // Both rollups fold file-kind refs through membership (frameIdForPath), so
  // the load path agrees with the engine's live-update path (applyGovernanceFor
  // resolves file refs the same way) — a file-governed decision gets its pills,
  // anchors, and promoted frame at load, not only after its first live change.
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
    [String(f.id), { name: f.name, w: f.w * sizeK, h: f.h * sizeK, count: f.count, layer: f.layer }]));
  frames = withGovernedFramesRendered(frames, frameGovernance, frameMeta);
  return {
    frames, nodeCfg, fileNames, frameFilePaths, framePathIndex,
    frameGovernance, todoGovernance, spawnsFrom,
    // Aggregate dots are positioned in the server's stage coords too; rescale to
    // the reference stage so engine.aggregateFraction's `/ STAGE.w` still lands
    // them on the cloud rather than bunched in the top-left of a scaled stage.
    aggregates: (aggs.aggregates || []).map((a) => (
      typeof a.x === "number" && typeof a.y === "number"
        ? { ...a, x: a.x * (1000 / stage.w), y: a.y * (800 / stage.h) }
        : a
    )),
    fileEdges: fileEdges.file_edges || [],
    frameMeta, decisionMap, ambientTodoMap,
    rawNodes: graph.nodes, rawEdges: graph.edges,
    allTodos: todosResp.todos || [], decisions: decs.decisions,
    rawFrameMap: frameMap,
  };
}

// src/viewer/app/data.ts
/** Fetch orchestration for the React shell. The pure adaptation now lives in
 *  canvas/adapt.js (vendorable unit); this file re-exports it for callers. */
import { adaptProjectData } from "../canvas/adapt.js";
import { fetchGraph, fetchDecisions, fetchAggregates, fetchFileEdges, fetchFrames, fetchTodos } from "./api";

export { adaptProjectData };

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

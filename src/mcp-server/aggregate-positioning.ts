/**
 * Build positioned auxiliary aggregates: group auxiliary file paths, then place
 * each at its edge→path→margin gravity centroid relative to the frame map's
 * AMBIENT frames. Pure given (nodes, edges, frameMap) — the HTTP handler in
 * api.ts is a thin caller. (Layout slice part 2.)
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";
import type { FrameMap } from "./frame-map.js";
import { groupAuxiliaryPaths, type Aggregate } from "../frame-extraction/auxiliary-detection.js";
import { buildAggregateEdgeTies, aggregateDirs, frameRepDirs } from "./aggregate-ties.js";
import { placeAggregates } from "./floating-placement.js";

export function positionAggregates(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  frameMap: FrameMap,
): Aggregate[] {
  const paths: string[] = [];
  for (const n of nodes) if (n.kind === "file" && n.file_path) paths.push(n.file_path);
  const aggregates = groupAuxiliaryPaths(paths);
  const ambient = frameMap.frames.filter((f) => f.ambient && f.x !== null && f.y !== null);
  const ambientPositions = ambient.map((f) => ({ id: f.id, x: f.x as number, y: f.y as number }));
  const ambientBoxes = ambient.map((f) => ({ id: f.id, x: f.x as number, y: f.y as number, w: f.w as number, h: f.h as number }));
  const edgeTies = buildAggregateEdgeTies(nodes, edges);
  const dirs = aggregateDirs(paths);
  const repDirs = frameRepDirs(nodes);
  const pos = placeAggregates(aggregates, edgeTies, dirs, repDirs, ambientPositions, ambientBoxes);
  return aggregates.map((a) => {
    const p = pos.get(a.id);
    return p ? { ...a, x: p.x, y: p.y } : a;
  });
}

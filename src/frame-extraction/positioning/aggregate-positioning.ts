/**
 * Build positioned auxiliary aggregates: group auxiliary file paths, then place
 * each at its edge→path→margin gravity centroid relative to the frame map's
 * AMBIENT frames. Pure given (nodes, edges, frameMap) — the HTTP handler in
 * api.ts is a thin caller. (Layout slice part 2.)
 */
import type { NodeRow, EdgeRow } from "../../graph/store.js";
import type { FrameMap } from "./frame-map.js";
import { groupAuxiliaryPaths, type Aggregate } from "../auxiliary-detection.js";
import { buildAggregateEdgeTies, aggregateDirs, frameRepDirs } from "./aggregate-ties.js";
import { placeAggregates } from "./floating-placement.js";
import { STAGE_W, STAGE_H } from "./frame-layout.js";

export function positionAggregates(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  frameMap: FrameMap,
): Aggregate[] {
  const paths: string[] = [];
  for (const n of nodes) if (n.kind === "file" && n.file_path) paths.push(n.file_path);
  const aggregates = groupAuxiliaryPaths(paths);
  // Anchor to every POSITIONED frame, not just the ambient cut. The ambient
  // filter dates from when only ambient frames had coordinates; under the
  // full-sim layout all of them do, and keeping it meant an aggregate tied to a
  // below-the-cut frame had no eligible anchor and fell to the margin — placed
  // nowhere near the thing it actually relates to.
  const anchors = frameMap.frames.filter((f) => f.x !== null && f.y !== null);
  const anchorPositions = anchors.map((f) => ({ id: f.id, x: f.x as number, y: f.y as number }));
  const anchorBoxes = anchors.map((f) => ({ id: f.id, x: f.x as number, y: f.y as number, w: f.w as number, h: f.h as number }));
  const edgeTies = buildAggregateEdgeTies(nodes, edges);
  const dirs = aggregateDirs(paths);
  const repDirs = frameRepDirs(nodes);
  // Aggregates live in the frame map's stage, which the layout may have scaled
  // past the reference — without this they are clamped into the reference-sized
  // corner of a larger stage. `fullMap` additionally drops the cloud keep-out and
  // measures the tie-less gutter from the content bounds rather than the stage
  // bottom; both stage-relative policies strand auxiliaries once the stage is
  // sized to the frame count rather than fixed.
  const scaled = frameMap.stage.w > STAGE_W || frameMap.stage.h > STAGE_H;
  const pos = placeAggregates(aggregates, edgeTies, dirs, repDirs, anchorPositions, anchorBoxes, {
    stage: frameMap.stage,
    fullMap: scaled,
  });
  return aggregates.map((a) => {
    const p = pos.get(a.id);
    return p ? { ...a, x: p.x, y: p.y } : a;
  });
}

/**
 * Derive each auxiliary aggregate's ties to frames, for gravity-centroid
 * placement (layout slice part 2). Two tie sources, matching the spec's
 * edge→path cascade:
 *   - EDGE ties: CALLS/USAGE/IMPORTS edges between an aggregate's member files
 *     and a framed file → the aggregate tallies the connected frame.
 *   - PATH ties: an aggregate's host directory (the segment above its aux
 *     segment) matched against each frame's representative directory.
 * PURE — no I/O. Aggregate ids match `groupAuxiliaryPaths` exactly.
 */
import type { NodeRow, EdgeRow } from "../../graph/store.js";
import { DEFAULT_AUXILIARY_SEGMENTS } from "../auxiliary-detection.js";
import { ROLLUP_RELATIONS, buildNodeFrameIndex } from "./frame-pair-rollup.js";

/** First auxiliary segment index in a split path, or -1. */
function auxIndex(parts: string[], segments: ReadonlySet<string>): number {
  for (let i = 0; i < parts.length; i++) if (segments.has(parts[i]!)) return i;
  return -1;
}

/** The aggregate id for an auxiliary path — identical keying to
 *  `groupAuxiliaryPaths` (`aux:<segment>:<label>`). Returns null if non-aux. */
function aggregateIdFor(path: string, segments: ReadonlySet<string>): string | null {
  const parts = path.split("/");
  const i = auxIndex(parts, segments);
  if (i === -1) return null;
  const seg = parts[i]!;
  const label = i + 2 < parts.length ? parts[i + 1]! : seg;
  return `aux:${seg}:${label}`;
}

/** Every auxiliary file path → its aggregate id. */
export function buildAggregatePathIndex(
  paths: readonly string[],
  segments: ReadonlySet<string> = DEFAULT_AUXILIARY_SEGMENTS,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    if (!p) continue;
    const id = aggregateIdFor(p, segments);
    if (id) out.set(p, id);
  }
  return out;
}

/** Aggregate id → host directory segment (the segment ABOVE the aux segment), or
 *  "" when the aux segment is the path root. First occurrence wins (stable). */
export function aggregateDirs(
  paths: readonly string[],
  segments: ReadonlySet<string> = DEFAULT_AUXILIARY_SEGMENTS,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paths) {
    if (!p) continue;
    const parts = p.split("/");
    const i = auxIndex(parts, segments);
    if (i === -1) continue;
    const id = aggregateIdFor(p, segments)!;
    if (out.has(id)) continue;
    out.set(id, i > 0 ? parts[i - 1]! : "");
  }
  return out;
}

/** Aggregate id → (frameId → edge count). Counts CALLS/USAGE/IMPORTS edges where
 *  one endpoint is an aggregate member file and the other resolves to a frame. */
export function buildAggregateEdgeTies(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  segments: ReadonlySet<string> = DEFAULT_AUXILIARY_SEGMENTS,
): Map<string, Map<number, number>> {
  const auxPaths: string[] = [];
  for (const n of nodes) if (n.kind === "file" && n.file_path) auxPaths.push(n.file_path);
  const pathToAgg = buildAggregatePathIndex(auxPaths, segments);
  const frameByNode = buildNodeFrameIndex(nodes);
  const aggByNode = new Map<string, string>();
  for (const n of nodes) {
    if (!n.file_path) continue;
    const agg = pathToAgg.get(n.file_path);
    if (agg) aggByNode.set(n.id, agg);
  }
  const out = new Map<string, Map<number, number>>();
  const tally = (agg: string, frame: number) => {
    let m = out.get(agg);
    if (!m) { m = new Map(); out.set(agg, m); }
    m.set(frame, (m.get(frame) ?? 0) + 1);
  };
  for (const e of edges) {
    if (!ROLLUP_RELATIONS.has(e.relation)) continue;
    const aggS = aggByNode.get(e.source_id), frameT = frameByNode.get(e.target_id);
    if (aggS !== undefined && frameT !== undefined) tally(aggS, frameT);
    const aggT = aggByNode.get(e.target_id), frameS = frameByNode.get(e.source_id);
    if (aggT !== undefined && frameS !== undefined) tally(aggT, frameS);
  }
  return out;
}

/** frameId → representative directory (the most common top-level path segment of
 *  its member files; ties broken by lexical order). */
export function frameRepDirs(nodes: readonly NodeRow[]): Map<number, string> {
  const counts = new Map<number, Map<string, number>>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    let fid: number | undefined;
    try { fid = (JSON.parse(n.data) as { frame_id?: number }).frame_id; } catch { continue; }
    if (typeof fid !== "number") continue;
    const top = n.file_path.split("/")[0] ?? "";
    let m = counts.get(fid);
    if (!m) { m = new Map(); counts.set(fid, m); }
    m.set(top, (m.get(top) ?? 0) + 1);
  }
  const out = new Map<number, string>();
  for (const [fid, m] of counts) {
    const sorted = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    out.set(fid, sorted[0]![0]);
  }
  return out;
}

// src/mcp-server/frame-map.ts
/**
 * Read-time orchestrator behind `/api/frames`. Turns a project's nodes + edges
 * into the viewer's frame map: rank every frame, lay out the ambient ones.
 *
 * Nameability needs a corpus index, but the read-time graph holds no source
 * text — so each file's "blob" is its path tokens plus the names of the symbols
 * it defines (the closest available token surface). Opaque `cluster:N` labels
 * still score ~0 by construction (label-quality.ts), preserving the signal.
 *
 * Mostly pure; reads process.env.CORTEX_KIND_WEIGHT only when opts.applyKindWeight
 * is not supplied (tests pass it explicitly). Kind-weight ranking defaults ON;
 * the env var is an opt-out ("0" disables). The endpoint supplies nodes/edges.
 */
import type { NodeRow, EdgeRow } from "../graph/store.js";
import type { FileBlob } from "../frame-extraction/types.js";
import { buildCorpusIndex } from "../frame-extraction/label-quality.js";
import { splitSymbol } from "../frame-extraction/text-blob.js";
import { rankFrames, ambientBudget, type FrameRecord } from "../frame-extraction/frame-ranker.js";
import { selectAmbientByDiversity } from "../frame-extraction/frame-diversity.js";
import { rollupFramePairs } from "./frame-pair-rollup.js";
import { rollupFrameFlows } from "./frame-flow-rollup.js";
import { classifyFramesInternal, kindWeight, type FrameLayer } from "../frame-extraction/frame-kind.js";
import { layoutFrames, STAGE_W, STAGE_H } from "./frame-layout.js";

export interface FrameMapEntry {
  id: number;
  name: string;
  count: number;
  /** Integer px in virtual-stage coords; null for non-ambient (unpositioned). */
  x: number | null;
  y: number | null;
  w: number | null;
  h: number | null;
  ambient: boolean;
  rank: number;
  score: number;
  /** Architectural layer (taxonomy milestone 1). Deterministic; no internals exposed. */
  layer: FrameLayer;
}

export interface FrameMap {
  frames: FrameMapEntry[];
  stage: { w: number; h: number };
}

/** Group file nodes by frame_id into ranker input records. */
function buildFrameRecords(nodes: readonly NodeRow[]): FrameRecord[] {
  const byFrame = new Map<number, { frame_id: number; frame_label: string; member_paths: string[]; core_member_paths: string[] }>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    let d: { frame_id?: number; frame_label?: string; reclaimed?: boolean };
    try {
      d = JSON.parse(n.data);
    } catch {
      continue;
    }
    if (typeof d.frame_id !== "number") continue;
    const label = typeof d.frame_label === "string" ? d.frame_label : `frame:${d.frame_id}`;
    let rec = byFrame.get(d.frame_id);
    if (!rec) {
      rec = { frame_id: d.frame_id, frame_label: label, member_paths: [], core_member_paths: [] };
      byFrame.set(d.frame_id, rec);
    }
    rec.member_paths.push(n.file_path);
    if (d.reclaimed !== true) rec.core_member_paths.push(n.file_path);
  }
  return [...byFrame.values()].sort((a, b) => a.frame_id - b.frame_id);
}

/** One token blob per file: path tokens + the file's symbol names, split the
 *  SAME way `scoreLabel` splits labels so terms line up. */
function buildFileBlobs(nodes: readonly NodeRow[]): FileBlob[] {
  const symbolsByPath = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.file_path || n.kind === "file") continue;
    const arr = symbolsByPath.get(n.file_path) ?? [];
    arr.push(n.qualified_name || n.name);
    symbolsByPath.set(n.file_path, arr);
  }
  const blobs: FileBlob[] = [];
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    const tokens = [
      ...splitSymbol(n.file_path),
      ...(symbolsByPath.get(n.file_path) ?? []).flatMap(splitSymbol),
    ];
    blobs.push({ path: n.file_path, text: tokens.join(" ") });
  }
  return blobs;
}

export function buildFrameMap(
  nodes: readonly NodeRow[],
  edges: readonly EdgeRow[],
  opts: { applyKindWeight?: boolean; applyDiversity?: boolean } = {},
): FrameMap {
  // Kind-weight ranking is ON by default (taxonomy enable slice, observe verdict
  // positive — D-g4qb). CORTEX_KIND_WEIGHT is now an OPT-OUT: set it to "0" to
  // restore the pre-slice nameability×structural ranking.
  const applyKindWeight = opts.applyKindWeight ?? process.env.CORTEX_KIND_WEIGHT !== "0";

  const records = buildFrameRecords(nodes);
  const corpus = buildCorpusIndex(buildFileBlobs(nodes));
  const { stats } = rollupFrameFlows(nodes, edges);
  const statsById = new Map(stats.map((s) => [s.frame_id, s]));
  const kinds = classifyFramesInternal(
    records.map((r) => ({
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_paths: r.member_paths,
      fanIn: statsById.get(r.frame_id)?.fanIn ?? 0,
      fanOut: statsById.get(r.frame_id)?.fanOut ?? 0,
    })),
  );
  const kindById = new Map(kinds.map((k) => [k.frame_id, k]));
  const layerById = new Map<number, FrameLayer>(kinds.map((k) => [k.frame_id, k.layer]));

  const ranked = rankFrames(
    records.map((r) => {
      if (!applyKindWeight) return r;
      const k = kindById.get(r.frame_id);
      return k ? { ...r, kind_weight: kindWeight(k.layer, k.fallback) } : r;
    }),
    corpus,
  );

  // Layer-diversity ambient selection (taxonomy step 3b) is ON by default
  // (positive corpus observe verdict — decision D-wvsz). CORTEX_LAYER_DIVERSITY
  // is now an OPT-OUT: set it to "0" to restore the kind-weighted-only ambient
  // set (the ranker's top-budget). When off, the ambient flag is exactly what the
  // ranker set; when on, a greedy layer-aware selection overrides membership.
  const applyDiversity = opts.applyDiversity ?? process.env.CORTEX_LAYER_DIVERSITY !== "0";
  const ambientIds = applyDiversity
    ? selectAmbientByDiversity(
        ranked.map((r) => ({
          frame_id: r.frame_id,
          score: r.score,
          layer: layerById.get(r.frame_id) ?? "domain",
        })),
        ambientBudget(ranked.length),
      )
    : new Set(ranked.filter((r) => r.ambient).map((r) => r.frame_id));

  const ambient = ranked.filter((r) => ambientIds.has(r.frame_id));
  const pairs = rollupFramePairs(nodes, edges);
  const positioned = layoutFrames(
    ambient.map((r) => ({
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_count: r.member_count,
    })),
    pairs,
  );
  const posById = new Map(positioned.map((p) => [p.id, p]));

  const frames: FrameMapEntry[] = ranked.map((r) => {
    const p = posById.get(r.frame_id);
    return {
      id: r.frame_id,
      name: r.frame_label,
      count: r.member_count,
      x: p ? p.x : null,
      y: p ? p.y : null,
      w: p ? p.w : null,
      h: p ? p.h : null,
      ambient: ambientIds.has(r.frame_id),
      rank: r.rank,
      score: r.score,
      layer: layerById.get(r.frame_id) ?? "domain",
    };
  });

  return { frames, stage: { w: STAGE_W, h: STAGE_H } };
}

// src/frame-extraction/positioning/frame-map.ts
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
import type { NodeRow, EdgeRow } from "../../graph/store.js";
import type { FileBlob } from "../types.js";
import { buildCorpusIndex } from "../label-quality.js";
import { splitSymbol } from "../text-blob.js";
import { rankFrames, ambientBudget, type FrameRecord } from "../frame-ranker.js";
import { selectAmbientByDiversity } from "../frame-diversity.js";
import { rollupFramePairs } from "./frame-pair-rollup.js";
import { rollupFrameFlows } from "./frame-flow-rollup.js";
import { classifyFramesInternal, kindWeight, type FrameLayer } from "../frame-kind.js";
import {
  layoutFrames, sizeFor, stageFor, STAGE_W, STAGE_H,
  FULL_FRAME_MIN, FULL_FRAME_MAX, type Stage,
} from "./frame-layout.js";
import { rollupGovernancePairs, type GovernedRef } from "./governance-rollup.js";
import { placeNonAmbientFrames, SATELLITE_SIZE } from "./floating-placement.js";

/** Per-layer nominal sink for the layout's vertical force, used ONLY for frames
 *  with no measured inter-frame flow (the categorical fallback). Surface→substrate
 *  order; domain mid-band. Frames that HAVE flows use their measured sink ratio. */
const NOMINAL_SINK: Record<FrameLayer, number> = {
  interface: 0.1,
  orchestration: 0.3,
  domain: 0.5,
  data: 0.7,
  infrastructure: 0.9,
  ceremony: 0.97,
};

export interface FrameMapEntry {
  id: number;
  name: string;
  count: number;
  /** Integer px in virtual-stage coords. Ambient frames: force-sim position.
   *  Non-ambient frames: gravity-centroid satellite position (layout slice
   *  part 2). null only in degenerate cases (a frame the placement couldn't
   *  position at all). */
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
  opts: {
    applyKindWeight?: boolean; applyDiversity?: boolean; applyLayout?: boolean; applyFullSim?: boolean;
    /** GOVERNS links (decisions + todos) for the governance force. Omitted →
     *  the force is inert. Loaded by the caller (`loadGovernance`, best-effort)
     *  so this function stays pure over the graph. */
    governance?: readonly GovernedRef[];
  } = {},
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

  // Layer-adjacency layout force (taxonomy layout slice). Default ON (opt-out
  // via CORTEX_LAYER_LAYOUT=0) since the 0.8.22 observe pass — every corpus repo
  // stratified positively (Spearman(y, sink) mean ~0.77, range 0.51–0.95). When
  // off, no `sink` is attached, so layoutFrames takes the pre-slice forceCenter
  // path and positions are byte-identical. When on, each ambient frame gets an
  // effective sink: measured (fanIn/(fanIn+fanOut)) when it has flows, else the
  // layer's NOMINAL_SINK. The env read lives here; the layout module stays
  // layer-agnostic (it only sees a number).
  const applyLayout = opts.applyLayout ?? process.env.CORTEX_LAYER_LAYOUT !== "0";
  const effectiveSink = (frame_id: number): number => {
    const st = statsById.get(frame_id);
    const flow = (st?.fanIn ?? 0) + (st?.fanOut ?? 0);
    if (flow > 0) return st!.fanIn / flow;
    return NOMINAL_SINK[layerById.get(frame_id) ?? "domain"];
  };

  // Full-sim placement: run EVERY frame through the force layout, not just the
  // ambient set. The ambient cut stays exactly as it is — it now decides
  // EMPHASIS (frame size, and the viewer's `deemphasized` styling) rather than
  // doubling as the decision of who gets a real position. Ranking, extraction,
  // and placement become three separable layers, extending the split
  // frame-ranking-design.md already drew between extraction count and ambient
  // render count.
  //
  // Why: the ambient budget is capped at 10 (max(4, min(10, ceil(n*0.7)))), so a
  // 120-frame repo sent 110 frames down the satellite path. That path seeds each
  // satellite at its ambient-partner centroid, which for most frames falls INSIDE
  // the ambient cloud and is then projected onto the keep-out box boundary —
  // collapsing a 2-D placement onto a 1-D perimeter (86 of 110 onto one edge).
  // The cap was never a performance limit (D-pzc8 cites the "readable-map
  // budget"; 120 frames measures at ~170ms, inside its own sub-second bar), so
  // the sim can simply take everyone.
  //
  // Opt-out via CORTEX_FULL_SIM=0, which restores the ambient-only layout plus
  // the satellite path verbatim.
  const applyFullSim = opts.applyFullSim ?? process.env.CORTEX_FULL_SIM !== "0";
  const forLayout = applyFullSim ? ranked : ambient;

  // Size encodes MEMBER COUNT, for every frame, on one wide band.
  //
  // It used to encode emphasis instead — ambient frames took the 110–160 band,
  // everything else a flat 84 — which threw the member-count signal away below
  // the cut and made the map read as one uniform square repeated 110 times. It
  // also inverted: a 74-member frame rendered at 84px next to a 6-member frame
  // at 110px.
  //
  // Emphasis has its own channel and always did — the `ambient` flag reaches the
  // viewer as `deemphasized` and drives opacity/label prominence. Size and
  // emphasis are now orthogonal: size says how much code, emphasis says how much
  // narrative weight, and the two read together instead of fighting for one
  // channel.
  const allCounts = forLayout.map((r) => r.member_count);
  const minAll = allCounts.length ? Math.min(...allCounts) : 0;
  const maxAll = allCounts.length ? Math.max(...allCounts) : 0;
  const sizeOf = (r: { frame_id: number; member_count: number }): number =>
    sizeFor(r.member_count, minAll, maxAll, FULL_FRAME_MIN, FULL_FRAME_MAX);

  // Stage scales with the frames it must hold, so occupancy stays at the density
  // the reference 10-frame layout reads well at instead of saturating. Small
  // repos clamp to the reference stage → byte-identical to today.
  const stage: Stage = applyFullSim
    ? stageFor(forLayout.map(sizeOf))
    : { w: STAGE_W, h: STAGE_H };

  const positioned = layoutFrames(
    forLayout.map((r) => ({
      frame_id: r.frame_id,
      frame_label: r.frame_label,
      member_count: r.member_count,
      ...(applyFullSim ? { size: sizeOf(r) } : {}),
      ...(applyLayout ? { sink: effectiveSink(r.frame_id) } : {}),
    })),
    pairs,
    stage,
    // Governance force (frame-layout-design.md force 4). Inert when the caller
    // supplies no governance — every existing caller stays byte-identical.
    opts.governance ? rollupGovernancePairs(nodes, opts.governance) : [],
  );
  const posById = new Map(positioned.map((p) => [p.id, p]));

  // Floating placement (layout slice part 2): position the NON-ambient frames at
  // the pair-weighted centroid of the ambient frames they connect to, so they
  // drift near related content instead of an arbitrary strip. Ambient positions
  // (above) are untouched — byte-identical to the pre-slice output.
  //
  // Dead under full-sim: every frame already has a simulated position, so there
  // is nothing left to float. Skipped rather than run-and-discard (it is O(n²)
  // per separation sweep).
  const floatPos = applyFullSim
    ? new Map<number, { x: number; y: number }>()
    : placeNonAmbientFrames(
        ranked.filter((r) => !ambientIds.has(r.frame_id)).map((r) => ({ frame_id: r.frame_id })),
        pairs,
        positioned.map((p) => ({ id: p.id, x: p.x, y: p.y })),
        positioned.map((p) => ({ id: p.id, x: p.x, y: p.y, w: p.w, h: p.h })),
      );

  const frames: FrameMapEntry[] = ranked.map((r) => {
    const p = posById.get(r.frame_id);
    // `ambient` is the emphasis flag (the ranker's cut), NOT "has a position" —
    // under full-sim every frame is positioned, including below-the-cut ones.
    const isAmbient = ambientIds.has(r.frame_id);
    if (p) {
      return {
        id: r.frame_id, name: r.frame_label, count: r.member_count,
        x: p.x, y: p.y, w: p.w, h: p.h,
        ambient: isAmbient, rank: r.rank, score: r.score,
        layer: layerById.get(r.frame_id) ?? "domain",
      };
    }
    const fp = floatPos.get(r.frame_id) ?? null;
    return {
      id: r.frame_id, name: r.frame_label, count: r.member_count,
      x: fp ? fp.x : null, y: fp ? fp.y : null,
      w: fp ? SATELLITE_SIZE : null, h: fp ? SATELLITE_SIZE : null,
      ambient: false, rank: r.rank, score: r.score,
      layer: layerById.get(r.frame_id) ?? "domain",
    };
  });

  return { frames, stage };
}

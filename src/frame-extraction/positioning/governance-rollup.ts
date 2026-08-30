// src/frame-extraction/positioning/governance-rollup.ts
/**
 * Roll decision/todo GOVERNS links up to frame-pair weights for the layout's
 * decision-governance force — the sixth force in `frame-layout-design.md`'s
 * table ("tertiary attractive force between frames sharing governing
 * decisions"), and the last one that was never implemented.
 *
 * Why it matters: decisions and todos carry no coordinates of their own (only
 * frames and aggregates do). They render as pills docked to the frames they
 * govern, so a decision spanning several frames is only legible as ONE decision
 * when those frames sit near each other. Nothing in the layout arranged for
 * that — co-governed frames clustered only by accident of their call graph —
 * and the wider a map spreads, the less readable the governance relation gets.
 *
 * A governed ref is a file path or a qualified name. Both resolve to a frame
 * the same way `rollupFramePairs` does it: every node carries the file_path of
 * its defining file, so ref → node → file_path → frame_id needs no traversal.
 *
 * PURE — no I/O. The caller loads governance (`loadGovernance`, best-effort) and
 * passes it in, so this module stays testable and the frame map stays pure.
 */
import type { NodeRow } from "../../graph/store.js";
import type { FramePairWeight } from "./frame-pair-rollup.js";

/** One governance link: the governing entity's id and the code ref it governs.
 *  Structurally identical to architecture/governed.ts's GovernanceRef; restated
 *  here so this module doesn't depend on the decisions layer. */
export interface GovernedRef {
  /** Decision or todo id — the grouping key. */
  id: string;
  /** Governed code ref: a file path or a qualified name. */
  ref: string;
}

/** Resolve a governed ref (path OR qualified name) to a frame_id. */
function buildRefFrameIndex(nodes: readonly NodeRow[]): Map<string, number> {
  const frameByPath = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    try {
      const d = JSON.parse(n.data) as { frame_id?: number };
      if (typeof d.frame_id === "number") frameByPath.set(n.file_path, d.frame_id);
    } catch {
      /* malformed data — skip */
    }
  }
  const byRef = new Map<string, number>();
  // File paths resolve directly.
  for (const [path, fid] of frameByPath) byRef.set(path, fid);
  // Qualified names resolve through their defining file.
  for (const n of nodes) {
    if (!n.file_path) continue;
    const fid = frameByPath.get(n.file_path);
    if (fid === undefined) continue;
    if (n.qualified_name) byRef.set(n.qualified_name, fid);
  }
  return byRef;
}

/**
 * Aggregate GOVERNS links into deterministic frame-pair weights: for each
 * governing entity, every pair of DISTINCT frames it touches gets +1.
 *
 * Weight is therefore "how many decisions/todos span this pair of frames" —
 * not how many refs, so a decision governing 30 files in two frames counts once
 * for that pair rather than swamping the force.
 *
 * An entity governing refs in a single frame contributes no pair (nothing to
 * pull together). Refs that don't resolve to a frame are dropped.
 */
export function rollupGovernancePairs(
  nodes: readonly NodeRow[],
  governed: readonly GovernedRef[],
): FramePairWeight[] {
  const frameByRef = buildRefFrameIndex(nodes);

  // id → the distinct set of frames it governs.
  const framesByEntity = new Map<string, Set<number>>();
  for (const g of governed) {
    const fid = frameByRef.get(g.ref);
    if (fid === undefined) continue;
    let s = framesByEntity.get(g.id);
    if (!s) { s = new Set(); framesByEntity.set(g.id, s); }
    s.add(fid);
  }

  const weights = new Map<string, number>();
  // Sort the entity ids so accumulation order is input-independent (determinism).
  for (const id of [...framesByEntity.keys()].sort()) {
    const frames = [...framesByEntity.get(id)!].sort((x, y) => x - y);
    if (frames.length < 2) continue; // single-frame decision: nothing to attract
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const key = `${frames[i]}:${frames[j]}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
  }

  const out: FramePairWeight[] = [];
  for (const [key, weight] of weights) {
    const sep = key.indexOf(":");
    out.push({ a: Number(key.slice(0, sep)), b: Number(key.slice(sep + 1)), weight });
  }
  out.sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b);
  return out;
}

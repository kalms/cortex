// scripts/frame-extraction/dump-frame-kind-inputs.ts
/**
 * One-shot fixture generator: pull nodes+edges from a RUNNING cortex viewer's
 * /api/graph, derive FrameKindInput[] exactly the way buildFrameMap does, and
 * print JSON to stdout. Usage:
 *   npx tsx scripts/frame-extraction/dump-frame-kind-inputs.ts \
 *     > tests/fixtures/frame-layers/cortex-frames.json
 * Requires `npm run dev` (or the MCP plugin server) serving localhost:3334/3333.
 */
import { rollupFrameFlows } from "../../src/frame-extraction/positioning/frame-flow-rollup.js";
import type { NodeRow, EdgeRow } from "../../src/graph/store.js";

const BASE = process.env.CORTEX_API ?? "http://localhost:3333";

async function main() {
  const r = await fetch(`${BASE}/api/graph`);
  if (!r.ok) throw new Error(`GET /api/graph → ${r.status}`);
  const { nodes, edges } = (await r.json()) as { nodes: NodeRow[]; edges: EdgeRow[] };

  const byFrame = new Map<number, { frame_id: number; frame_label: string; member_paths: string[] }>();
  for (const n of nodes) {
    if (n.kind !== "file" || !n.file_path) continue;
    let d: { frame_id?: number; frame_label?: string };
    try { d = typeof n.data === "string" ? JSON.parse(n.data) : (n.data as object); } catch { continue; }
    if (typeof d.frame_id !== "number") continue;
    let rec = byFrame.get(d.frame_id);
    if (!rec) {
      rec = {
        frame_id: d.frame_id,
        frame_label: typeof d.frame_label === "string" ? d.frame_label : `frame:${d.frame_id}`,
        member_paths: [],
      };
      byFrame.set(d.frame_id, rec);
    }
    rec.member_paths.push(n.file_path);
  }

  const { stats } = rollupFrameFlows(nodes, edges);
  const statsById = new Map(stats.map((s) => [s.frame_id, s]));
  const inputs = [...byFrame.values()]
    .sort((a, b) => a.frame_id - b.frame_id)
    .map((rec) => ({
      ...rec,
      member_paths: [...rec.member_paths].sort(),
      fanIn: statsById.get(rec.frame_id)?.fanIn ?? 0,
      fanOut: statsById.get(rec.frame_id)?.fanOut ?? 0,
    }));
  process.stdout.write(JSON.stringify(inputs, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

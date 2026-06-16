// scripts/frame-extraction/eval-layers.ts
/**
 * Corpus-wide LAYER-classification eval (distinct from eval-all.ts, which
 * measures clustering quality). For each repo in corpus.json: clone + index +
 * cluster, derive FrameKindInput[] from the cluster result + graph flows, run
 * the layer classifier (classifyFramesInternal), and report per-repo + corpus
 * layer distributions — with special attention to the earnable-domain signal
 * (decision D-8vbv): how many frames EARN domain vs fall back, and the
 * runtimeFrac distribution of every mid-band frame (the near-miss analysis
 * that calibrates W_DOMAIN_RUNTIME's ~0.8 runtime bar).
 *
 * Git-cloned corpus projects are deregistered after the run (teardown), like
 * eval-all; local fixtures (self/cortex, anthill-cloud) are left alone.
 *
 * Usage:  tsx scripts/frame-extraction/eval-layers.ts [--only <slug>] [--keep]
 *   --out <path>   default .tmp/frame-extraction/eval-layers.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureClone } from "./clone.js";
import { callIndexer } from "./indexer.js";
import { runTfIdfHdbscan, deriveProjectName } from "../../src/frame-extraction/cluster-tfidf-hdbscan.js";
import { buildFrameAssignments, injectFrames } from "../../src/frame-extraction/inject-frames.js";
import { rollupFrameFlows } from "../../src/mcp-server/frame-flow-rollup.js";
import { classifyFramesInternal, type FrameKindInput, type FrameLayer } from "../../src/frame-extraction/frame-kind.js";
import { buildFrameMap } from "../../src/mcp-server/frame-map.js";
import { GraphStore } from "../../src/graph/store.js";
import { cachePathForProject } from "../../src/cli/context.js";
import { hasVenv } from "../../src/frame-extraction/venv.js";
import type { CorpusFile, RepoSpec } from "../../src/frame-extraction/types.js";

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const DEFAULT_OUT = join(REPO_ROOT, ".tmp", "frame-extraction", "eval-layers.json");

// Mirror frame-kind.ts's mid-band + runtime predicates (eval-only; the
// classifier keeps them private). Kept in sync deliberately for the near-miss
// analysis — these are the constants whose calibration we are measuring.
const SINK_SURFACE = 0.35, SINK_SUBSTRATE = 0.65;
const TEST_PATH_RE = /\.test\.|\.spec\.|(^|\/)tests?\//;
const NON_RUNTIME_EXT_RE = /\.(sh|ya?ml|json|md)$/;

interface FrameRow {
  label: string; layer: FrameLayer; fallback: boolean; confidence: number;
  members: number; sink: number; runtimeFrac: number; midband: boolean;
}
interface RepoRow {
  slug: string; archetype: string; primary_language: string; ok: boolean; error?: string;
  project?: string; frames?: number;
  dist?: Record<string, number>;
  earnedDomain?: number; fallbackDomain?: number;
  midbandFrames?: FrameRow[];
  entered?: string[]; left?: string[]; ambientOff?: Record<string, number>; ambientOn?: Record<string, number>;
  divEntered?: string[]; divLeft?: string[]; divAmbientOff?: Record<string, number>; divAmbientOn?: Record<string, number>;
  layoutSpearman?: number;
}

/** Spearman rank correlation between two equal-length numeric series. Returns 0
 *  for n < 2. Pure; ties get average ranks. */
function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return 0;
  const rank = (v: number[]): number[] => {
    const idx = v.map((val, i) => [val, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array(n).fill(0);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1; // average rank (1-based)
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const ax = rx[i] - mx, ay = ry[i] - my;
    num += ax * ay; dx += ax * ax; dy += ay * ay;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

function runtimeFracOf(paths: string[]): number {
  if (paths.length === 0) return 0;
  return paths.filter((p) => !TEST_PATH_RE.test(p) && !NON_RUNTIME_EXT_RE.test(p)).length / paths.length;
}

function evalRepo(repo: RepoSpec): RepoRow {
  const base: RepoRow = { slug: repo.slug, archetype: repo.archetype, primary_language: repo.primary_language, ok: false };
  try {
    const clone = ensureClone(repo);
    if (!clone.ok) return { ...base, error: `clone: ${clone.error ?? "?"}` };

    const idx = callIndexer<{ project: string; status: string; error?: string }>("index_repository", { repo_path: clone.path });
    if (!idx.ok) return { ...base, error: `index: ${idx.error_phase}: ${idx.error}` };
    const project = idx.data.project ?? deriveProjectName(resolve(clone.path));

    const graphDbPath = [cachePathForProject(project), join(clone.path, ".cortex", "db"), join(clone.path, ".cortex", "graph.db")].find((p) => existsSync(p));
    if (!graphDbPath) return { ...base, project, error: `no graph DB for ${project}` };

    const { result } = runTfIdfHdbscan({ repo_path: clone.path, project_name: project, db_path: graphDbPath });
    injectFrames({ cluster: result, project, dbPath: graphDbPath });

    const store = new GraphStore(graphDbPath, { readonly: true });
    let nodes, edges;
    try { nodes = store.getAllNodesUnified(project); edges = store.getAllEdgesUnified(project); }
    finally { store.close(); }

    const { stats } = rollupFrameFlows(nodes, edges);
    const statsById = new Map(stats.map((s) => [s.frame_id, s]));

    const byFrame = new Map<number, { label: string; paths: string[] }>();
    for (const a of buildFrameAssignments(result)) {
      let r = byFrame.get(a.frame_id);
      if (!r) { r = { label: a.frame_label, paths: [] }; byFrame.set(a.frame_id, r); }
      r.paths.push(a.file_path);
    }
    const inputs: FrameKindInput[] = [...byFrame].map(([fid, r]) => ({
      frame_id: fid, frame_label: r.label, member_paths: r.paths,
      fanIn: statsById.get(fid)?.fanIn ?? 0, fanOut: statsById.get(fid)?.fanOut ?? 0,
    }));
    const classified = classifyFramesInternal(inputs);
    const byId = new Map(inputs.map((i) => [i.frame_id, i]));

    const dist: Record<string, number> = {};
    const midbandFrames: FrameRow[] = [];
    let earnedDomain = 0, fallbackDomain = 0;
    for (const r of classified) {
      dist[r.layer] = (dist[r.layer] ?? 0) + 1;
      if (r.layer === "domain") { if (r.fallback) fallbackDomain++; else earnedDomain++; }
      const i = byId.get(r.frame_id)!;
      const total = i.fanIn + i.fanOut;
      const sink = total > 0 ? i.fanIn / total : 0.5;
      const midband = sink > SINK_SURFACE && sink < SINK_SUBSTRATE;
      if (midband) midbandFrames.push({
        label: i.frame_label, layer: r.layer, fallback: r.fallback, confidence: r.confidence,
        members: i.member_paths.length, sink, runtimeFrac: runtimeFracOf(i.member_paths), midband,
      });
    }
    const off = buildFrameMap(nodes, edges, { applyKindWeight: false });
    const on = buildFrameMap(nodes, edges, { applyKindWeight: true });
    const offAmbient = new Set(off.frames.filter((f) => f.ambient).map((f) => f.id));
    const onFrames = new Map(on.frames.map((f) => [f.id, f]));
    const onAmbient = new Set(on.frames.filter((f) => f.ambient).map((f) => f.id));
    const desc = (id: number) => { const f = onFrames.get(id)!; return `${f.name}(${f.layer})`; };
    const entered = [...onAmbient].filter((id) => !offAmbient.has(id)).map(desc);
    const left = [...offAmbient].filter((id) => !onAmbient.has(id)).map(desc);
    const ambientLayerDist = (ids: Set<number>) => {
      const d: Record<string, number> = {};
      for (const id of ids) { const l = onFrames.get(id)!.layer; d[l] = (d[l] ?? 0) + 1; }
      return d;
    };
    const ambientOff = ambientLayerDist(offAmbient), ambientOn = ambientLayerDist(onAmbient);

    // Diversity off-vs-on (kind-weight at its default ON in both — this isolates
    // the `× diversity` effect on top of the shipped baseline).
    const divOff = buildFrameMap(nodes, edges, { applyDiversity: false });
    const divOn = buildFrameMap(nodes, edges, { applyDiversity: true });
    const divOffAmbient = new Set(divOff.frames.filter((f) => f.ambient).map((f) => f.id));
    const divOnFrames = new Map(divOn.frames.map((f) => [f.id, f]));
    const divOnAmbient = new Set(divOn.frames.filter((f) => f.ambient).map((f) => f.id));
    const divDesc = (id: number) => { const f = divOnFrames.get(id)!; return `${f.name}(${f.layer})`; };
    const divEntered = [...divOnAmbient].filter((id) => !divOffAmbient.has(id)).map(divDesc);
    const divLeft = [...divOffAmbient].filter((id) => !divOnAmbient.has(id)).map(divDesc);
    const divDist = (ids: Set<number>) => {
      const d: Record<string, number> = {};
      for (const id of ids) { const l = divOnFrames.get(id)!.layer; d[l] = (d[l] ?? 0) + 1; }
      return d;
    };
    const divAmbientOff = divDist(divOffAmbient), divAmbientOn = divDist(divOnAmbient);

    // Layout off-vs-on: Spearman(y, sink) of the ambient set with the vertical
    // force ON. A strong positive value = frames stratify by surface→substrate.
    const layoutOn = buildFrameMap(nodes, edges, { applyLayout: true });
    // NOTE: for flowless frames this uses 0.5, whereas the layout's own
    // effectiveSink uses NOMINAL_SINK[layer]. So on repos with many flowless
    // frames this Spearman is a slight UNDER-estimate of the true y↔driver
    // correlation (the metric is noisier than the layout it measures).
    const sinkOf = (id: number) => {
      const s = statsById.get(id);
      const flow = (s?.fanIn ?? 0) + (s?.fanOut ?? 0);
      return flow > 0 ? s!.fanIn / flow : 0.5;
    };
    const ambientOnLayout = layoutOn.frames.filter((f) => f.ambient && f.y != null);
    const layoutSpearman = spearman(
      ambientOnLayout.map((f) => f.y as number),
      ambientOnLayout.map((f) => sinkOf(f.id)),
    );

    return { ...base, ok: true, project, frames: inputs.length, dist, earnedDomain, fallbackDomain, midbandFrames, entered, left, ambientOff, ambientOn, divEntered, divLeft, divAmbientOff, divAmbientOn, layoutSpearman };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
  const keep = argv.includes("--keep");
  const out = argv.includes("--out") ? resolve(argv[argv.indexOf("--out") + 1]!) : DEFAULT_OUT;

  if (!hasVenv()) { console.error("[eval-layers] no Python venv — run `cortex setup frames` first."); process.exit(2); }

  const corpus = JSON.parse(readFileSync(join(REPO_ROOT, "scripts", "frame-extraction", "corpus.json"), "utf-8")) as CorpusFile;
  const repos = only ? corpus.repos.filter((r) => r.slug.includes(only)) : corpus.repos;
  console.log(`[eval-layers] ${repos.length} repos`);

  const rows: RepoRow[] = [];
  for (const repo of repos) {
    console.log(`[eval-layers] → ${repo.slug} (${repo.archetype})`);
    const row = evalRepo(repo);
    rows.push(row);
    if (!row.ok) { console.log(`[eval-layers]   ✗ ${(row.error ?? "").slice(0, 140)}`); continue; }
    const earned = row.earnedDomain ?? 0, fb = row.fallbackDomain ?? 0;
    console.log(`[eval-layers]   ✓ frames=${row.frames} dist=${JSON.stringify(row.dist)} domain(earned/fallback)=${earned}/${fb}`);
    console.log(`[eval-layers]   ambient Δ: +[${(row.entered ?? []).join(", ")}] -[${(row.left ?? []).join(", ")}]  off=${JSON.stringify(row.ambientOff ?? {})} on=${JSON.stringify(row.ambientOn ?? {})}`);
    console.log(`[eval-layers]   diversity Δ: +[${(row.divEntered ?? []).join(", ")}] -[${(row.divLeft ?? []).join(", ")}]  off=${JSON.stringify(row.divAmbientOff ?? {})} on=${JSON.stringify(row.divAmbientOn ?? {})}`);
    console.log(`[eval-layers]   layout: Spearman(y, sink) on = ${(row.layoutSpearman ?? 0).toFixed(3)} (→1 = clean surface→substrate stratification)`);
    const nearMiss = (row.midbandFrames ?? []).filter((f) => f.layer === "domain" && f.fallback && f.runtimeFrac >= 0.6);
    if (nearMiss.length) console.log(`[eval-layers]     near-miss (mid-band fallback, runtimeFrac≥0.6): ${nearMiss.map((f) => `${f.label}(${f.runtimeFrac.toFixed(2)})`).join(", ")}`);
  }

  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ generated_at: null, w_domain_runtime: 0.5, rows }, null, 2));
  console.log(`[eval-layers] wrote ${out}`);

  // Teardown: deregister git-cloned corpus projects (leave local fixtures).
  if (!keep) {
    const clonedSlugs = new Set(repos.filter((r) => r.git !== null).map((r) => r.slug));
    for (const row of rows) {
      if (!row.ok || !row.project || !clonedSlugs.has(row.slug)) continue;
      const del = callIndexer("delete_project", { project: row.project });
      console.log(del.ok ? `[eval-layers]   ⌫ ${row.project}` : `[eval-layers]   ⚠ keep ${row.project}: ${del.error}`);
    }
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("eval-layers.ts");
if (isDirect) main();

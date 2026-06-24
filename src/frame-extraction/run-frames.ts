/**
 * Orchestrates the post-index frame-extraction pass in-process:
 *   co-change → HDBSCAN cluster → inject frame_id into nodes.data.
 *
 * Called from the CLI `index` command and the MCP `index_repository` tool
 * after a successful index. NEVER throws into the index path — always
 * returns a discriminated FrameResult the caller surfaces.
 *
 * Reclusters on every call (frames are a global property; see the design
 * doc). Gates: CORTEX_FRAMES≠0 and a present venv.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { hasVenv } from "./venv.js";
import { collectCoChange, writeCoChangeJsonl } from "./co-change.js";
import { collectHierarchyPairs, writeHierarchyJsonl } from "./hierarchy-affinity.js";
import { runTfIdfHdbscan } from "./cluster-tfidf-hdbscan.js";
import { injectFrames } from "./inject-frames.js";
import { reclaimNoise } from "./frame-reclamation.js";
import { GraphStore } from "../graph/store.js";

export type FrameResult =
  | { status: "ok"; framesAssigned: number; clusters: number; elapsedMs: number }
  | { status: "skipped"; reason: "venv_missing" | "disabled" | "no_files" | "no_git" }
  | { status: "failed"; reason: string };

export interface RunFrameOptions {
  repoPath: string;
  project: string;
  dbPath: string;
}

function hasFileNodes(dbPath: string, project: string): boolean {
  if (!existsSync(dbPath)) return false;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE project = ? AND kind = 'file'")
      .get(project) as { n: number };
    return row.n > 0;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export async function runFrameExtraction(opts: RunFrameOptions): Promise<FrameResult> {
  if (process.env.CORTEX_FRAMES === "0") return { status: "skipped", reason: "disabled" };
  if (!hasVenv()) return { status: "skipped", reason: "venv_missing" };
  if (!hasFileNodes(opts.dbPath, opts.project)) return { status: "skipped", reason: "no_files" };

  const start = Date.now();
  // `work` is created inside the try so even mkdtempSync failing (unwritable
  // tmpdir) returns {failed} rather than throwing into the index path — the
  // CLI caller has no outer guard, so the never-throw contract must hold here.
  let work: string | undefined;
  try {
    work = mkdtempSync(join(tmpdir(), "cortex-frames-"));
    // 1. co-change (best-effort — a repo with no git history yields no pairs).
    const ccPath = join(work, "co-change.jsonl");
    try {
      const pairs = collectCoChange({
        repo_path: opts.repoPath, since_days: 180, big_commit_threshold: 50, min_count: 2,
      });
      writeCoChangeJsonl(pairs, ccPath);
    } catch {
      // No git / git failure — proceed cold (pure topical clustering).
    }

    // 1b. hierarchy affinity (best-effort; inert when the repo has no class
    //     hierarchy — e.g. functional codebases). Gated; default on at γ=0.3.
    let hierPath: string | null = null;
    let hierGamma = 0;
    if (process.env.CORTEX_FRAME_HIERARCHY !== "0") {
      try {
        const hdb = new Database(opts.dbPath, { readonly: true });
        let pairs;
        try { pairs = collectHierarchyPairs(hdb, opts.project); } finally { hdb.close(); }
        if (pairs.length > 0) {
          hierPath = join(work, "hierarchy.jsonl");
          writeHierarchyJsonl(pairs, hierPath);
          const g = Number(process.env.CORTEX_FRAME_HIERARCHY_GAMMA);
          hierGamma = Number.isFinite(g) && g >= 0 && g <= 1 ? g : 0.3;
        }
      } catch {
        // Best-effort: a read failure just skips the hierarchy term.
        hierPath = null;
      }
    }

    // 2. cluster (spawns the venv python; reads the exact DB the index wrote).
    const { result } = runTfIdfHdbscan({
      repo_path: opts.repoPath,
      project_name: opts.project,
      db_path: opts.dbPath,
      out_path: join(work, "cluster.json"),
      co_change_path: existsSync(ccPath) ? ccPath : null,
      hierarchy_path: hierPath,
      hier_gamma: hierGamma,
    });

    // 2b. Graph reclamation — pull HDBSCAN noise files into the cluster they
    //     are most connected to via CALLS/USAGE/IMPORTS (frame-coverage spec).
    //     Best-effort: any read failure falls back to the raw cluster result
    //     (Phase 1 coverage still applies).
    let reclaimed = result;
    try {
      const store = new GraphStore(opts.dbPath, { readonly: true });
      try {
        const nodes = store.getAllNodesUnified(opts.project);
        const edges = store.getAllEdgesUnified(opts.project);
        reclaimed = reclaimNoise(result, nodes, edges);
      } finally {
        store.close();
      }
    } catch (e) {
      // Best-effort: fall back to the raw cluster result (Phase 1 coverage
      // still applies). Warn so a genuine reclamation failure isn't silent.
      console.warn(`[frames] graph reclamation skipped: ${e instanceof Error ? e.message : String(e)}`);
      reclaimed = result;
    }

    // 3. inject frame_id into the same DB.
    const framesAssigned = injectFrames({ cluster: reclaimed, project: opts.project, dbPath: opts.dbPath });
    const clusters = reclaimed.clusters.filter((c) => c.cluster_id !== -1).length;
    return { status: "ok", framesAssigned, clusters, elapsedMs: Date.now() - start };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "failed", reason: msg.split("\n")[0]!.slice(0, 200) };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

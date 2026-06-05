// scripts/frame-extraction/inject-frames.ts
/**
 * Inject frame_id + frame_label into nodes.data for the named project.
 *
 * Reads a ClusterResult JSON, picks a label per non-noise cluster, and
 * UPDATEs the nodes table for every file-kind node whose file_path
 * matches a clustered file. Files in the noise cluster (or not present
 * in the cluster at all) get their frame_* keys cleared. Idempotent.
 *
 * CLI:
 *   tsx scripts/frame-extraction/inject-frames.ts \
 *     --cluster <path-to-cluster.json> --project <name> [--db <path>]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { resolveCortexDbPath } from "../db/resolve-path.js";
import type { ClusterResult } from "./types.js";
import {
  isStructuralLabelToken,
  isDynamicSegment,
  routeParamTokens,
  pathSalience,
} from "./structural-tokens.js";

/** Stop-list of generic tokens we skip when picking a label. Lowercase.
 *  Includes monorepo-convention dirs (`apps`, `packages`), framework/route
 *  artefacts (`id`, `slug`, `params`, `dirname`), Node globals (`__dirname`,
 *  `__filename`), and tokens that describe data shape rather than topic
 *  (`data`, `meta`, `props`, `state`, `default`). */
const GENERIC_TOKENS = new Set([
  // Filesystem layout conventions
  "src", "lib", "common", "core", "main", "app", "apps", "packages",
  "modules", "pkg", "pkgs", "components", "index", "pages",
  // Organisational root dirs that group code but never name a topic. Demoted
  // in every pass (token + path-segment), consistent with the layout
  // conventions above — a `features/`-rooted cluster is labelled by its
  // deeper topical segment, not the org root.
  "feature", "features",
  // Test infrastructure
  "test", "tests",
  // Generic utility nouns
  "util", "utils", "helper", "helpers",
  // URL/route parameter tokens
  "id", "ids", "slug", "slugs", "params", "param", "name", "names", "key", "keys",
  // Runtime/JS globals
  "dirname", "__dirname", "__filename", "filename",
  // Generic data/state tokens
  "data", "meta", "metadata", "info", "default", "value", "values",
  "props", "state",
  // Generic action labels seen in components
  "refresh", "documents", "document",
  // Database schema conventions that bleed into TF-IDF from generated
  // migration files (drizzle/prisma reference "public" as the default schema)
  "public", "private",
]);

/** A token is "generic" if it's in the stop-list OR is too short (≤2 chars).
 *  Short tokens (`ds`, `db`, `ui`, `ts`, `js`, `tx`) almost always come from
 *  filename stems / domain abbreviations that don't identify a subsystem. */
function isGenericToken(token: string): boolean {
  if (!token) return true;
  if (token.length <= 2) return true;
  return GENERIC_TOKENS.has(token);
}

/** A label word is eligible only if it is not generic, not structural
 *  (route param / MVC marker / bracket), and — when member paths are
 *  available — salient across ≥50% of them. The salience gate is skipped
 *  when `memberPaths` is empty so token-only callers behave as before. */
function isLabelEligibleWord(
  word: string,
  params: ReadonlySet<string>,
  memberPaths: readonly string[],
): boolean {
  const w = word.toLowerCase();
  if (isGenericToken(w)) return false;
  if (isStructuralLabelToken(w)) return false;
  if (params.has(w)) return false;
  if (memberPaths.length > 0 && pathSalience(w, memberPaths) < 0.5) return false;
  return true;
}

/** Pick a frame label, preferring informative tokens in this order:
 *
 *   1. First bigram (or longer) where ALL words are label-eligible (non-generic,
 *      non-structural, not a route param, and salient across ≥50% of member paths).
 *      Bigrams like "design system" or "mcp server" identify subsystems more
 *      clearly than either word alone.
 *   2. First label-eligible unigram (same criteria).
 *   3. Path-prefix fallback: deepest non-generic segment of the longest
 *      common directory prefix of member paths. Catches clusters whose top
 *      tokens are all generic but whose files share a meaningful directory.
 *   4. Dominant-segment fallback: the most frequent informative path segment
 *      (directory or filename stem) shared by a STRICT majority of members,
 *      even when it is not a common prefix. Catches convention clusters —
 *      every file is `…/infrastructure/main.tf` or `modules/*​/devbox.json` —
 *      whose grouping segment TF-IDF suppresses (low IDF) and whose org roots
 *      differ so the common prefix is empty.
 *   5. `cluster:<id>` as last resort.
 *
 *  Tokens are normalised to lowercase for the stop-list check, but returned
 *  in their original form.
 */
export function pickFrameLabel(
  topTokens: readonly string[],
  memberPaths: readonly string[],
  clusterId?: number,
): string {
  const params = routeParamTokens(memberPaths);

  // Pass 1: first n-gram where every word is label-eligible.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 1 && parts.every((p) => isLabelEligibleWord(p, params, memberPaths))) {
      return token;
    }
  }

  // Pass 2: first label-eligible unigram.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 1 && isLabelEligibleWord(parts[0]!, params, memberPaths)) {
      return token;
    }
  }

  // Pass 3: path-prefix fallback.
  const prefix = commonPathSegmentLabel(memberPaths);
  if (prefix) return prefix;

  // Pass 4: dominant-segment fallback (non-prefix convention clusters).
  const dominant = dominantPathSegmentLabel(memberPaths);
  if (dominant) return dominant;

  // Pass 5: cluster id fallback.
  return `cluster:${clusterId ?? "?"}`;
}

/** Last-resort topical label for clusters whose members share an informative
 *  path segment that is NOT a common prefix — e.g. every file is
 *  `…/infrastructure/main.tf`, or `modules/*​/devbox.json`. TF-IDF suppresses
 *  such corpus-common convention segments (low IDF) so they never reach
 *  `topTokens`, and `commonPathSegmentLabel` misses them because the org root
 *  differs (`modules/…` vs `features/…`). Counts every informative segment
 *  (directory or extension-stripped filename stem) across members and returns
 *  the one shared by a STRICT majority (>50%). Ties break toward the segment
 *  that is a shared DIRECTORY in more members (a stronger topical grouping
 *  than a filename), then deeper, longer, lexicographically. Returns null
 *  when nothing characterises a majority — keeping the honest `cluster:<id>`. */
function dominantPathSegmentLabel(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const params = routeParamTokens(paths);
  interface Cand { original: string; count: number; dirCount: number; maxDepth: number }
  const cands = new Map<string, Cand>();

  for (const p of paths) {
    const parts = p.split("/").filter((s) => s.length > 0);
    if (parts.length === 0) continue;
    const last = parts.length - 1;
    const file = parts[last]!;
    // Filename stem: drop a leading dot (dotfiles like `.eslintrc`) then cut at
    // the first remaining dot so compound extensions (`backup.tar.gz`) and
    // role/ext suffixes (`devbox.json`) are both stripped to the base name.
    const base = file.startsWith(".") ? file.slice(1) : file;
    const cut = base.indexOf(".");
    const stem = cut > 0 ? base.slice(0, cut) : base;

    // Collapse repeats within this single path so each segment counts once
    // per member; remember the deepest position and whether it was a directory.
    const here = new Map<string, { original: string; depth: number; isDir: boolean }>();
    const consider = (seg: string, depth: number, isDir: boolean) => {
      if (seg.length === 0) return;
      const lower = seg.toLowerCase();
      if (isDynamicSegment(lower) || isGenericToken(lower) ||
          isStructuralLabelToken(lower) || params.has(lower)) return;
      const prev = here.get(lower);
      if (!prev) here.set(lower, { original: seg, depth, isDir });
      else here.set(lower, { original: prev.original, depth: Math.max(prev.depth, depth), isDir: prev.isDir || isDir });
    };
    for (let i = 0; i < last; i++) consider(parts[i]!, i, true);
    consider(stem, last, false);

    for (const [lower, occ] of here) {
      const c = cands.get(lower);
      if (!c) cands.set(lower, { original: occ.original, count: 1, dirCount: occ.isDir ? 1 : 0, maxDepth: occ.depth });
      else {
        c.count++;
        if (occ.isDir) c.dirCount++;
        if (occ.depth > c.maxDepth) c.maxDepth = occ.depth;
      }
    }
  }

  const total = paths.length;
  let best: Cand | null = null;
  for (const c of cands.values()) {
    if (c.count / total <= 0.5) continue; // strict majority only
    if (best === null || isStrongerCandidate(c, best)) best = c;
  }
  return best ? best.original : null;
}

/** Total order for dominant-segment candidates: more members, then shared as a
 *  directory in more members, then deeper, then longer, then lexicographic. */
function isStrongerCandidate(
  a: { count: number; dirCount: number; maxDepth: number; original: string },
  b: { count: number; dirCount: number; maxDepth: number; original: string },
): boolean {
  if (a.count !== b.count) return a.count > b.count;
  if (a.dirCount !== b.dirCount) return a.dirCount > b.dirCount;
  if (a.maxDepth !== b.maxDepth) return a.maxDepth > b.maxDepth;
  if (a.original.length !== b.original.length) return a.original.length > b.original.length;
  return a.original.toLowerCase() < b.original.toLowerCase();
}

/** Return the deepest non-generic directory segment shared by every member
 *  path. Skips bracketed segments (e.g. `[id]` from dynamic routes) and
 *  generic segments. Returns null when no informative common segment exists.
 *  Filenames (the last segment of each path) are dropped before comparison
 *  so we never label a frame after one of its files. */
function commonPathSegmentLabel(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  const splits = paths.map((p) => {
    const parts = p.split("/");
    parts.pop(); // drop filename
    return parts;
  });
  let minLen = splits[0]!.length;
  for (const s of splits) {
    if (s.length < minLen) minLen = s.length;
  }
  if (minLen === 0) return null;

  let commonDepth = 0;
  for (let i = 0; i < minLen; i++) {
    const first = splits[0]![i]!;
    if (splits.every((s) => s[i] === first)) {
      commonDepth = i + 1;
    } else {
      break;
    }
  }
  if (commonDepth === 0) return null;

  // Walk backward from the deepest common segment to find an informative one.
  // Treat bracketed segments ([id], [slug]) and generic tokens as skip-worthy.
  for (let i = commonDepth - 1; i >= 0; i--) {
    const seg = splits[0]![i]!;
    if (isDynamicSegment(seg)) continue;
    if (isGenericToken(seg.toLowerCase())) continue;
    return seg;
  }
  return null;
}

export interface FrameAssignment {
  file_path: string;
  frame_id: number;
  frame_label: string;
  frame_confidence: number;
}

export function buildFrameAssignments(cluster: ClusterResult): FrameAssignment[] {
  const topTokens = ((cluster.parameters ?? {}) as Record<string, unknown>)["top_tokens_per_cluster"] as
    | Record<string, string[]>
    | undefined ?? {};
  const out: FrameAssignment[] = [];
  for (const c of cluster.clusters) {
    if (c.cluster_id === -1) continue;
    const tokens = topTokens[String(c.cluster_id)] ?? [];
    const label = pickFrameLabel(tokens, c.member_paths, c.cluster_id);
    for (const path of c.member_paths) {
      out.push({
        file_path: path,
        frame_id: c.cluster_id,
        frame_label: label,
        frame_confidence: 1.0,
      });
    }
  }
  return out;
}

/** Apply a ClusterResult to the named project's file nodes in dbPath.
 *  Sets frame_id/frame_label/frame_confidence on clustered files and clears
 *  those keys on every other file node in the project. Idempotent.
 *  Returns the number of file assignments applied. */
export function injectFrames(args: { cluster: ClusterResult; project: string; dbPath: string }): number {
  const assignments = buildFrameAssignments(args.cluster);
  const db = new Database(args.dbPath);
  try {
    // 1. Apply assignments (UPDATE the data JSON for matching file nodes).
    const applyOne = db.prepare(`
      UPDATE nodes
      SET data = json_set(
        json_set(
          json_set(COALESCE(data, '{}'), '$.frame_id', @frame_id),
          '$.frame_label', @frame_label
        ),
        '$.frame_confidence', @frame_confidence
      )
      WHERE project = @project
        AND kind = 'file'
        AND file_path = @file_path
    `);

    // 2. Clear frame_* keys on any file node in this project that is NOT in
    //    the cluster set (handles re-clustering moving files to noise).
    //    NOTE: positional `?` throughout — better-sqlite3 does not allow
    //    mixing named + positional bindings on the same prepared statement.
    const clearStmt = db.prepare(`
      UPDATE nodes
      SET data = json_remove(
        json_remove(
          json_remove(COALESCE(data, '{}'), '$.frame_id'),
          '$.frame_label'
        ),
        '$.frame_confidence'
      )
      WHERE project = ?
        AND kind = 'file'
        AND file_path NOT IN (${assignments.map(() => "?").join(",") || "NULL"})
    `);

    const tx = db.transaction(() => {
      for (const a of assignments) {
        applyOne.run({ ...a, project: args.project });
      }
      // Run clear statement only when there are files to clear against;
      // otherwise the NOT IN (NULL) collapses to nothing matching.
      if (assignments.length > 0) {
        clearStmt.run(args.project, ...assignments.map((a) => a.file_path));
      }
    });
    tx();

    return assignments.length;
  } finally {
    db.close();
  }
}

function parseArgs(argv: string[]): { cluster: string; project: string; db?: string } {
  const out: Partial<{ cluster: string; project: string; db: string }> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cluster") out.cluster = argv[++i];
    else if (argv[i] === "--project") out.project = argv[++i];
    else if (argv[i] === "--db") out.db = argv[++i];
  }
  if (!out.cluster || !out.project) {
    console.error("usage: tsx inject-frames.ts --cluster <path> --project <name> [--db <path>]");
    process.exit(2);
  }
  return out as { cluster: string; project: string; db?: string };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const clusterPath = resolve(args.cluster);
  if (!existsSync(clusterPath)) {
    console.error(`Cluster JSON not found: ${clusterPath}`);
    process.exit(2);
  }
  const dbPath = args.db ?? resolveCortexDbPath();
  if (!existsSync(dbPath)) {
    console.error(`Cortex DB not found: ${dbPath}`);
    process.exit(2);
  }

  const cluster = JSON.parse(readFileSync(clusterPath, "utf-8")) as ClusterResult;
  const assigned = injectFrames({ cluster, project: args.project, dbPath });
  console.log(`[inject-frames] project=${args.project} assigned=${assigned}`);
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("inject-frames.ts");
if (isDirect) main();

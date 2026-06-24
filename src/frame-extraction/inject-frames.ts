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
import { splitSymbol } from "./text-blob.js";

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

/** True when `token` (already lowercased) appears as a DIRECTORY segment — any
 *  path segment except the final (filename) one — in at least one member path.
 *  A short token that names a real subsystem directory (`ws`, `io`, `db`) is a
 *  legitimate label; the same token appearing only as a filename stem/extension
 *  (`ts`, `js`) is noise. Lets the ≤2-char generic rule be relaxed for the
 *  former without admitting the latter. */
function isDirectorySegment(token: string, memberPaths: readonly string[]): boolean {
  for (const p of memberPaths) {
    const segs = p.split("/").filter((s) => s.length > 0);
    for (let i = 0; i < segs.length - 1; i++) {
      if (segs[i]!.toLowerCase() === token) return true;
    }
  }
  return false;
}

/** Fraction of a label's tokens that are topic-bearing (non-generic). 1.0 = every
 *  token is specific; 0 = the label is entirely generic/structural/short. The
 *  frame ranker multiplies F1 by this to down-weight opaque labels (e.g. the
 *  `cluster:N` fallback, or `src/core` org-root labels). */
export function genericPenalty(label: string): number {
  const terms = splitSymbol(label);
  if (terms.length === 0) return 0;
  const specific = terms.filter((t) => !isGenericToken(t)).length;
  return specific / terms.length;
}

/** A label word is eligible only if it is not generic, not structural
 *  (route param / MVC marker / bracket), and — when member paths are
 *  available — salient across ≥50% of them. The salience gate is skipped
 *  when `memberPaths` is empty so token-only callers behave as before. */
function isLabelEligibleWord(
  word: string,
  params: ReadonlySet<string>,
  memberPaths: readonly string[],
  suppressedTerms: ReadonlySet<string> = EMPTY_TERMS,
): boolean {
  const w = word.toLowerCase();
  // Stop-list (any length) always rejects. The ≤2-char rule is relaxed for a
  // token that names a real directory segment (a subsystem like `ws`), but not
  // for a short filename stem/extension.
  if (GENERIC_TOKENS.has(w)) return false;
  if (w.length <= 2 && !isDirectorySegment(w, memberPaths)) return false;
  if (isStructuralLabelToken(w)) return false;
  if (params.has(w)) return false;
  // Repo-wide ubiquitous terms (the repo name / top-level package) carry no
  // signal for distinguishing one frame from another — see ubiquitousPathSegments.
  if (suppressedTerms.has(w)) return false;
  if (memberPaths.length > 0 && pathSalience(w, memberPaths) < 0.5) return false;
  return true;
}

const EMPTY_TERMS: ReadonlySet<string> = new Set();

/**
 * Path segments that appear in at least `threshold` of ALL member paths across
 * every cluster — i.e. the repo-wide ubiquitous segments (typically the repo
 * name or top-level source package, e.g. `saleor` in `saleor/...`).
 *
 * Such a segment has member-salience ~1.0 in every cluster, so the per-cluster
 * salience gate in {@link isLabelEligibleWord} can't tell it apart from a
 * genuinely characterising term — yet it labels nothing distinctly (it's shared
 * by the whole repo). Computing it needs the full set of clusters, which only
 * the caller ({@link buildFrameAssignments} / scoreClusters) has. Feed the
 * result into {@link pickFrameLabel} as `suppressedTerms`.
 */
export function ubiquitousPathSegments(
  memberPathsPerCluster: readonly (readonly string[])[],
  threshold = 0.9,
): Set<string> {
  const out = new Set<string>();
  // A term is "non-characterising" only if it fails to DISTINGUISH frames — which
  // requires ≥2 frames to distinguish. With a single cluster the shared prefix
  // IS the best label (nothing to tell it apart from), so suppress nothing.
  if (memberPathsPerCluster.length < 2) return out;
  const all = memberPathsPerCluster.flat();
  if (all.length === 0) return out;
  const df = new Map<string, number>();
  for (const p of all) {
    // Count each distinct segment once per path (document frequency).
    const segs = new Set(p.split("/").filter((s) => s.length > 0).map((s) => s.toLowerCase()));
    for (const s of segs) df.set(s, (df.get(s) ?? 0) + 1);
  }
  for (const [seg, n] of df) {
    if (n / all.length >= threshold) out.add(seg);
  }
  return out;
}

/** Render a multi-word n-gram label as a path-like string that mirrors the
 *  directory nesting of its member files. Two-word TF-IDF n-grams almost always
 *  name an ancestor directory and a descendant (`saleor graphql` ⇒ files under
 *  `saleor/.../graphql/…`), so a slash reads as the containment the label is
 *  implicitly capturing. We don't trust the n-gram's word order: each word is
 *  located by its earliest matching path segment across members, words are
 *  ordered ancestor-first, and adjacent words that share the SAME segment in a
 *  majority of members are joined with `-` (a compound term like `react-query`,
 *  not a real hierarchy). Falls back to the original spaced token when there are
 *  no member paths or any word can't be located — keeping token-only callers
 *  unchanged. F1 scoring is unaffected: `splitSymbol` treats `/` and `-` as
 *  boundaries, so the rendered label tokenizes identically to the spaced form. */
function formatPathOrderedLabel(token: string, memberPaths: readonly string[]): string {
  const words = token.split(/\s+/).filter((w) => w.length > 0);
  if (words.length < 2 || memberPaths.length === 0) return token;

  const paths = memberPaths.map((p) => p.split("/").filter((s) => s.length > 0));
  // earliest[w][p] = earliest segment index of word w in path p, or -1 if absent.
  // Keeping the path axis lets us compare two words WITHIN the same member.
  const earliest = words.map((w) => {
    const lc = w.toLowerCase();
    return paths.map((segs) => segs.findIndex((seg) => splitSymbol(seg).includes(lc)));
  });
  // If any word is never locatable, we can't order reliably — keep the original.
  if (earliest.some((row) => row.every((i) => i < 0))) return token;

  const avg = (row: number[]) => {
    const found = row.filter((i) => i >= 0);
    return found.reduce((a, b) => a + b, 0) / found.length;
  };
  const order = words
    .map((word, i) => ({ word, i, key: avg(earliest[i]!) }))
    .sort((a, b) => a.key - b.key || a.i - b.i);

  // Adjacent words sharing the SAME segment in a majority of members where both
  // are present → compound term (`-`), not a hierarchy (`/`).
  const sameSegMajority = (a: number, b: number): boolean => {
    let both = 0, same = 0;
    for (let p = 0; p < paths.length; p++) {
      const ia = earliest[a]![p]!, ib = earliest[b]![p]!;
      if (ia < 0 || ib < 0) continue;
      both++;
      if (ia === ib) same++;
    }
    return both > 0 && same * 2 > both;
  };

  let out = order[0]!.word;
  for (let k = 1; k < order.length; k++) {
    const sep = sameSegMajority(order[k - 1]!.i, order[k]!.i) ? "-" : "/";
    out += sep + order[k]!.word;
  }
  return out;
}

/** Pick a frame label, preferring informative tokens in this order:
 *
 *   1. First bigram (or longer) where ALL words are label-eligible (non-generic,
 *      non-structural, not a route param, and salient across ≥50% of member paths).
 *      Bigrams like "design system" or "mcp server" identify subsystems more
 *      clearly than either word alone. Multi-word hits are rendered path-like via
 *      `formatPathOrderedLabel` (e.g. `saleor/graphql`, `react-query`).
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
  suppressedTerms: ReadonlySet<string> = EMPTY_TERMS,
): string {
  const params = routeParamTokens(memberPaths);

  // Pass 1: first n-gram where every word is label-eligible.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 1 && parts.every((p) => isLabelEligibleWord(p, params, memberPaths, suppressedTerms))) {
      return formatPathOrderedLabel(token, memberPaths);
    }
  }

  // Pass 2: first label-eligible unigram.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 1 && isLabelEligibleWord(parts[0]!, params, memberPaths, suppressedTerms)) {
      return token;
    }
  }

  // Pass 3: path-prefix fallback.
  const prefix = commonPathSegmentLabel(memberPaths, suppressedTerms);
  if (prefix) return prefix;

  // Pass 4: dominant-segment fallback (non-prefix convention clusters).
  const dominant = dominantPathSegmentLabel(memberPaths, suppressedTerms);
  if (dominant) return dominant;

  // Pass 4.5: relaxed last-resort recovery before the opaque fallback.
  const recovered = relaxedRecoveryLabel(topTokens, memberPaths, params, suppressedTerms);
  if (recovered) return recovered;

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
function dominantPathSegmentLabel(
  paths: readonly string[],
  suppressedTerms: ReadonlySet<string> = EMPTY_TERMS,
): string | null {
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
      const shortStem = lower.length <= 2 && !isDirectorySegment(lower, paths);
      if (isDynamicSegment(lower) || GENERIC_TOKENS.has(lower) || shortStem ||
          isStructuralLabelToken(lower) || params.has(lower) || suppressedTerms.has(lower)) return;
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

/** Last-resort recovery, reached only when passes 1–4 fail. Relaxes the normal
 *  gate in two ways: (1) allows `GENERIC_TOKENS` members (deprioritized below
 *  non-generic), (2) lowers the salience floor to 0.3 (recovers a plurality
 *  token in a mixed cluster). NEVER accepts a route-param, dynamic segment,
 *  short filename stem, or repo-ubiquitous suppressed term. Returns null when
 *  no token or segment clears the relaxed bar, or when no member paths exist. */
function relaxedRecoveryLabel(
  topTokens: readonly string[],
  memberPaths: readonly string[],
  params: ReadonlySet<string>,
  suppressedTerms: ReadonlySet<string> = EMPTY_TERMS,
): string | null {
  // Without member paths, there's nothing to recover from — generic tokens alone
  // don't justify a label (they're in the stop list). Let existing passes handle it.
  if (memberPaths.length === 0) return null;

  const SALIENCE_FLOOR = 0.3;
  const recoverable = (w: string, allowGeneric: boolean): boolean => {
    if (isStructuralLabelToken(w)) return false;
    if (params.has(w)) return false;
    if (suppressedTerms.has(w)) return false;
    if (w.length <= 2 && !isDirectorySegment(w, memberPaths)) return false;
    if (!allowGeneric && GENERIC_TOKENS.has(w)) return false;
    if (pathSalience(w, memberPaths) < SALIENCE_FLOOR) return false;
    return true;
  };
  // Two sweeps: non-generic tokens first (preferred), then generic-but-real.
  for (const allowGeneric of [false, true]) {
    for (const token of topTokens) {
      const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
      if (parts.length > 1 && parts.every((p) => recoverable(p, allowGeneric))) {
        return formatPathOrderedLabel(token, memberPaths);
      }
      if (parts.length === 1 && recoverable(parts[0]!, allowGeneric)) {
        return token;
      }
    }
  }
  // No raw path-segment relaxation here: a segment at ≥30% frequency carries no
  // topicality guarantee (it recovers meaningless org/package leaf names). Only
  // TF-IDF top-tokens — topical by construction — are relaxed. Genuinely
  // heterogeneous clusters fall through to the honest descriptor / cluster:N.
  return null;
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
function commonPathSegmentLabel(
  paths: readonly string[],
  suppressedTerms: ReadonlySet<string> = EMPTY_TERMS,
): string | null {
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
    if (suppressedTerms.has(seg.toLowerCase())) continue;
    return seg;
  }
  return null;
}

export interface FrameAssignment {
  file_path: string;
  frame_id: number;
  frame_label: string;
  frame_confidence: number;
  reclaimed: boolean;
}

export function buildFrameAssignments(cluster: ClusterResult): FrameAssignment[] {
  const topTokens = ((cluster.parameters ?? {}) as Record<string, unknown>)["top_tokens_per_cluster"] as
    | Record<string, string[]>
    | undefined ?? {};
  // Repo-wide ubiquitous segments (repo name / top package) computed across all
  // clusters so no single frame is labelled by a term shared by the whole repo.
  const suppressed = ubiquitousPathSegments(
    cluster.clusters.filter((c) => c.cluster_id !== -1).map((c) => c.member_paths),
  );
  const out: FrameAssignment[] = [];
  for (const c of cluster.clusters) {
    if (c.cluster_id === -1) continue;
    const tokens = topTokens[String(c.cluster_id)] ?? [];
    const label = pickFrameLabel(tokens, c.member_paths, c.cluster_id, suppressed);
    const reclaimedSet = new Set(c.reclaimed_paths ?? []);
    for (const path of c.member_paths) {
      out.push({
        file_path: path,
        frame_id: c.cluster_id,
        frame_label: label,
        frame_confidence: 1.0,
        reclaimed: reclaimedSet.has(path),
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
  db.pragma("busy_timeout = 5000");
  try {
    // 1. Apply assignments (UPDATE the data JSON for matching file nodes).
    const applyOne = db.prepare(`
      UPDATE nodes
      SET data = CASE WHEN @reclaimed = 'true'
        THEN json_set(
          json_set(
            json_set(
              json_set(COALESCE(data, '{}'), '$.frame_id', @frame_id),
              '$.frame_label', @frame_label
            ),
            '$.frame_confidence', @frame_confidence
          ),
          '$.reclaimed', json('true')
        )
        ELSE json_remove(
          json_set(
            json_set(
              json_set(COALESCE(data, '{}'), '$.frame_id', @frame_id),
              '$.frame_label', @frame_label
            ),
            '$.frame_confidence', @frame_confidence
          ),
          '$.reclaimed'
        )
      END
      WHERE project = @project
        AND kind = 'file'
        AND file_path = @file_path
    `);

    // reclaimed bound as the string 'true'/'false': SQLite has no native
    // boolean, and the CASE WHEN sets json('true') vs json_remove so parsed
    // data.reclaimed is `true` for reclaimed members and absent for core.

    // 2. Clear frame_* keys on any file node in this project that is NOT in
    //    the cluster set (handles re-clustering moving files to noise).
    //    NOTE: positional `?` throughout — better-sqlite3 does not allow
    //    mixing named + positional bindings on the same prepared statement.
    const clearStmt = db.prepare(`
      UPDATE nodes
      SET data = json_remove(
        json_remove(
          json_remove(
            json_remove(COALESCE(data, '{}'), '$.frame_id'),
            '$.frame_label'
          ),
          '$.frame_confidence'
        ),
        '$.reclaimed'
      )
      WHERE project = ?
        AND kind = 'file'
        AND file_path NOT IN (${assignments.map(() => "?").join(",") || "NULL"})
    `);

    const tx = db.transaction(() => {
      for (const a of assignments) {
        applyOne.run({ ...a, project: args.project, reclaimed: a.reclaimed ? "true" : "false" });
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

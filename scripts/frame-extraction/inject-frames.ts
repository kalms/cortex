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
import { resolveCortexDbPath } from "../../src/db/resolve-path.js";
import type { ClusterResult } from "./types.js";

/** Stop-list of generic tokens we skip when picking a label. Lowercase.
 *  Includes monorepo-convention dirs (`apps`, `packages`), framework/route
 *  artefacts (`id`, `slug`, `params`, `dirname`), Node globals (`__dirname`,
 *  `__filename`), and tokens that describe data shape rather than topic
 *  (`data`, `meta`, `props`, `state`, `default`). */
const GENERIC_TOKENS = new Set([
  // Filesystem layout conventions
  "src", "lib", "common", "core", "main", "app", "apps", "packages",
  "modules", "pkg", "pkgs", "components", "index",
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

/** Pick a frame label, preferring informative tokens in this order:
 *
 *   1. First bigram (or longer) where ALL words are non-generic. Bigrams like
 *      "design system" or "mcp server" identify subsystems more clearly than
 *      either word alone.
 *   2. First non-generic unigram.
 *   3. Path-prefix fallback: deepest non-generic segment of the longest
 *      common directory prefix of member paths. Catches clusters whose top
 *      tokens are all generic but whose files share a meaningful directory.
 *   4. `cluster:<id>` as last resort.
 *
 *  Tokens are normalised to lowercase for the stop-list check, but returned
 *  in their original form.
 */
export function pickFrameLabel(
  topTokens: readonly string[],
  memberPaths: readonly string[],
  clusterId?: number,
): string {
  // Pass 1: first bigram (or n-gram) where every word is non-generic.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length > 1 && parts.every((p) => !isGenericToken(p))) {
      return token;
    }
  }

  // Pass 2: first non-generic unigram.
  for (const token of topTokens) {
    const parts = token.toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 1 && !isGenericToken(parts[0]!)) {
      return token;
    }
  }

  // Pass 3: path-prefix fallback.
  const prefix = commonPathSegmentLabel(memberPaths);
  if (prefix) return prefix;

  // Pass 4: cluster id fallback.
  return `cluster:${clusterId ?? "?"}`;
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
    if (/^\[.+\]$/.test(seg)) continue;
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
  const assignments = buildFrameAssignments(cluster);
  const clusteredPaths = new Set(assignments.map((a) => a.file_path));

  const db = new Database(dbPath);
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

    console.log(`[inject-frames] project=${args.project} assigned=${assignments.length} clustered_files=${clusteredPaths.size}`);
  } finally {
    db.close();
  }
}

const isDirect = import.meta.url === `file://${process.argv[1]}` ||
                 process.argv[1]?.endsWith("inject-frames.ts");
if (isDirect) main();

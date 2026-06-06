// src/frame-extraction/label-quality.ts
/**
 * Independent, deterministic label-quality metric for the frame-extraction eval.
 *
 * Scores each cluster's label as a CLASSIFIER of the corpus, measured against
 * the full per-file token blob (path + content). Coverage (recall over members)
 * + specificity (precision over the whole repo) → F1. Specificity is the part
 * `pickFrameLabel` never optimizes for, so this is non-circular.
 *
 * PURE module: no file/DB/network I/O. Inputs in, scores out.
 */
import { pickFrameLabel } from "./inject-frames.js";
import { splitSymbol } from "./text-blob.js";
import type { ClusterAssignment, FileBlob } from "./types.js";

export interface CorpusIndex {
  /** Per-file token set, lowercased. */
  tokensByPath: Map<string, Set<string>>;
  /** Single-term document frequency (files containing the term). */
  df: Map<string, number>;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

export function buildCorpusIndex(blobs: readonly FileBlob[]): CorpusIndex {
  const tokensByPath = new Map<string, Set<string>>();
  const df = new Map<string, number>();
  for (const b of blobs) {
    const set = new Set(tokenize(b.text));
    tokensByPath.set(b.path, set);
    for (const term of set) df.set(term, (df.get(term) ?? 0) + 1);
  }
  return { tokensByPath, df };
}

export interface LabelScore {
  label: string;
  terms: string[];
  /** Recall over the cluster's members. */
  coverage: number;
  /** Precision over the whole repo. */
  specificity: number;
  f1: number;
}

function pathHasAllTerms(idx: CorpusIndex, path: string, terms: readonly string[]): boolean {
  const set = idx.tokensByPath.get(path);
  if (!set) return false;
  return terms.every((t) => set.has(t));
}

function countFilesWithAllTerms(idx: CorpusIndex, terms: readonly string[]): number {
  let n = 0;
  for (const set of idx.tokensByPath.values()) {
    if (terms.every((t) => set.has(t))) n++;
  }
  return n;
}

/**
 * Matches the label against the blob token surface. The label is tokenized with
 * the SAME `splitSymbol` used to build the blob token sets (camelCase + `._-/`
 * split, lowercased), so compound labels (`useElementSize`, `method_comparison`)
 * match blobs that store their parts split. Opaque fallback labels such as
 * `cluster:N` score zero by construction — `splitSymbol` leaves `cluster:N`
 * intact (colon is not a split boundary) and no blob contains that token — and
 * that is **intended** (they genuinely don't characterize the files).
 */
export function scoreLabel(
  label: string,
  memberPaths: readonly string[],
  idx: CorpusIndex,
): LabelScore {
  const terms = splitSymbol(label);
  const uniqueMembers = [...new Set(memberPaths)];
  const membersWith = uniqueMembers.filter((p) => pathHasAllTerms(idx, p, terms)).length;
  // Single-term fast path uses df; multi-word scans for co-occurrence.
  const filesWith =
    terms.length === 1 ? idx.df.get(terms[0]!) ?? 0 : countFilesWithAllTerms(idx, terms);

  const coverage = uniqueMembers.length > 0 ? membersWith / uniqueMembers.length : 0;
  const specificity = filesWith > 0 ? membersWith / filesWith : 0;
  const f1 =
    coverage + specificity > 0 ? (2 * coverage * specificity) / (coverage + specificity) : 0;
  return { label, terms, coverage, specificity, f1 };
}

export interface ClusterLabelScore extends LabelScore {
  cluster_id: number;
  member_count: number;
}

export function scoreClusters(
  clusters: readonly ClusterAssignment[],
  topTokensPerCluster: Record<string, string[]>,
  idx: CorpusIndex,
): ClusterLabelScore[] {
  const out: ClusterLabelScore[] = [];
  for (const c of clusters) {
    if (c.cluster_id === -1) continue;
    const tokens = topTokensPerCluster[String(c.cluster_id)] ?? [];
    const label = pickFrameLabel(tokens, c.member_paths, c.cluster_id);
    const s = scoreLabel(label, c.member_paths, idx);
    out.push({ ...s, cluster_id: c.cluster_id, member_count: c.member_paths.length });
  }
  return out;
}

export interface LabelQualityAggregate {
  f1_mean: number;
  /** F1 weighted by cluster member count. */
  f1_weighted: number;
  coverage_mean: number;
  specificity_mean: number;
  /** Number of clusters with f1 below the floor. */
  clusters_below: number;
  cluster_count: number;
}

export const DEFAULT_F1_FLOOR = 0.5;

export function aggregateLabelQuality(
  scores: readonly ClusterLabelScore[],
  f1Floor: number = DEFAULT_F1_FLOOR,
): LabelQualityAggregate {
  const n = scores.length;
  if (n === 0) {
    return {
      f1_mean: 0, f1_weighted: 0, coverage_mean: 0, specificity_mean: 0,
      clusters_below: 0, cluster_count: 0,
    };
  }
  const mean = (sel: (s: ClusterLabelScore) => number) =>
    scores.reduce((acc, s) => acc + sel(s), 0) / n;
  const totalMembers = scores.reduce((acc, s) => acc + s.member_count, 0);
  const f1_weighted =
    totalMembers > 0
      ? scores.reduce((acc, s) => acc + s.f1 * s.member_count, 0) / totalMembers
      : 0;
  return {
    f1_mean: mean((s) => s.f1),
    f1_weighted,
    coverage_mean: mean((s) => s.coverage),
    specificity_mean: mean((s) => s.specificity),
    clusters_below: scores.filter((s) => s.f1 < f1Floor).length,
    cluster_count: n,
  };
}

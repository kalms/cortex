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

export function scoreLabel(
  label: string,
  memberPaths: readonly string[],
  idx: CorpusIndex,
): LabelScore {
  const terms = label.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const membersWith = memberPaths.filter((p) => pathHasAllTerms(idx, p, terms)).length;
  // Single-term fast path uses df; multi-word scans for co-occurrence.
  const filesWith =
    terms.length === 1 ? idx.df.get(terms[0]!) ?? 0 : countFilesWithAllTerms(idx, terms);

  const coverage = memberPaths.length > 0 ? membersWith / memberPaths.length : 0;
  const specificity = filesWith > 0 ? membersWith / filesWith : 0;
  const f1 =
    coverage + specificity > 0 ? (2 * coverage * specificity) / (coverage + specificity) : 0;
  return { label, terms, coverage, specificity, f1 };
}

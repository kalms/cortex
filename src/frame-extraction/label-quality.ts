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

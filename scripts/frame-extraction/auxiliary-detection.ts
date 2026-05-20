// scripts/frame-extraction/auxiliary-detection.ts
/**
 * Group A of the auxiliary-content detection: path-pattern matching.
 *
 * Per docs/specs/cortex-v0.3/frame-extraction.md §"Two content streams",
 * a directory or file whose path contains any of these segments is
 * "auxiliary" — bypassed from semantic clustering. The spec's starter
 * list is below; `vendored` and `node_modules` are added because they're
 * the dominant variants in real codebases (cortex itself uses
 * `internal/indexer/vendored/`).
 *
 * Group B (structural detection — content-type dominance, graph
 * position, size homogeneity, cardinality) is not implemented here;
 * the path-pattern fast path catches the bulk of cases.
 */

/** Default path segments treated as auxiliary. Exact segment match,
 *  not substring, so e.g. `static` matches `src/static/foo` but not
 *  `src/staticAnalysis/foo`. */
export const DEFAULT_AUXILIARY_SEGMENTS: ReadonlySet<string> = new Set([
  // Spec §"Two content streams" Group A path patterns:
  "locales",
  "i18n",
  "__snapshots__",
  "fixtures",
  "assets",
  "static",
  "public",
  "vendor",
  "generated",
  "dist",
  "build",
  // Common variants observed in real codebases:
  "vendored",     // cortex: internal/indexer/vendored/
  "node_modules", // npm ecosystem
]);

/** Returns true if `filePath` contains any auxiliary segment. Path is
 *  split on `/`; each segment is checked for exact membership in
 *  `segments`. Empty path → false. */
export function isAuxiliaryPath(
  filePath: string,
  segments: ReadonlySet<string> = DEFAULT_AUXILIARY_SEGMENTS,
): boolean {
  if (!filePath) return false;
  for (const part of filePath.split("/")) {
    if (segments.has(part)) return true;
  }
  return false;
}

/** One aggregate node, representing a group of auxiliary files. Per
 *  spec §"Two content streams": auxiliary content renders as aggregate
 *  bare nodes outside frames, one dot per group with a count badge. */
export interface Aggregate {
  /** Stable identifier of the form `aux:<segment>:<label>`. */
  id: string;
  /** Human-readable label — the sub-directory under the auxiliary
   *  segment, or the segment itself when there's no sub-directory
   *  (e.g. `dist/bundle.js` → label `dist`). */
  label: string;
  /** The matched auxiliary segment (`vendor`, `vendored`, `dist`, …). */
  aux_segment: string;
  /** Total number of files in this aggregate. */
  member_count: number;
  /** First 5 paths from the input (insertion order). Used for drill-in
   *  previews on hover or in a drawer surface. */
  sample_paths: string[];
}

/** Group an arbitrary list of paths into aggregates by their auxiliary
 *  segment and the segment immediately after it. Non-auxiliary paths
 *  are silently skipped. Sorted by `member_count` desc, then `label`
 *  asc. Input order within each group is preserved for `sample_paths`,
 *  so the function is deterministic on a deterministic input. */
export function groupAuxiliaryPaths(
  paths: readonly string[],
  segments: ReadonlySet<string> = DEFAULT_AUXILIARY_SEGMENTS,
): Aggregate[] {
  const buckets = new Map<string, Aggregate>();
  for (const path of paths) {
    if (!path) continue;
    const parts = path.split("/");
    let auxIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (segments.has(parts[i]!)) {
        auxIdx = i;
        break;
      }
    }
    if (auxIdx === -1) continue;
    const auxSegment = parts[auxIdx]!;
    // The label is the directory immediately under the aux segment —
    // present only when there's at least one more segment beyond it
    // (which means the path is `<aux>/<subdir>/.../<file>`). Otherwise
    // the path is `<aux>/<file>` and the aux segment itself becomes the
    // label (e.g. `dist/bundle.js` → label `dist`).
    const label = auxIdx + 2 < parts.length ? parts[auxIdx + 1]! : auxSegment;
    const key = `aux:${auxSegment}:${label}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        id: key,
        label,
        aux_segment: auxSegment,
        member_count: 0,
        sample_paths: [],
      };
      buckets.set(key, agg);
    }
    agg.member_count += 1;
    if (agg.sample_paths.length < 5) {
      agg.sample_paths.push(path);
    }
  }
  const out = [...buckets.values()];
  out.sort((a, b) => {
    if (b.member_count !== a.member_count) return b.member_count - a.member_count;
    return a.label.localeCompare(b.label);
  });
  return out;
}

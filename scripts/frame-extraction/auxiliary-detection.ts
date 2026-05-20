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

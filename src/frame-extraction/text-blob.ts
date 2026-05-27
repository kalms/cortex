// scripts/frame-extraction/text-blob.ts
import type Database from "better-sqlite3";
import { tokenizePath } from "./path-tokenize.js";
import {
  DEFAULT_AUXILIARY_SEGMENTS,
  isAuxiliaryPath,
} from "./auxiliary-detection.js";
import type { FileBlob } from "./types.js";

/** Split an identifier into lowercase word parts using the same rules as
 *  `splitWords` inside path-tokenize, but WITHOUT filtering STRIP_SEGMENTS.
 *  STRIP_SEGMENTS are framework-structural tokens meaningful for paths (e.g.
 *  "middleware", "service") but are real domain words when they appear as
 *  identifiers — we must not drop them from symbol blobs. */
function splitSymbol(s: string): string[] {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._\-/]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

/** Default set of node kinds treated as "entities" for blob construction.
 *  Matches the spec's "entity_count" definition + variable (which the
 *  Cortex indexer also emits for top-level consts/lets). */
export const DEFAULT_ENTITY_KINDS = [
  "function", "class", "method", "interface", "type", "variable",
];

/** Reads the project's entity nodes from a Cortex graph DB and emits one
 *  `FileBlob` per file, with the blob text being a single space-separated
 *  string of (path_tokens ∪ symbol words). Deterministic: blob ordering
 *  by file path (asc), token ordering by first-occurrence (Set semantics).
 *
 *  Performance: one SQL query for the entire project, grouped in memory.
 *  Tested against a synthetic fixture so it does not require a real
 *  indexed repo to run. */
export interface CollectBlobsOptions {
  /** Skip files whose path contains any of these segments (spec
   *  §"Two content streams" Group A — auxiliary content bypass).
   *  Defaults to `DEFAULT_AUXILIARY_SEGMENTS` (vendor/dist/build/etc.).
   *  Pass an empty set to disable the filter entirely. */
  auxiliary_segments?: ReadonlySet<string>;
}

export function collectBlobsFromGraph(
  db: Database.Database,
  project: string,
  entity_kinds: readonly string[] = DEFAULT_ENTITY_KINDS,
  options: CollectBlobsOptions = {},
): FileBlob[] {
  const auxSegments = options.auxiliary_segments ?? DEFAULT_AUXILIARY_SEGMENTS;
  const placeholders = entity_kinds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT file_path, name FROM nodes
       WHERE project = ?
         AND file_path IS NOT NULL
         AND file_path != ''
         AND kind IN (${placeholders})
       ORDER BY file_path, name`,
    )
    .all(project, ...entity_kinds) as Array<{ file_path: string; name: string }>;

  const byFile = new Map<string, Set<string>>();
  for (const row of rows) {
    if (isAuxiliaryPath(row.file_path, auxSegments)) continue;
    let tokens = byFile.get(row.file_path);
    if (!tokens) {
      tokens = new Set<string>();
      // Seed with path tokens (deterministic order from tokenizePath).
      const { path_tokens } = tokenizePath(row.file_path);
      for (const t of path_tokens) tokens.add(t);
      byFile.set(row.file_path, tokens);
    }
    // Add the name itself (lowercased — TF-IDF tokenization will see it
    // as one token unless we split, which is what we want for things like
    // 'authMiddleware' staying together as a co-occurrence signal).
    const lowered = row.name.toLowerCase();
    if (lowered) tokens.add(lowered);
    // Also add the split words so 'authMiddleware' contributes both
    // the joined form AND the parts (auth, middleware). We use splitSymbol
    // here (not tokenizePath) because tokenizePath filters STRIP_SEGMENTS —
    // which strips real domain words like "middleware" or "service" when
    // they appear as identifier parts. Symbol names need no such filter.
    for (const t of splitSymbol(row.name)) tokens.add(t);
  }

  // Emit in path-sorted order. Token order within each blob is insertion
  // order from the Set, which gives a stable cross-run result.
  const out: FileBlob[] = [];
  for (const path of [...byFile.keys()].sort()) {
    const tokens = byFile.get(path)!;
    out.push({ path, text: [...tokens].join(" ") });
  }
  return out;
}

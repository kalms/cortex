import type { Assertion } from "./types.js";
import type { GraphStore } from "../../../src/graph/store.js";

/** Nodes that represent a symbol the indexer extracted from source.
 *  `variable` is deliberately excluded: it is the highest-count kind in most
 *  graphs (2,229 of 5,458 nodes on one real target) and is dominated by
 *  locals that legitimately have no edges, which would swamp the orphan
 *  metric's signal. */
export const DEFINITION_KINDS = ["function", "method", "class", "interface", "type"];

/** DEFINITION_KINDS plus the kinds whose qualified names are path-derived and
 *  therefore collidable via the index/__init__ fold in should_skip_fqn_part. */
export const COLLIDABLE_KINDS = [...DEFINITION_KINDS, "file", "module"];

const sqlList = (kinds: string[]) => kinds.map((k) => `'${k}'`).join(", ");

export const UNIVERSAL_ASSERTIONS: Assertion[] = [
  {
    fix_id: "universal",
    name: "file_sourced_calls",
    description:
      "CALLS edges whose source is a file node — a call the indexer could not attribute to its enclosing callable",
    query: {
      kind: "sql",
      sql: `
        SELECT COUNT(*) AS n
        FROM edges e
        JOIN nodes s ON s.id = e.source_id
        WHERE e.relation = 'CALLS' AND s.kind = 'file'
      `,
    },
    baseline_expected: "pass",
    scope: "universal",
    direction: "lower_is_better",
  },
  {
    fix_id: "universal",
    name: "call_attribution_rate",
    description: "percentage of CALLS edges sourced at a function or method",
    query: {
      kind: "sql",
      sql: `
        SELECT CAST(SUM(CASE WHEN s.kind IN ('function', 'method') THEN 1 ELSE 0 END) AS REAL)
               * 100.0 / NULLIF(COUNT(*), 0) AS pct
        FROM edges e
        JOIN nodes s ON s.id = e.source_id
        WHERE e.relation = 'CALLS'
      `,
    },
    baseline_expected: "pass",
    scope: "universal",
    direction: "higher_is_better",
  },
  {
    fix_id: "universal",
    name: "qn_collisions",
    description:
      "qualified names held by nodes in more than one file — two source files folding to one identity",
    query: {
      kind: "sql",
      // COUNT(DISTINCT file_path) treats NULL as contributing nothing, so two
      // nodes sharing a qualified_name with no file_path on either do NOT
      // count as a collision here — a cross-file claim needs file info.
      sql: `
        SELECT COUNT(*) AS n FROM (
          SELECT qualified_name
          FROM nodes
          WHERE qualified_name IS NOT NULL
            AND kind IN (${sqlList(COLLIDABLE_KINDS)})
          GROUP BY qualified_name
          HAVING COUNT(DISTINCT file_path) > 1
        )
      `,
    },
    baseline_expected: "pass",
    scope: "universal",
    direction: "lower_is_better",
  },
  {
    fix_id: "universal",
    name: "orphan_definition_rate",
    description: "percentage of definition nodes with no incident edges in either direction",
    query: {
      kind: "sql",
      sql: `
        SELECT CAST(SUM(CASE WHEN c.id IS NULL THEN 1 ELSE 0 END) AS REAL)
               * 100.0 / NULLIF(COUNT(*), 0) AS pct
        FROM nodes n
        LEFT JOIN (
          SELECT source_id AS id FROM edges
          UNION
          SELECT target_id AS id FROM edges
        ) c ON c.id = n.id
        WHERE n.kind IN (${sqlList(DEFINITION_KINDS)})
      `,
    },
    baseline_expected: "pass",
    scope: "universal",
    direction: "lower_is_better",
  },
  {
    fix_id: "universal",
    name: "per_language_function_density",
    description: "callables per file for each language present, keyed by file extension",
    query: { kind: "language_density" },
    baseline_expected: "pass",
    scope: "universal",
    direction: "higher_is_better",
  },
];

/** Callables per file, keyed by file extension. The question this answers is
 *  blunt on purpose: if a language's density is 0, extraction for it is
 *  broken, however healthy the rest of the graph looks. The extension key
 *  follows node's path.extname() semantics; only `function` and `method`
 *  count as callables, deliberately narrower than DEFINITION_KINDS, which
 *  also holds class/interface/type. */
export function computeLanguageDensity(store: GraphStore): Record<string, number> {
  const rows = store.queryRaw<{ kind: string; file_path: string | null }>(
    `SELECT kind, file_path FROM nodes WHERE file_path IS NOT NULL`,
  );

  const files = new Map<string, Set<string>>();
  const callables = new Map<string, number>();

  for (const row of rows) {
    const path = row.file_path;
    if (!path) continue;
    const dot = path.lastIndexOf(".");
    const slash = path.lastIndexOf("/");
    // Skip when there is no extension to speak of:
    //   dot <= 0          -> no dot at all, or a top-level dotfile (".gitignore")
    //   dot <= slash + 1  -> the only dot is inside a directory name
    //                        ("pkg.name/file"), or the basename is itself a
    //                        dotfile with no extension ("src/.gitignore")
    // This matches node's path.extname(), which reports "" for all of these.
    if (dot <= 0 || dot <= slash + 1) continue;
    const ext = path.slice(dot + 1).toLowerCase();
    if (!ext) continue;

    if (row.kind === "file") {
      if (!files.has(ext)) files.set(ext, new Set());
      files.get(ext)!.add(path);
    } else if (row.kind === "function" || row.kind === "method") {
      callables.set(ext, (callables.get(ext) ?? 0) + 1);
    }
  }

  const out: Record<string, number> = {};
  for (const [ext, paths] of files) {
    out[ext] = paths.size === 0 ? 0 : (callables.get(ext) ?? 0) / paths.size;
  }
  return out;
}

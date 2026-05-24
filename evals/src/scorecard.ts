import { GraphStore } from "../../src/graph/store.js";
import { KILLER_QUERIES } from "./queries.js";
import type { Scorecard, KillerQueryResult } from "./assertions/types.js";

const SAMPLE_ROW_LIMIT = 5;

export function computeScorecard(dbPath: string, target: string): Scorecard {
  const store = new GraphStore(dbPath);

  const nodes_by_label: Record<string, number> = {};
  for (const row of store.queryRaw<{ kind: string; n: number }>(
    "SELECT kind, COUNT(*) AS n FROM nodes GROUP BY kind",
  )) {
    nodes_by_label[row.kind] = row.n;
  }

  const edges_by_type: Record<string, number> = {};
  for (const row of store.queryRaw<{ relation: string; n: number }>(
    "SELECT relation, COUNT(*) AS n FROM edges GROUP BY relation",
  )) {
    edges_by_type[row.relation] = row.n;
  }

  const killer_queries: KillerQueryResult[] = KILLER_QUERIES.map((q) => {
    const rows = store.queryRaw<Record<string, unknown>>(q.sql);
    return {
      name: q.name,
      cypher: q.cypher,
      row_count: rows.length,
      sample_rows: rows.slice(0, SAMPLE_ROW_LIMIT),
    };
  });

  return {
    target,
    indexer_seconds: null,
    nodes_by_label,
    edges_by_type,
    killer_queries,
  };
}

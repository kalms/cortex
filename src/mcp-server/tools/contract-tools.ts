import Database from "better-sqlite3";
import { findMismatches, summarizeCoverage } from "../../contracts/diff.js";
import type { Binding, ContractMismatch, CoverageReport } from "../../contracts/types.js";

export interface ContractReport { mismatches: ContractMismatch[]; coverage: Omit<CoverageReport, "unrecognized">; }

/** Rebuild bindings from persisted BINDS_KEY edges and diff them. */
export function computeContractReport(dbPath: string, project: string): ContractReport {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare(`
      SELECT a.name AS tool, e.data AS data
      FROM edges e JOIN nodes a ON a.id = e.target_id
      WHERE e.relation='BINDS_KEY' AND e.project=? AND a.kind='anchor'`).all(project) as Array<{ tool: string; data: string }>;
    const bindings: Binding[] = rows.map((r) => {
      const d = JSON.parse(r.data) as { role: "provides" | "consumes"; keys: string[]; symbol: string; line: number };
      return { tool: r.tool, role: d.role, keys: d.keys, file: "", symbol: d.symbol, line: d.line };
    });
    const { unrecognized: _omit, ...coverage } = summarizeCoverage(bindings, 0);
    return { mismatches: findMismatches(bindings), coverage };
  } finally {
    db.close();
  }
}

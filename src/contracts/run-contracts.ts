import { existsSync } from "node:fs";
import { scanRepoContracts } from "./extract.js";
import { injectContracts } from "./inject.js";
import { findMismatches } from "./diff.js";
import type { ContractResult } from "./types.js";

export interface RunContractOptions { repoPath: string; project: string; dbPath: string; }

/** Post-index pass: scan the RPC seam → write Anchor/BINDS_KEY edges. NEVER
 *  throws into the index path (mirrors run-frames); returns a discriminated
 *  result the caller surfaces. Gate: CORTEX_CONTRACTS≠0. */
export async function runContractExtraction(opts: RunContractOptions): Promise<ContractResult> {
  if (process.env.CORTEX_CONTRACTS === "0") return { status: "skipped", reason: "disabled" };
  if (!existsSync(opts.dbPath)) return { status: "skipped", reason: "no_db" };
  const started = Date.now();
  try {
    const { bindings } = scanRepoContracts(opts.repoPath);
    injectContracts({ bindings, project: opts.project, dbPath: opts.dbPath });
    const mismatches = findMismatches(bindings).length;
    const anchors = new Set(bindings.map((b) => b.tool)).size;
    return { status: "ok", anchors, mismatches, elapsedMs: Date.now() - started };
  } catch (e) {
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

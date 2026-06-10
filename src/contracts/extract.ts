import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseTsConsumers, parseCProviders } from "./parse.js";
import type { Binding } from "./types.js";

// Dirs scanned for each side. Kept narrow on purpose: these are the only places
// the indexer RPC convention appears. Extend here if new call sites are added.
// NOTE: post-split the C side lives in the separate cortex-indexer repo, so this
// path is absent in the cortex tree — walk() guards with existsSync and simply
// finds zero C providers (check_contracts degrades to TS-only here). Cross-repo
// contract verification against cortex-indexer is a follow-up. The path is
// retained because the contracts unit tests construct fixtures under it.
const TS_DIRS = ["src", "scripts/frame-extraction"];
const C_DIRS = ["internal/indexer/src/handlers"];

function walk(dir: string, exts: string[], out: string[]) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
}

export function scanRepoContracts(repoPath: string): { bindings: Binding[]; unrecognized: number } {
  const bindings: Binding[] = [];
  let unrecognized = 0;
  const rel = (p: string) => relative(repoPath, p).split(sep).join("/");

  const tsFiles: string[] = [];
  for (const d of TS_DIRS) walk(join(repoPath, d), [".ts"], tsFiles);
  for (const f of tsFiles) {
    if (f.endsWith(".test.ts")) continue;
    const r = parseTsConsumers(readFileSync(f, "utf-8"), rel(f));
    bindings.push(...r.bindings); unrecognized += r.unrecognized;
  }

  const cFiles: string[] = [];
  for (const d of C_DIRS) walk(join(repoPath, d), [".c"], cFiles);
  for (const f of cFiles) {
    const r = parseCProviders(readFileSync(f, "utf-8"), rel(f));
    bindings.push(...r.bindings); unrecognized += r.unrecognized;
  }
  return { bindings, unrecognized };
}

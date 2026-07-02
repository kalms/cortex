import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphStore } from "../graph/store.js";

export interface EntryPoint { label: string; target: string; }

const BUILD_DIRS = ["dist/", "build/", "out/"];
const CONVENTIONAL = new Set([
  "src/index.ts", "src/index.js", "src/main.ts", "src/main.js",
  "index.ts", "index.js", "main.ts", "main.js",
]);

/** Declared (package.json bin/main) + conventional source-entry files. */
export function entrypoints(root: string, store: GraphStore, project: string): EntryPoint[] {
  const eps: EntryPoint[] = [];
  const seen = new Set<string>();
  const push = (label: string, target: string) => {
    if (seen.has(target)) return;
    seen.add(target); eps.push({ label, target });
  };

  // 1. package.json bin (+ main/module if inside the source tree).
  let pkg: Record<string, unknown> = {};
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")); } catch { /* none */ }
  const bin = pkg.bin;
  if (typeof bin === "string") push("bin", bin);
  else if (bin && typeof bin === "object")
    for (const [name, target] of Object.entries(bin as Record<string, unknown>))
      if (typeof target === "string") push(name, target);
  for (const field of ["main", "module"] as const) {
    const v = pkg[field];
    if (typeof v === "string" && !BUILD_DIRS.some((d) => v.startsWith(d))) push(field, v);
  }

  // 2. Conventional source-entry files that exist in the graph.
  const rows = store.queryRaw<{ file_path: string }>(
    `SELECT DISTINCT file_path FROM nodes WHERE project = ? AND file_path IS NOT NULL`,
    [project],
  );
  for (const r of rows) if (CONVENTIONAL.has(r.file_path)) push("entry", r.file_path);

  return eps;
}

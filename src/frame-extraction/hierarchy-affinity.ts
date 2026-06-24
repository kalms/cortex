/**
 * Class-hierarchy affinity signal for frame clustering. Files whose classes
 * share an IN-REPO (domain) base class are topically related. External bases
 * (no matching in-repo class — nn.Module, TestCase, …) are dropped: measured to
 * be cross-topic hubs that dilute the signal. Pure except writeHierarchyJsonl.
 */
import { writeFileSync } from "node:fs";
import type Database from "better-sqlite3";

export interface HierarchyPair { a: string; b: string; count: number }

/** Max files sharing one base before it is treated as too broad to be topical. */
const MAX_CLIQUE = 60;

/** Normalize a stored base token → candidate base names (lowercased). Handles
 *  "(nn.Module)", comma lists, dotted paths (last segment), and generics. */
export function parseBaseNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    for (const part of entry.replace(/[()]/g, " ").split(",")) {
      const name = (part.trim().split(/[<[]/)[0] ?? "").trim();
      if (!name) continue;
      const segs = name.split(".");
      const base = (segs[segs.length - 1] ?? "").trim().toLowerCase();
      if (base) out.push(base);
    }
  }
  return out;
}

export function collectHierarchyPairs(db: Database.Database, project: string): HierarchyPair[] {
  const rows = db.prepare(
    `SELECT file_path, name, json_extract(data,'$.base_classes') AS bases
       FROM nodes
      WHERE project = ? AND kind = 'class'
        AND file_path IS NOT NULL AND file_path != ''`,
  ).all(project) as Array<{ file_path: string; name: string | null; bases: string | null }>;

  const inRepo = new Set<string>();
  for (const r of rows) if (r.name) inRepo.add(r.name.toLowerCase());

  const baseToFiles = new Map<string, Set<string>>();
  for (const r of rows) {
    let parsed: string[] = [];
    if (r.bases) { try { parsed = parseBaseNames(JSON.parse(r.bases)); } catch { parsed = []; } }
    const self = r.name ? r.name.toLowerCase() : "";
    for (const b of parsed) {
      if (!inRepo.has(b) || b === self) continue;
      let s = baseToFiles.get(b);
      if (!s) { s = new Set(); baseToFiles.set(b, s); }
      s.add(r.file_path);
    }
  }

  const counts = new Map<string, number>();
  for (const files of baseToFiles.values()) {
    const arr = [...files].sort();
    if (arr.length < 2 || arr.length > MAX_CLIQUE) continue;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}\t${arr[j]}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs: HierarchyPair[] = [];
  for (const [k, count] of counts) { const [a, b] = k.split("\t"); pairs.push({ a: a!, b: b!, count }); }
  pairs.sort((x, y) => (x.a === y.a ? x.b.localeCompare(y.b) : x.a.localeCompare(y.a)));
  return pairs;
}

export function writeHierarchyJsonl(pairs: HierarchyPair[], outPath: string): void {
  writeFileSync(outPath, pairs.map((p) => JSON.stringify(p)).join("\n") + (pairs.length ? "\n" : ""));
}

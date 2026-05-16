// scripts/frame-extraction/fs-stats.ts
import { readdirSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import type { FsStats } from "./types.js";

const IGNORE_DIRS = new Set([".git", "node_modules", "dist", "build", ".tmp"]);

const AUXILIARY_PATH_PATTERNS = [
  "locales", "i18n", "__snapshots__", "fixtures",
  "assets", "static", "public", "vendor",
  "generated", "dist", "build",
];

export function collectFsStats(root: string): FsStats {
  const ext: Record<string, number> = {};
  let fileCount = 0;
  let totalDepth = 0;
  let maxDepth = 0;
  const aux = new Set<string>();

  function walk(dir: string, depthFromRoot: number) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && IGNORE_DIRS.has(entry.name)) continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const rel = relative(root, full);
        const segments = rel === "" ? [] : rel.split(sep);
        if (segments.some(s => AUXILIARY_PATH_PATTERNS.includes(s))) {
          aux.add(segments[0]);
        }
        walk(full, depthFromRoot + 1);
      } else if (entry.isFile()) {
        fileCount += 1;
        totalDepth += depthFromRoot;
        if (depthFromRoot > maxDepth) maxDepth = depthFromRoot;
        const e = extname(entry.name).toLowerCase();
        if (e) ext[e] = (ext[e] ?? 0) + 1;
      }
    }
  }

  walk(root, 0);

  return {
    file_count: fileCount,
    max_depth: maxDepth,
    mean_depth: fileCount > 0 ? totalDepth / fileCount : 0,
    extension_histogram: ext,
    auxiliary_directories: [...aux].sort(),
  };
}

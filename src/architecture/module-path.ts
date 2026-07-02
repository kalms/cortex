const SOURCE_ROOTS = new Set(["src", "lib", "app", "packages", "source"]);
const NOISE = new Set([
  "node_modules", "vendor", "dist", "build", "out", ".cache", "coverage",
  "tests", "test", "__tests__", "__mocks__", "fixtures", "__fixtures__",
  "docs", "doc", "specs", "plans", "examples", ".git",
]);

/**
 * Map a node/file/govern path to its source-module path.
 * - `src/mcp-server/tools/x.ts` → `src/mcp-server`
 * - `hooks/check-index.sh`      → `hooks`
 * - `src/index.ts` (root file)  → null (too coarse)
 * - anything under a NOISE dir  → null
 */
export function deriveModule(filePath: string | null): string | null {
  if (!filePath) return null;
  const segs = filePath.split("/").filter(Boolean);
  if (segs.length === 0) return null;
  if (segs.some((s) => NOISE.has(s))) return null;
  const root = segs[0];
  if (SOURCE_ROOTS.has(root)) {
    if (segs.length >= 3) return `${root}/${segs[1]}`;
    return null; // root-level file directly under a source root
  }
  return root;
}

/**
 * Pure clamping for paginated graph search params. Lives at the graph layer
 * so both the MCP tool (search-format.ts) and the CLI (cortex code find) can
 * import it without crossing into the mcp-server layer. No I/O.
 */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function clampOffset(offset?: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

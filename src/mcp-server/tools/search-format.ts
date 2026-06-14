/**
 * Pure presentation helpers for the search_graph tool: input clamping and
 * result rendering (ranking is applied by the caller via node-ranker).
 * No I/O, fully unit-testable.
 */
import type { IndexerNode } from "../../graph/code-queries.js";
import { rankNodes } from "../../graph/node-ranker.js";
import { denormalize } from "../qualified-name.js";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export function clampLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function clampOffset(offset?: number): number {
  if (offset === undefined) return 0;
  return Math.max(0, Math.floor(offset));
}

function formatLine(n: IndexerNode): string {
  return `${n.kind} ${denormalize(n.qualified_name, n.file_path)} (${n.file_path}:${n.start_line}-${n.end_line})`;
}

/** Rank `rows`, slice the [offset, offset+limit) window, and render a
 *  header + node lines. `suppressedSections` > 0 appends an opt-in hint. */
export function renderNodeSearch(
  rows: IndexerNode[],
  opts: { query?: string; limit: number; offset: number; suppressedSections: number },
): string {
  const total = rows.length;
  const ranked = rankNodes(rows, opts.query);
  const window = ranked.slice(opts.offset, opts.offset + opts.limit);
  const first = window.length === 0 ? 0 : opts.offset + 1;
  const last = opts.offset + window.length;
  const range = window.length === 0 ? "0" : `${first}–${last}`;
  let header = `showing ${range} of ${total} · offset ${opts.offset}`;
  if (opts.suppressedSections > 0) {
    header += ` · ${opts.suppressedSections} section nodes suppressed (pass kinds=["section"])`;
  }
  const body = window.map(formatLine).join("\n");
  return body ? `${header}\n${body}` : header;
}

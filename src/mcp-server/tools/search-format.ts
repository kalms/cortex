/**
 * Pure presentation helpers for the graph-lookup tools: input clamping, result
 * rendering (rank via node-ranker, slice the window, format lines), and the
 * shared miss hint. No I/O, fully unit-testable.
 */
import type { IndexerNode } from "../../graph/code-queries.js";
import { rankNodes } from "../../graph/node-ranker.js";
import { denormalize } from "../qualified-name.js";

// Re-exported for existing importers; the canonical home is the graph layer so
// the CLI can use them without depending on mcp-server.
export { clampLimit, clampOffset } from "../../graph/search-params.js";

/**
 * Routing prose for a *symbol-lookup* miss (search_graph, get_code_snippet,
 * context_pack, and trace_path's name-resolution step).
 *
 * A bare "No results" is ambiguous between "no such symbol", "the graph holds
 * no node for this shape", and "the index is behind" — and agents resolve that
 * ambiguity the expensive way. Observed twice on 2026-08-10: both read the miss
 * as a stale index, offered to re-run index_repository (which could not have
 * changed the result), and fell back to grep, when search_code answered
 * directly. So the hint names the next call, and points at the freshness line
 * as the actual staleness signal.
 *
 * A function, not a const, because the disclaimer is only sound while the
 * freshness signal is live. Under CORTEX_FRESHNESS=0 freshnessForContext()
 * returns `fresh` unconditionally and no ⚠ line is ever emitted, so "no line"
 * says nothing about the index — asserting currency there would manufacture
 * the very misdiagnosis this exists to prevent, on a genuinely stale graph.
 *
 * Even with the signal live the verdict is best-effort, not a guarantee, so the
 * wording stays hedged ("considers itself current", "unlikely"): gitDirtySig
 * hashes `git status --porcelain`, which is byte-identical when an
 * already-modified file is edited again, and freshnessForContext memoizes for
 * 2s — either can report `fresh` on a graph that is genuinely behind.
 *
 * Deliberately NOT attached to a miss where the symbol resolved and only the
 * edges came back empty (e.g. trace_path finding no callers) — there the graph
 * is answering, not failing, and search_code is no substitute for it.
 */
export function symbolMissHint(): string {
  const routing =
    "The graph holds named definitions, so a shape it carries no node for reads " +
    "exactly like a symbol that does not exist. To tell those apart, call " +
    'search_code(pattern="…") — the same indexed tree searched as text, with ' +
    "each hit annotated by its enclosing function or class.";
  if (process.env.CORTEX_FRESHNESS === "0") return routing;
  return (
    'Before concluding the index is stale, look for a "⚠ cortex freshness" line ' +
    "below — that is where staleness is reported. If none appears the graph " +
    "considers itself current, so re-indexing is unlikely to change this " +
    "result.\n" + routing
  );
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
  const page = ranked.slice(opts.offset, opts.offset + opts.limit);
  const first = page.length === 0 ? 0 : opts.offset + 1;
  const last = opts.offset + page.length;
  const range = page.length === 0 ? "0" : `${first}–${last}`;
  let header = `showing ${range} of ${total} · offset ${opts.offset}`;
  if (opts.suppressedSections > 0) {
    header += ` · ${opts.suppressedSections} section nodes suppressed (pass kinds=["section"])`;
  }
  const body = page.map(formatLine).join("\n");
  return body ? `${header}\n${body}` : header;
}

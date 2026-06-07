import type Database from "better-sqlite3";
import { readIndexMeta, type IndexMeta } from "../graph/index-meta.js";
import { isGitRepo, gitHead, gitDirtySig, gitCommitsBehind } from "../git/worktree-state.js";

export type FreshnessState =
  | "fresh" | "stale:commits" | "stale:dirty" | "stale:both" | "empty" | "unknown";

export interface Freshness {
  state: FreshnessState;
  commits_behind?: number;
  dirty?: boolean;
  indexed_at?: string;
  note?: string;
}

export interface ClassifyInput {
  canonical: boolean;
  nodeCount: number;
  meta: IndexMeta | null;
  isGit: boolean;
  curHead: string | null;
  curDirtySig: string | null;
  commitsBehind: number | null;
}

/** Pure freshness classifier — no I/O. */
export function classifyFreshness(i: ClassifyInput): Freshness {
  if (!i.canonical || i.nodeCount === 0) {
    return { state: "empty", note: "graph DB empty or degraded — reindex needed (index_repository)" };
  }
  if (!i.isGit) {
    return { state: "unknown", note: "not a git repository — freshness not tracked" };
  }
  if (!i.meta || i.meta.indexed_commit == null) {
    return { state: "unknown", indexed_at: i.meta?.indexed_at, note: "indexed before freshness tracking — reindex to enable" };
  }
  const headMoved = i.curHead !== i.meta.indexed_commit;
  const dirtyChanged = i.curDirtySig !== i.meta.indexed_dirty_sig;
  if (!headMoved && !dirtyChanged) {
    return { state: "fresh", indexed_at: i.meta.indexed_at };
  }
  const state: FreshnessState = headMoved && dirtyChanged ? "stale:both" : headMoved ? "stale:commits" : "stale:dirty";
  const f: Freshness = { state, dirty: dirtyChanged, indexed_at: i.meta.indexed_at };
  if (headMoved && i.commitsBehind != null) f.commits_behind = i.commitsBehind;
  f.note = noteFor(f);
  return f;
}

function noteFor(f: Freshness): string {
  const bits: string[] = [];
  if (f.commits_behind != null) bits.push(`${f.commits_behind} commit(s) since index`);
  else if (f.state === "stale:commits" || f.state === "stale:both") bits.push("HEAD moved since index");
  if (f.dirty) bits.push("uncommitted changes present");
  return `${bits.join("; ")} — results may be stale, reindex to refresh`;
}

// ── Memoized per-repo wrapper ────────────────────────────────────────────────
interface MemoEntry { value: Freshness; expiresAt: number; }
const memo = new Map<string, MemoEntry>();
const TTL_MS = 2000;

/** Drop the memoized freshness for a repo (call after index / detect_changes). */
export function invalidateFreshness(repoPath: string): void {
  memo.delete(repoPath);
}

/** Gather inputs (git + DB) and classify, memoized 2s per repo. `ctx` supplies
 *  the resolved DB + canonicity. Disabled (always fresh, no note) under
 *  CORTEX_FRESHNESS=0 so the attach path becomes a no-op. */
export function freshnessForContext(ctx: {
  repoPath: string;
  graphDb: Database.Database;
  canonical: boolean;
}): Freshness {
  if (process.env.CORTEX_FRESHNESS === "0") return { state: "fresh" };
  const now = Date.now();
  const hit = memo.get(ctx.repoPath);
  if (hit && hit.expiresAt > now) return hit.value;

  let nodeCount = 0;
  try {
    const row = ctx.graphDb.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number } | undefined;
    nodeCount = row?.n ?? 0;
  } catch { nodeCount = 0; }

  const meta = readIndexMeta(ctx.graphDb);
  const isGit = isGitRepo(ctx.repoPath);
  const curHead = isGit ? gitHead(ctx.repoPath) : null;
  const curDirtySig = isGit ? gitDirtySig(ctx.repoPath) : null;
  const commitsBehind = isGit && meta?.indexed_commit ? gitCommitsBehind(ctx.repoPath, meta.indexed_commit) : null;

  const value = classifyFreshness({ canonical: ctx.canonical, nodeCount, meta, isGit, curHead, curDirtySig, commitsBehind });
  memo.set(ctx.repoPath, { value, expiresAt: now + TTL_MS });
  return value;
}

type TextResult = { content: Array<{ type: string; text: string }>; [k: string]: unknown };

/** Attach a freshness verdict to an MCP text result. Returns the result
 *  UNCHANGED when fresh. When stale/empty/unknown, appends a one-line note to
 *  the first text block (always visible to the agent) and adds a structured
 *  `freshness` field. Mutates and returns the same object for non-fresh. */
export function attachFreshness<T extends TextResult>(result: T, f: Freshness): T {
  if (f.state === "fresh") return result;
  const line = `\n\n⚠ cortex freshness: ${f.state}${f.note ? ` — ${f.note}` : ""}`;
  const first = result.content?.find((c) => c.type === "text");
  if (first) first.text += line;
  (result as TextResult).freshness = f;
  return result;
}

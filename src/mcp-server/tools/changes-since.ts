/**
 * `changes_since` — the temporal layer (field-report P8, lean v1).
 *
 * Answers "what changed in this repo (or subsystem) since X, and how does
 * that relate to the decision layer?" in one call: bounded commit window +
 * affected graph nodes + decisions created / reconciled / governing the
 * changed code inside the window.
 *
 * `since` accepts three spellings:
 *   - a decision id (`D-xxxx`)  → window starts at that decision's capture
 *     time — directly answering "what moved since D-xxxx was decided, and
 *     does it still hold?"
 *   - an ISO date (`2026-07-01…`) → `git log --since=<date>`
 *   - any git ref (tag/branch/sha) → `<ref>..HEAD`
 *
 * Deliberately TS-side (no indexer round-trip, same stance as the
 * architecture hotspots aspect): git supplies the window, the graph DB
 * supplies node identity, the decisions sidecar supplies the why-layer.
 * Drift *judgment* stays with reconciliation — this tool only reports the
 * verdict-bearing display state alongside what changed.
 */
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { parseGitLogOutput } from "../../events/worker/git-log-parser.js";
import { displayState, refToFile } from "../../decisions/reconciliation.js";
import type { DecisionRecord } from "../../decisions/repository.js";
import { type RepoContext } from "../repo-context.js";
import { ok, error as errorResponse } from "../response.js";
import { execAction } from "./exec-action.js";
import { RepoPathField } from "./shared-fields.js";

export const changesSinceShape = {
  repo_path: RepoPathField,
  since: z.string().min(1).describe(
    "Window start: a git ref (tag/branch/sha), an ISO date (YYYY-MM-DD…), or a decision id (D-xxxx → that decision's capture time)"),
  scope: z.string().optional().describe("Repo-relative path prefix filter (e.g. src/mcp-server/)"),
  max_commits: z.number().int().positive().optional().describe("Commit cap (default 100)"),
} as const;
export const changesSinceSchema = z.object(changesSinceShape);

const DEFAULT_MAX_COMMITS = 100;
const MAX_AFFECTED_NODES = 200;
/** SQLite bind-parameter safety margin (hard limit is 999 in older builds). */
const IN_CHUNK = 500;

export interface SinceWindow {
  kind: "ref" | "date" | "decision";
  /** ISO timestamp (or date) the window opens at. */
  window_start: string;
  /** Present only for kind "ref": the `<ref>..HEAD` range git log should use. */
  range?: string;
}

/**
 * Resolve the `since` input to a window. Order matters: `D-` ids are never
 * valid refs, dates are cheap to detect, everything else must verify as a
 * commit — garbage throws instead of degrading to an unbounded window.
 */
export function resolveSinceWindow(
  repoPath: string,
  since: string,
  lookupDecision: (id: string) => Pick<DecisionRecord, "created_at"> | null,
): SinceWindow {
  if (/^D-/.test(since)) {
    const dec = lookupDecision(since);
    if (!dec) throw new Error(`unresolvable since: unknown decision ${since}`);
    return { kind: "decision", window_start: dec.created_at };
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(since) && !Number.isNaN(Date.parse(since))) {
    // Normalize to full UTC ISO so `git log --since` (which parses bare
    // dates in LOCAL time) and the sidecar timestamp comparisons agree.
    return { kind: "date", window_start: new Date(Date.parse(since)).toISOString() };
  }
  try {
    execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", "--verify", "--quiet", `${since}^{commit}`],
      { encoding: "utf-8" },
    );
  } catch {
    throw new Error(`unresolvable since: '${since}' is not a decision id, ISO date, or git ref`);
  }
  const refTime = execFileSync(
    "git",
    ["-C", repoPath, "show", "-s", "--format=%cI", `${since}^{commit}`],
    { encoding: "utf-8" },
  ).trim();
  // Normalize to UTC ISO — %cI carries the committer's local offset, which
  // must not leak into timestamp comparisons against sidecar UTC values.
  return { kind: "ref", window_start: new Date(refTime).toISOString(), range: `${since}..HEAD` };
}

export async function changesSinceAction(
  ctx: RepoContext,
  args: z.infer<typeof changesSinceSchema>,
) {
  return execAction(null, () => {
    let window: SinceWindow;
    try {
      window = resolveSinceWindow(ctx.repoPath, args.since, (id) => ctx.decisionsRepo.get(id));
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("unresolvable since")) {
        return errorResponse("malformed_input", e.message);
      }
      throw e;
    }

    // ── Commit window ────────────────────────────────────────────────────
    const cap = args.max_commits ?? DEFAULT_MAX_COMMITS;
    const selector = window.range ? [window.range] : [`--since=${window.window_start}`];
    // The scope rides as a git pathspec so `-n` counts SCOPE-MATCHING
    // commits — filtering after an unscoped cap would both hide in-scope
    // commits beyond the cap and let `truncated` under-report.
    const pathspec = args.scope ? ["--", args.scope] : [];
    // cap+1 so truncation is detectable without a second git call.
    const raw = execFileSync(
      "git",
      ["-C", ctx.repoPath, "log", `-n${cap + 1}`, ...selector,
        "--format=%H%x00%s%x00%an%x00%at", "--name-status", ...pathspec],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
    let parsed = parseGitLogOutput(raw);
    if (args.scope) {
      // Belt-and-braces on top of the pathspec, segment-aware so scope
      // "src" cannot match "src2/…".
      const p = args.scope.endsWith("/") ? args.scope.slice(0, -1) : args.scope;
      parsed = parsed
        .map((c) => ({ ...c, files: c.files.filter((f) => f.path === p || f.path.startsWith(`${p}/`)) }))
        .filter((c) => c.files.length > 0);
    }
    const truncated = parsed.length > cap;
    if (truncated) parsed = parsed.slice(0, cap);

    const commits = parsed.map((c) => ({
      sha: c.hash,
      subject: c.message,
      author: c.author,
      date: new Date(c.timestamp * 1000).toISOString(),
      files: c.files.map((f) => f.path),
    }));
    const changedFiles = [...new Set(parsed.flatMap((c) => c.files.map((f) => f.path)))].sort();

    // ── Affected graph nodes ─────────────────────────────────────────────
    const affectedNodes: Array<{ kind: string; name: string; qualified_name: string | null; file_path: string }> = [];
    for (let i = 0; i < changedFiles.length && affectedNodes.length < MAX_AFFECTED_NODES; i += IN_CHUNK) {
      const chunk = changedFiles.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = ctx.graphDb
        .prepare(
          `SELECT kind, name, qualified_name, file_path FROM nodes
           WHERE file_path IN (${placeholders})
             AND kind IN ('function','class','method','interface','route','module')
           LIMIT ?`,
        )
        .all(...chunk, MAX_AFFECTED_NODES - affectedNodes.length) as typeof affectedNodes;
      affectedNodes.push(...rows);
    }

    // ── Decision layer in the window ─────────────────────────────────────
    const all = ctx.decisionsRepo.list();
    const start = window.window_start;
    // Numeric comparison — sidecar timestamps are UTC ISO but `since` may be
    // a bare date; lexicographic >= would misorder mixed spellings.
    const startMs = Date.parse(start);
    const created = all
      .filter((d) => Date.parse(d.created_at) >= startMs)
      .map((d) => ({ id: d.id, title: d.title, status: d.status, created_at: d.created_at }));
    const reconciled = all
      .filter((d) => d.reconciled_at != null && Date.parse(d.reconciled_at) >= startMs)
      .map((d) => ({
        id: d.id, title: d.title,
        verdict: d.reconciliation_verdict ?? "unknown",
        reconciled_at: d.reconciled_at,
      }));

    const governingChanged: Array<{ id: string; title: string; display_state: string; matched_files: string[] }> = [];
    for (const d of all) {
      const links = ctx.decisionLinksRepo.findByDecision(d.id)
        .filter((l) => l.relation === "GOVERNS");
      const matched = new Set<string>();
      for (const l of links) {
        const file = refToFile(l);
        if (!file) continue;
        // A governed dir/file matches when any changed file sits under it.
        for (const cf of changedFiles) {
          if (cf === file || cf.startsWith(file.endsWith("/") ? file : `${file}/`)) matched.add(cf);
        }
      }
      if (matched.size > 0) {
        governingChanged.push({
          id: d.id,
          title: d.title,
          display_state: displayState(d.status, d.reconciliation_verdict),
          matched_files: [...matched].sort(),
        });
      }
    }

    return ok(JSON.stringify({
      since: { input: args.since, kind: window.kind, window_start: start },
      commits,
      truncated,
      changed_files: changedFiles,
      affected_nodes: affectedNodes,
      decisions: { created, reconciled, governing_changed: governingChanged },
    }, null, 2));
  });
}

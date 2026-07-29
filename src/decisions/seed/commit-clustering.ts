import { execFileSync } from "node:child_process";
import { parseGitLogOutput, ParsedCommit } from "../../events/worker/git-log-parser.js";
import type { DecisionCandidate } from "./types.js";

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
// Enough subjects per cluster for the LLM to infer intent without burying signal.
const EXCERPT_SUBJECTS = 12;

/** Throws unless `ref` names a commit in the repo. Callers pass user input
 *  (the warm-path `base`), so a typo must surface, not silently produce a
 *  whole-history manifest. */
export function assertValidRef(repoPath: string, ref: string): void {
  try {
    execFileSync(
      "git",
      ["-C", repoPath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      { encoding: "utf-8" },
    );
  } catch {
    throw new Error(`invalid base ref: ${ref}`);
  }
}

/** Run git log in the NUL-delimited format parseGitLogOutput expects. */
function readGitLog(repoPath: string, maxCommits: number, base?: string): ParsedCommit[] {
  // git log limit. Callers pass max_commits from FrameCandidatesOptions
  // (default 500). We clamp here so a careless caller can't blow past the
  // 64 MB maxBuffer below — at ~10 KB/commit average that ceiling is roughly
  // 6k commits; 5k leaves headroom.
  const cap = Math.min(Math.max(maxCommits, 0), 5000);
  const range = base ? [`${base}..HEAD`] : [];
  let raw = "";
  try {
    raw = execFileSync(
      "git",
      ["-C", repoPath, "log", `-n${cap}`, ...range, "--format=%H%x00%s%x00%an%x00%at", "--name-status"],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Genuinely-empty / not-a-git-repo cases: degrade silently.
    if (/not a git repository|does not have any commits|No such file|ENOENT/i.test(msg)) {
      return [];
    }
    // Anything else (maxBuffer overflow, OOM, corrupt repo) is data loss if we
    // swallow it — surface it on stderr so the seed flow doesn't silently
    // produce an empty manifest, then degrade.
    process.stderr.write(`cortex: commit-clustering: git log failed (${msg})\n`);
    return [];
  }
  return parseGitLogOutput(raw);
}

/** Bucket key: conventional-commit scope, else type, else "misc". */
function clusterKey(message: string): string {
  const m = message.match(CONVENTIONAL);
  if (!m) return "misc";
  const [, type, scope] = m;
  return scope ? scope : type;
}

/**
 * Cluster recent commits into low-confidence candidates grouped by
 * conventional-commit scope. Commit messages reliably signal *that* a
 * decision-worthy change happened and which files it touched; the LLM supplies
 * the rationale the messages lack.
 */
export function clusterCommitCandidates(repoPath: string, maxCommits: number, base?: string): DecisionCandidate[] {
  const commits = readGitLog(repoPath, maxCommits, base);
  const buckets = new Map<string, ParsedCommit[]>();
  for (const c of commits) {
    const key = clusterKey(c.message);
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(c);
  }

  const candidates: DecisionCandidate[] = [];
  for (const [scope, group] of buckets) {
    const shas = group.map((c) => c.hash);
    const files = [...new Set(group.flatMap((c) => c.files.map((f) => f.path)))].sort();
    const subjects = group.slice(0, EXCERPT_SUBJECTS).map((c) => `- ${c.message}`).join("\n");
    candidates.push({
      kind: "commit_cluster",
      confidence: "low",
      title_hint: `${scope}: ${group.length} commit${group.length === 1 ? "" : "s"}`,
      provenance: { commit_shas: shas, files_touched: files },
      raw_excerpt: subjects,
    });
  }
  return candidates;
}

import { execFileSync } from "node:child_process";
import { parseGitLogOutput, ParsedCommit } from "../../events/worker/git-log-parser.js";
import type { DecisionCandidate } from "./types.js";

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/;
const EXCERPT_SUBJECTS = 12;

/** Run git log in the NUL-delimited format parseGitLogOutput expects. */
function readGitLog(repoPath: string, maxCommits: number): ParsedCommit[] {
  let raw = "";
  try {
    raw = execFileSync(
      "git",
      ["-C", repoPath, "log", `-n${maxCommits}`, "--format=%H%x00%s%x00%an%x00%at", "--name-status"],
      { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return []; // no commits / not a git repo
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
export function clusterCommitCandidates(repoPath: string, maxCommits: number): DecisionCandidate[] {
  const commits = readGitLog(repoPath, maxCommits);
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

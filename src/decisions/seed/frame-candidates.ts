import { execFileSync } from "node:child_process";
import { discoverDocCandidates } from "./doc-discovery.js";
import { clusterCommitCandidates, assertValidRef } from "./commit-clustering.js";
import { DEFAULT_MAX_CANDIDATES, DEFAULT_MAX_COMMITS } from "./types.js";
import type { DecisionCandidate, FrameCandidatesOptions, Confidence } from "./types.js";

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** Cluster size proxy used to break ties within a confidence band. */
function weight(c: DecisionCandidate): number {
  return (c.provenance.commit_shas?.length ?? 0) + c.provenance.files_touched.length;
}

/**
 * Build the cold-start candidate manifest: discover doc candidates + cluster
 * commit history, rank by confidence then weight, and cap. This is the only
 * machine-derived step — the skill turns these into proposed decisions and
 * carries the provenance forward verbatim.
 */
export function frameCandidates(opts: FrameCandidatesOptions): DecisionCandidate[] {
  const max = opts.max_candidates ?? DEFAULT_MAX_CANDIDATES;
  const maxCommits = opts.max_commits ?? DEFAULT_MAX_COMMITS;

  // Warm path: scope docs to the base...HEAD diff so cold-start ADR noise
  // can't drown the merged branch's own decisions.
  let onlyDocs: ReadonlySet<string> | undefined;
  if (opts.base) {
    assertValidRef(opts.repo_path, opts.base);
    const diff = execFileSync(
      "git",
      ["-C", opts.repo_path, "diff", "--name-only", `${opts.base}...HEAD`],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
    );
    onlyDocs = new Set(diff.split("\n").filter((l) => l.length > 0));
  }

  const all: DecisionCandidate[] = [
    ...discoverDocCandidates(opts.repo_path, onlyDocs),
    ...clusterCommitCandidates(opts.repo_path, maxCommits, opts.base),
  ];

  all.sort((a, b) => {
    const byConf = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    return byConf !== 0 ? byConf : weight(b) - weight(a);
  });

  return all.slice(0, max);
}

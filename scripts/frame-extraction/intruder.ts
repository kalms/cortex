// scripts/frame-extraction/intruder.ts
/**
 * Pure construction of intruder-detection trials for offline label validation.
 *
 * Ground truth is cluster MEMBERSHIP (which the clustering already produced), not
 * a correct label. Each trial: a sample of one cluster's members + one intruder
 * drawn from a different cluster. A good label lets a reader exclude the intruder.
 *
 * No I/O, no LLM. `pick` is injectable for deterministic tests.
 */
import type { ClusterAssignment } from "../../src/frame-extraction/types.js";

export interface IntruderTrial {
  cluster_id: number;
  /** Sampled member paths of this cluster. */
  member_sample: string[];
  /** A path from a DIFFERENT cluster — the known correct answer. */
  intruder_path: string;
  /** member_sample + intruder, shuffled to remove positional bias. */
  candidates: string[];
}

/** Fisher-Yates shuffle over a copy of `arr`. Uses the same `pick` seam as
 *  intruder sampling so tests can verify position deterministically. */
function shuffle<T>(arr: T[], pick: (n: number) => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = pick(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface BuildIntruderOptions {
  membersPerTrial: number;
  /** Returns an index in [0, n). Defaults to Math.random-based. */
  pick?: (n: number) => number;
}

export function buildIntruderTrials(
  clusters: readonly ClusterAssignment[],
  opts: BuildIntruderOptions,
): IntruderTrial[] {
  const pick = opts.pick ?? ((n: number) => Math.floor(Math.random() * n));
  const real = clusters.filter((c) => c.cluster_id !== -1);
  const trials: IntruderTrial[] = [];
  for (const c of real) {
    if (c.member_paths.length < opts.membersPerTrial) continue;
    const others = real.filter((o) => o.cluster_id !== c.cluster_id);
    const intruderPool = others.flatMap((o) => o.member_paths);
    if (intruderPool.length === 0) continue;

    // First N members; the intruder is picked separately from other clusters.
    const member_sample = c.member_paths.slice(0, opts.membersPerTrial);
    const intruder_path = intruderPool[pick(intruderPool.length)]!;
    trials.push({
      cluster_id: c.cluster_id,
      member_sample,
      intruder_path,
      candidates: shuffle([...member_sample, intruder_path], pick),
    });
  }
  return trials;
}

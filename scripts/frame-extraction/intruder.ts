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
  /** member_sample + intruder, in a fixed order (intruder appended). */
  candidates: string[];
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

    const member_sample = [...c.member_paths]
      .slice(0, opts.membersPerTrial) // stable base; pick selects within if randomised
      .map((p) => p);
    const intruder_path = intruderPool[pick(intruderPool.length)]!;
    trials.push({
      cluster_id: c.cluster_id,
      member_sample,
      intruder_path,
      candidates: [...member_sample, intruder_path],
    });
  }
  return trials;
}

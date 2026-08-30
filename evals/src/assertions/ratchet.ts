import type { RatchetDirection, RatchetOutcome } from "./types.js";

/** Rate metrics are percentages 0-100 and tolerate small movement, because
 *  some graph passes are not bit-stable across runs (see todo T-48qt). */
export const RATE_EPSILON = 0.5;
/** Count metrics are exact — their definitions exclude nondeterministic
 *  edge types, so any movement is real. */
export const COUNT_EPSILON = 0;

/** Compare an observed value to its baseline. A metric fails only when it
 *  moves the wrong way by more than epsilon — being bad is not a failure,
 *  getting worse is. That is what lets one gate span languages whose graphs
 *  legitimately have different shapes. */
export function ratchet(
  observed: number,
  baseline: number | undefined,
  direction: RatchetDirection,
  epsilon: number,
): RatchetOutcome {
  if (baseline === undefined) return { status: "no_baseline", observed };

  const delta = observed - baseline;
  let worsened: boolean;
  let improved: boolean;
  switch (direction) {
    case "lower_is_better":
      worsened = delta > epsilon;
      improved = -delta > epsilon;
      break;
    case "higher_is_better":
      worsened = -delta > epsilon;
      improved = delta > epsilon;
      break;
    case "exact":
      // Any movement is a regression, so nothing is ever an improvement to
      // adopt — the baseline for an exact metric only changes by full recapture.
      worsened = Math.abs(delta) > epsilon;
      improved = false;
      break;
  }
  return worsened
    ? { status: "fail", observed, baseline, delta, improved: false }
    : { status: "pass", observed, baseline, delta, improved };
}

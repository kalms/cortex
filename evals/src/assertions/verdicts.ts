import { ratchet, RATE_EPSILON, COUNT_EPSILON } from "./ratchet.js";
import type { AssertionResult, Baseline, RatchetOutcome } from "./types.js";

/** Metrics expressed as percentages 0-100, which tolerate epsilon drift.
 *  Everything else is a count and compares exactly. */
export const RATE_METRICS = new Set([
  "call_attribution_rate",
  "orphan_definition_rate",
  "per_language_function_density",
]);

/** True for a per-language metric value: a plain object of numbers, as
 *  distinct from an array of rows or a tool-call `{ text }` result. */
export function isMetricMap(v: unknown): v is Record<string, number> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !("text" in (v as Record<string, unknown>))
  );
}

/** Attach a ratchet outcome to every universal result and derive `passed`
 *  from it. A universal metric has no predicate: being bad is not a failure,
 *  getting worse is, so the only honest verdict comes from this repo's own
 *  baseline. With no baseline there is nothing to judge and `passed` stays
 *  null rather than inventing an answer. */
export function applyRatchet(
  results: AssertionResult[],
  baseline: Baseline | null,
): AssertionResult[] {
  return results.map((r) => {
    if (r.assertion.scope !== "universal") return r;

    const name = r.assertion.name;
    const direction = r.assertion.direction ?? "exact";
    const epsilon = RATE_METRICS.has(name) ? RATE_EPSILON : COUNT_EPSILON;
    const baseValue = baseline?.per_assertion?.[name];

    if (isMetricMap(r.observed)) {
      const observedMap = r.observed;
      const baseMap = isMetricMap(baseValue) ? baseValue : undefined;
      const outcomes: Record<string, RatchetOutcome> = {};
      for (const key of Object.keys(observedMap)) {
        outcomes[key] = ratchet(observedMap[key]!, baseMap?.[key], direction, epsilon);
      }
      for (const key of Object.keys(baseMap ?? {})) {
        // A language the baseline saw and this run did not is extraction
        // collapsing to zero for that language, not an absent comparison.
        if (!(key in observedMap)) {
          outcomes[key] = ratchet(0, baseMap![key], direction, epsilon);
        }
      }
      const judged = Object.values(outcomes).filter((o) => o.status !== "no_baseline");
      const passed = judged.length === 0 ? null : judged.every((o) => o.status === "pass");
      return { ...r, ratchet: outcomes, passed, surprised: passed === false };
    }

    if (r.observed === null) {
      // Nothing to measure. Do not fall through to the numeric path: NaN
      // compares false against everything, which would silently read as a pass.
      return {
        ...r,
        ratchet: { status: "not_measured", observed: null },
        passed: null,
        surprised: false,
      };
    }

    const observedNum = typeof r.observed === "number" ? r.observed : Number.NaN;
    const outcome = ratchet(
      observedNum,
      typeof baseValue === "number" ? baseValue : undefined,
      direction,
      epsilon,
    );
    const passed = outcome.status === "no_baseline" ? null : outcome.status === "pass";
    return { ...r, ratchet: outcome, passed, surprised: passed === false };
  });
}

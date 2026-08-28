import { ratchet, RATE_EPSILON, COUNT_EPSILON } from "./ratchet.js";
import type { AssertionResult, Baseline, RatchetOutcome } from "./types.js";

/** Metrics expressed as percentages 0-100, which tolerate RATE_EPSILON
 *  percentage-point drift. Density is NOT in this set: it is callables-per-file,
 *  not a percentage, and needs a proportional tolerance instead — see
 *  DENSITY_TOLERANCE. Everything else not listed here is a count and
 *  compares exactly. */
export const RATE_METRICS = new Set(["call_attribution_rate", "orphan_definition_rate"]);

/** Density is callables-per-file, not a percentage, so a fixed tolerance is
 *  meaningless across languages: 0.5 is half of a typical density and would let
 *  a sparse language vanish entirely without failing. Each language is instead
 *  compared against 10% of its own baseline. */
export const DENSITY_TOLERANCE = 0.10;

/** True for a per-language metric VALUE: a plain object of numbers, as distinct
 *  from an array of rows. Callers must already know, from the assertion's query
 *  kind, that they are looking at a map metric — this only confirms the shape.
 *
 *  It deliberately does NOT try to exclude a tool-call `{ text }` result by
 *  looking for a `text` key. Map keys are file extensions harvested from
 *  arbitrary repositories, so one file named `*.text` produced a `text` key and
 *  made this return false for a perfectly good density map. */
export function isMetricMap(v: unknown): v is Record<string, number> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

    // Discriminate on the assertion, never on the value's shape: map keys are
    // file extensions from arbitrary repos and can forge any shape test. The
    // report and baseline modules discriminate the same way; all three must
    // agree or a metric can be judged one way and rendered another.
    const isDensity = r.assertion.query.kind === "language_density";

    if (isDensity && isMetricMap(r.observed)) {
      const observedMap = r.observed;
      const baseMap = isMetricMap(baseValue) ? baseValue : undefined;
      // A fixed epsilon is meaningless across languages of very different
      // magnitude, so density compares each language against 10% of that
      // language's own baseline instead of the shared RATE/COUNT epsilon.
      // A baseline of exactly 0 yields a tolerance of 0: any movement away
      // from 0 is judged exactly, which is correct — 0 -> something is an
      // improvement, and 0 -> 0 is stable.
      const epsilonFor = (base: number | undefined) =>
        isDensity && base !== undefined ? Math.abs(base) * DENSITY_TOLERANCE : epsilon;
      const outcomes: Record<string, RatchetOutcome> = {};
      for (const key of Object.keys(observedMap)) {
        outcomes[key] = ratchet(observedMap[key]!, baseMap?.[key], direction, epsilonFor(baseMap?.[key]));
      }
      for (const key of Object.keys(baseMap ?? {})) {
        // A language the baseline saw and this run did not is extraction
        // collapsing to zero for that language, not an absent comparison.
        if (!(key in observedMap)) {
          outcomes[key] = ratchet(0, baseMap![key], direction, epsilonFor(baseMap![key]));
        }
      }
      const judged = Object.values(outcomes).filter((o) => o.status !== "no_baseline");
      const passed = judged.length === 0 ? null : judged.every((o) => o.status === "pass");
      return { ...r, ratchet: outcomes, passed, surprised: passed === false };
    }

    if (typeof r.observed !== "number") {
      // Nothing to measure (null), or not a number and not a map (a string[]
      // or tool-call { text } observation on a universal assertion). Never
      // fall through to a NaN fallback: NaN compares false against
      // everything, so the ratchet would report a pass and an unmeasurable
      // metric would silently read as healthy — the same failure mode the
      // null case exists to close, entering through a second door.
      return {
        ...r,
        ratchet: { status: "not_measured", observed: null },
        passed: null,
        surprised: false,
      };
    }

    const outcome = ratchet(
      r.observed,
      typeof baseValue === "number" ? baseValue : undefined,
      direction,
      epsilon,
    );
    const passed = outcome.status === "no_baseline" ? null : outcome.status === "pass";
    return { ...r, ratchet: outcome, passed, surprised: passed === false };
  });
}

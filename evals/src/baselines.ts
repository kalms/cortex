import { isMetricMap } from "./assertions/verdicts.js";
import type { AssertionResult, Baseline, RatchetOutcome } from "./assertions/types.js";

/** Fold ratchet-confirmed improvements into a baseline, leaving every other
 *  value untouched. Only `improved` outcomes are adopted: a regression must
 *  never be absorbed, or the gate would erase the very failure it exists to
 *  report. Scorecard sections are not ratcheted and are copied verbatim.
 *
 *  `captured_at` is bumped because the file really was written now, while
 *  `source_sha` is deliberately left alone. After adoption the file is a
 *  per-metric high-water mark rather than a snapshot of one commit, and the
 *  sha still names the last full `--capture-baseline`. */
export function mergeImprovements(
  baseline: Baseline,
  results: AssertionResult[],
): { baseline: Baseline; adopted: string[] } {
  const per = { ...baseline.per_assertion };
  const adopted: string[] = [];

  for (const r of results) {
    const outcome = r.ratchet;
    if (!outcome) continue;
    const name = r.assertion.name;

    // Discriminate on the assertion, not on the shape of the value. Density map
    // keys are file extensions harvested from arbitrary repos, so a repo holding
    // a `*.status` file yields an outcome map with a key named "status" — which
    // a `"status" in outcome` test would read as a scalar outcome. Failing that
    // way is safe here (the metric is skipped, never mis-adopted), but report.ts
    // already guards the identical trap, and two files disagreeing about how to
    // tell a map from a scalar is how the guarded one later gets "simplified".
    if (r.assertion.query.kind !== "language_density") {
      if (outcome.status === "pass" && outcome.improved) {
        per[name] = outcome.observed;
        adopted.push(name);
      }
      continue;
    }

    // Discriminating on the assertion rather than on `"status" in outcome` costs
    // the type narrowing that check used to provide, so name the map shape here.
    const byKey = outcome as Record<string, RatchetOutcome>;
    const current = per[name];
    const merged: Record<string, number> = isMetricMap(current) ? { ...current } : {};
    let touched = false;
    for (const key of Object.keys(byKey).sort()) {
      const o: RatchetOutcome = byKey[key]!;
      if (o.status === "pass" && o.improved) {
        merged[key] = o.observed;
        adopted.push(`${name}.${key}`);
        touched = true;
      }
    }
    if (touched) per[name] = merged;
  }

  if (adopted.length === 0) return { baseline, adopted };
  return {
    baseline: { ...baseline, per_assertion: per, captured_at: new Date().toISOString() },
    adopted,
  };
}

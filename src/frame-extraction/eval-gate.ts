// src/frame-extraction/eval-gate.ts
/**
 * Regression gate for the frame-extraction label-quality metric.
 *
 * Compares a current eval run's per-repo weighted label-F1 against a committed
 * baseline and decides whether the run regressed. The design is shaped by one
 * hard constraint: **clustering is nondeterministic** (HDBSCAN gives run-to-run
 * variance; a repo can collapse to 0 clusters one run and cluster fine the
 * next). So the gate:
 *
 *   - compares the CORPUS MEAN over the repos common to both runs, not any
 *     single repo (averaging damps per-repo clustering swings);
 *   - EXCLUDES degenerate runs (cluster_count === 0, i.e. clustering collapsed)
 *     from the mean — their F1 of 0 measures clustering luck, not label quality
 *     — and surfaces them as warnings instead;
 *   - only ENFORCES a non-zero exit when enough repos overlap the baseline
 *     (`minReposToEnforce`), so a `--only`/partial run reports without the
 *     per-repo flakiness of a one-repo gate;
 *   - flags large single-repo drops as warnings (not failures).
 *
 * PURE module: rows in, verdict out. No I/O.
 */

export const F1_GATE_DEFAULTS = {
  /** Max allowed drop of the corpus-mean weighted F1 below the baseline mean. */
  regressionTolerance: 0.05,
  /** Corpus-mean weighted F1 must stay at or above this absolute floor. */
  absoluteFloor: 0.45,
  /** A per-repo F1 drop at least this large earns a warning (never a failure). */
  perRepoWarnDrop: 0.15,
  /** Minimum comparable repos before the pass/fail verdict is binding. */
  minReposToEnforce: 3,
};

export interface F1GateRow {
  slug: string;
  ok?: boolean;
  cluster_count?: number;
  label_f1_weighted?: number;
}

export interface F1GatePerRepo {
  slug: string;
  current: number;
  baseline: number;
  delta: number;
}

export interface F1GateResult {
  /** Whether the verdict is binding (>= minReposToEnforce comparable repos). */
  enforced: boolean;
  /** True if the run is acceptable. Always true when not enforced. */
  pass: boolean;
  /** Number of comparable (both-clustered) repos backing the means. */
  comparedRepos: number;
  currentMean: number | null;
  baselineMean: number | null;
  /** currentMean - baselineMean, or null when nothing is comparable. */
  delta: number | null;
  /** Binding failure reasons (empty unless enforced and regressed). */
  failures: string[];
  /** Non-binding notes: excluded repos, per-repo drops, downgraded failures. */
  warnings: string[];
  perRepo: F1GatePerRepo[];
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (x: number) => Math.round(x * 1000) / 1000;

export function evaluateF1Gate(
  current: readonly F1GateRow[],
  baseline: readonly F1GateRow[],
  opts: Partial<typeof F1_GATE_DEFAULTS> = {},
): F1GateResult {
  const cfg = { ...F1_GATE_DEFAULTS, ...opts };
  const warnings: string[] = [];
  const perRepo: F1GatePerRepo[] = [];

  const baseBySlug = new Map<string, F1GateRow>();
  for (const b of baseline) {
    if (b.ok !== false && isNum(b.label_f1_weighted)) baseBySlug.set(b.slug, b);
  }

  const currentVals: number[] = [];
  const baselineVals: number[] = [];

  for (const c of current) {
    if (c.ok === false || !isNum(c.label_f1_weighted)) continue;
    const b = baseBySlug.get(c.slug);
    if (!b || !isNum(b.label_f1_weighted)) continue;

    // Exclude degenerate clustering (0 clusters) on either side — not a label signal.
    if (c.cluster_count === 0 || b.cluster_count === 0) {
      warnings.push(
        `${c.slug}: excluded from gate (degenerate clustering — 0 clusters this run or in baseline)`,
      );
      continue;
    }

    const delta = c.label_f1_weighted - b.label_f1_weighted;
    perRepo.push({ slug: c.slug, current: round(c.label_f1_weighted), baseline: round(b.label_f1_weighted), delta: round(delta) });
    currentVals.push(c.label_f1_weighted);
    baselineVals.push(b.label_f1_weighted);
    if (delta <= -cfg.perRepoWarnDrop) {
      warnings.push(`${c.slug}: weighted F1 dropped ${round(-delta)} (${round(b.label_f1_weighted)} → ${round(c.label_f1_weighted)})`);
    }
  }

  const comparedRepos = currentVals.length;
  if (comparedRepos === 0) {
    warnings.push("no repos comparable to the baseline (no overlap or all degenerate) — gate not evaluated");
    return { enforced: false, pass: true, comparedRepos: 0, currentMean: null, baselineMean: null, delta: null, failures: [], warnings, perRepo };
  }

  const currentMean = mean(currentVals);
  const baselineMean = mean(baselineVals);
  const delta = currentMean - baselineMean;

  const wouldFail: string[] = [];
  if (delta < -cfg.regressionTolerance) {
    wouldFail.push(`corpus mean weighted F1 regressed ${round(-delta)} (${round(baselineMean)} → ${round(currentMean)}), exceeding tolerance ${cfg.regressionTolerance}`);
  }
  if (currentMean < cfg.absoluteFloor) {
    wouldFail.push(`corpus mean weighted F1 ${round(currentMean)} is below the absolute floor ${cfg.absoluteFloor}`);
  }

  const enforced = comparedRepos >= cfg.minReposToEnforce;
  let failures: string[] = [];
  if (enforced) {
    failures = wouldFail;
  } else if (wouldFail.length > 0) {
    // Not enough repos to bind the verdict — keep the signal visible as warnings.
    warnings.push(...wouldFail.map((f) => `(not enforced, ${comparedRepos}/${cfg.minReposToEnforce} repos) ${f}`));
  }

  return {
    enforced,
    pass: failures.length === 0,
    comparedRepos,
    currentMean: round(currentMean),
    baselineMean: round(baselineMean),
    delta: round(delta),
    failures,
    warnings,
    perRepo,
  };
}

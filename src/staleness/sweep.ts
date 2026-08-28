import { hashGovernedSource, refToFile, resolveGovernedRefs, type GovernedRef } from "../decisions/reconciliation.js";
import type { StaleRow, StalenessReport, SweepInput } from "./types.js";

/**
 * The index-time staleness sweep (spec §C2).
 *
 * READ-ONLY with respect to the authored store. It takes already-loaded rows,
 * reads the filesystem, and returns a report. It MUST NOT write to any
 * decision, todo or story row — triage only (§C5): a stale row's remedy is a
 * human/agent judgment, and a row from abandoned work is still true history.
 * Taking rows as data rather than repositories is what makes that structural
 * instead of a rule someone has to remember.
 *
 * Three populations, three treatments:
 *
 *   basis_hash IS NULL           counted, NEVER itemized. ~170 pre-existing
 *                                rows have no reference point and none can be
 *                                manufactured. Itemizing them is wallpaper,
 *                                and a channel that cries wolf once is ignored
 *                                permanently.
 *   basis_hash !== current       the basis moved since authoring — itemizable.
 *   reconciled_source_hash       the verdict went stale — itemizable.
 *     !== current (non-null)
 *
 * Itemization is then SCOPED to rows whose governed refs intersect the files
 * that changed since the last index — after a merge, exactly the rows the
 * merge touched. Everything else is counted as `outstanding`. With no previous
 * index or no answerable diff, NOTHING is itemized.
 *
 * The `differs` half of a hash comparison proves nothing on its own (a reformat
 * fires as hard as a real basis shift), so this produces a queue of QUESTIONS,
 * never of findings.
 */
export function sweepStaleness(input: SweepInput): StalenessReport {
  const concluded = concludedBranches(input.originBranches, input.knownBranches);
  const concludedSet = new Set(concluded);

  const itemized: StaleRow[] = [];
  /** Every flagged row, INCLUDING those the changed-file scope excludes from
   *  itemization. Orphan detection reads this, not `itemized` — see below. */
  const flagged: StaleRow[] = [];
  let noReferencePoint = 0;
  let basisMoved = 0;
  let verdictStale = 0;
  let flaggedRows = 0; // rows, not reasons — a row flagged for both counts once

  for (const c of input.candidates) {
    if (!c.status_active) continue;
    if (c.refs.length === 0) continue;                  // declarative — nothing to compare
    if (c.basis_hash == null) { noReferencePoint++; continue; }

    const current = hashGovernedSource(input.repoPath, c.refs);

    // A verdict recorded against THIS EXACT TREE settles the row, whatever the
    // basis says. Reconciliation moves `basis_hash` only on `match` (recording
    // `drift` must not adopt divergent code as the new baseline), so without
    // this guard an honestly-judged `drift` row would be re-flagged on every
    // index and every read, forever — the row would be un-silenceable except
    // by recording a `match` nobody believes. That is the "cries wolf once and
    // is ignored permanently" failure this design exists to prevent, arriving
    // through a different door. Judged-at-this-tree means someone has looked.
    if (c.reconciled_source_hash != null && c.reconciled_source_hash === current) continue;

    const movedBasis = current !== c.basis_hash;
    // A todo is never reconciled, so its reconciled_source_hash is always null
    // and this half can never fire for one.
    const staleVerdict = c.reconciled_source_hash != null && current !== c.reconciled_source_hash;
    if (!movedBasis && !staleVerdict) continue;

    if (movedBasis) basisMoved++;
    if (staleVerdict) verdictStale++;
    flaggedRows++;

    const unresolved = resolveGovernedRefs(input.repoPath, c.refs)
      .filter((r) => r.state !== "resolved")
      .map((r) => r.ref.target_ref);
    flagged.push({
      kind: c.kind,
      id: c.id,
      title: c.title,
      reason: movedBasis ? "basis_moved" : "verdict_stale",
      origin_branch: c.origin_branch,
      origin_commit: c.origin_commit,
      origin_thread: c.origin_thread,
      branch_concluded: c.origin_branch != null && concludedSet.has(c.origin_branch),
      unresolved_refs: unresolved,
    });
    if (touchesChangedFile(input, c.refs)) itemized.push(flagged[flagged.length - 1]);
  }

  // Orphaned = the branch is gone AND at least one governed ref is unresolvable.
  // Neither half supports that conclusion alone (§C4): a concluded branch
  // usually means the work LANDED, which is fine. This is still triage — the
  // row is reported, never touched.
  // Computed over ALL flagged rows, never over `itemized`. An orphan's governed
  // file typically does not exist, so it can never appear in a git diff or
  // status — scoping orphan detection to the changed-file set would make it
  // permanently empty for exactly the population it was designed to find.
  // This is a list, not an itemization, so it carries no wallpaper risk.
  const orphaned = flagged
    .filter((r) => r.branch_concluded && r.unresolved_refs.length > 0 && r.origin_branch != null)
    .map((r) => ({ kind: r.kind, id: r.id, origin_branch: r.origin_branch as string }));

  return {
    version: 1,
    swept_at: input.now().toISOString(),
    repo_path: input.repoPath,
    head_commit: input.headCommit,
    since_commit: input.sinceCommit,
    itemized,
    counts: {
      no_reference_point: noReferencePoint,
      basis_moved: basisMoved,
      verdict_stale: verdictStale,
      itemized: itemized.length,
      outstanding: flaggedRows - itemized.length,
    },
    concluded_branches: concluded,
    orphaned,
  };
}

/**
 * True when at least one governed ref maps into `changedFiles`.
 *
 * `sinceCommit === null` (first index) or `changedFiles === null` (git could
 * not answer) both mean there is no "newly changed" set at all, so nothing is
 * itemized. Do not "fix" this by falling back to itemizing everything: a first
 * sweep that dumped the whole backlog is the wallpaper failure §C2 names.
 */
function touchesChangedFile(input: SweepInput, refs: GovernedRef[]): boolean {
  if (input.sinceCommit == null || input.changedFiles == null) return false;
  for (const ref of refs) {
    const rel = refToFile(ref);
    if (rel == null) continue;
    if (input.changedFiles.has(rel)) return true;
    // A directory ref governs its whole subtree, matching hashGovernedSource's
    // hashDir walk — any changed file beneath it counts.
    const prefix = rel.endsWith("/") ? rel : rel + "/";
    for (const f of input.changedFiles) if (f.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * §C4: branch names the store remembers that git no longer knows — neither as a
 * local head nor as a remote-tracking ref. Recomputed from scratch every sweep,
 * so it is idempotent and order-independent, and independent of whether the
 * worktree was ever indexed: the branch is the key, not the registry row.
 * Missing a sweep is harmless; the next one catches it.
 *
 * `known === null` (no git) yields the empty set — "unable to tell" is never
 * "concluded". A stale fetch can also make a live branch look concluded, which
 * is precisely why §C5 forbids acting on this signal automatically.
 */
export function concludedBranches(origins: string[], known: Set<string> | null): string[] {
  if (known == null) return [];
  return [...new Set(origins)].filter((b) => b && !known.has(b)).sort();
}

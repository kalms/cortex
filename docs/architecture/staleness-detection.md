# Index-time staleness detection

How Cortex notices that authored content — decisions, todos — no longer
describes the code it governs, and why the answer is a queue of *questions*
rather than a list of findings.

Implements Part C of the git-provenance design. Requires the reference points
Part B captures; see [decisions-storage.md](decisions-storage.md) and
[graph-storage.md](graph-storage.md#two-axes) for the two-axis model this rests on.

## What the basis hash proves, and what it does not

`hashGovernedSource` fingerprints exactly the files a row claims to govern, at
one moment, against one tree. Comparing a stored fingerprint to a fresh one is
**asymmetric**, and conflating the two halves is the main way to misuse it:

| Result | Meaning |
|---|---|
| **equal** | The governed code is byte-identical to the reference point. Whatever accuracy the row had then, it still has. **Sound.** |
| **differs** | Something moved underneath it. Could be a real basis shift, could be a reformat. **Proves nothing.** |

So the hash is **not a staleness detector**. It is a *"nothing changed
underneath this"* certificate, and its value lies in the rows it lets you
**skip**. Inverting it produces questions; a human or agent answers them by
recording a verdict (`match` / `partial` / `drift`).

## The three populations

A naive sweep reports nearly every row as drifted, because a never-reconciled
row's `reconciled_source_hash` is NULL and NULL never equals a hash. That is
wallpaper, and a channel that cries wolf once is ignored permanently. The sweep
separates:

| Population | Test | Treatment |
|---|---|---|
| No reference point | `basis_hash IS NULL` | **count only, never itemize** — a backlog, not news |
| Basis moved since authoring | `basis_hash` ≠ current | **itemize** |
| Verdict went stale | `reconciled_source_hash` ≠ current, non-NULL | **itemize** |

Itemization is scoped further: a flagged row is itemized only when one of its
governed refs is among the files that changed **since the last index**. After a
merge that is exactly the rows the merge touched. Everything else is counted as
`outstanding`. With no previous index — or when git cannot answer, e.g. the
baseline commit was rebased away — **nothing is itemized at all**.

**A verdict recorded against the current tree settles a row**, whatever its
basis says. Reconciliation moves `basis_hash` only on a `match` verdict —
recording `drift` must not adopt divergent code as the new baseline — so
without this rule an honestly-judged `drift` row would be re-flagged on every
index and every read forever, silenceable only by recording a `match` nobody
believes. "Judged against this tree" means someone has looked.

`basis_hash IS NULL` rows are never backfilled. NULL means *unknowable*, not
*unchanged*; a fabricated reference point would certify every historical row as
clean in one stroke.

## The ordering contract

`runStalenessSweep` reads the **previous** index's `indexed_commit` to scope
itemization. `captureIndexMeta` overwrites exactly that value with the current
HEAD. **The sweep must therefore run before it** — at all three call sites (the
CLI index path and both MCP paths). Reversed, every sweep compares HEAD against
HEAD and itemizes nothing, forever, with no error and no output to notice.

This works because `cortex_index_meta` is a **live-only** table:
`publishStagedDb` replaces only tables present in staging, so the freshness
baseline survives the publish untouched — the omission is the preservation. A
regression test in `tests/staleness/index-wiring.test.ts` pins that property,
because the ordering contract silently stops working if it ever changes.

## Three surfaces, one computation

Computed once at index time, surfaced where it will actually be read:

| Channel | Reach | Role |
|---|---|---|
| Index stdout | whoever ran it; auto-index runs detached | one bounded line, only when there is news |
| SessionStart hook | terminal + agent context, every new session | `cortex staleness` headline |
| **Briefing on code reads** | in-context, at the moment the governed symbol is read | **the one that changes agent behaviour** — it re-fires until the row is judged |

The briefing line is the important one, for the same reason the existing
briefing signal works: it arrives when you are about to edit the thing, and it
comes back every time until someone resolves it. A `match` verdict whose basis
has moved still escalates — that row is precisely the one that reads clean
while being wrong.

The report itself is JSON at `<checkout>/.cortex/staleness.json`: checkout-
scoped, gitignored, disposable, rebuilt by every index. Read it with
`cortex staleness --json`.

**Todos have no read-time surface.** The briefing keys on a governing decision,
and a todo has no equivalent lookup path. A todo whose basis moved appears in
the index line and the session headline only.

## Branch conclusion — a weaker, second signal

Detecting that a worktree's work has finished needs no event hook, which
matters because none is reliable: `git worktree remove`, `prune`, and `rm -rf`
are all unobservable, and a crashed session observes nothing. Instead, a set
difference recomputed from scratch on every sweep:

```
concluded = {distinct origin_branch across decisions + todos + stories}
          − ({local heads} ∪ {remote-tracking branches})
```

Idempotent, order-independent, and independent of whether the worktree was ever
indexed — the branch is the key, not a registry row. Missing a sweep is
harmless; the next one catches it. Stories contribute here and nowhere else:
they carry an origin branch but govern nothing, so they have no basis to check.

**Weak alone.** A concluded branch usually means the work *landed*, which is
fine. Combined with unresolvable governed refs it is strong: branch gone **and**
refs missing means the work never landed and the row is orphaned. Neither half
supports that conclusion by itself.

## Triage only

The sweep performs **no state changes and no deletions, for any entity type** —
including rows whose branch is gone and whose refs are unresolvable. This is
enforced structurally: `sweepStaleness` takes flattened rows as data rather than
repositories, so it has nothing to write through.

- A decision from abandoned work is still true history. "We considered X and
  dropped it" is often the most valuable row in the store; deleting it destroys
  the record of *why*.
- A stale todo's remedy is a state transition, which a human ratifies via
  `todo({action:"transition"})`.

One caveat on "mutates nothing": `sweepStaleness` is structurally incapable of
writing, but the runner reaches the store through `openDecisionsDb`, which
performs schema migration, legacy relocation and a backup snapshot. None of
those touch row *content*, but it does mean `cortex index` can now trigger a
store migration as a side effect, inside the index lock.

Two properties make this safe rather than lazy: the authored store lives outside
the repo, so no prune can destroy content; and a stale fetch can make a live
branch look concluded, so acting automatically on the branch signal would mean
acting on a false positive.

## Limits

- **The hash detects change, not staleness.** A reformat fires as hard as a real
  basis shift. It forces the question; it cannot answer it.
- **Link quality is the ceiling.** If a decision governs `src/foo.ts` but what
  invalidated it was an unlinked change in `src/bar.ts`, the hash comes back
  equal and the row reads clean while being wrong. The sound negative is sound
  *relative to the declared governs set*, not absolutely.
- **Detection, not prevention.** The merge has already happened when the flag
  appears. Blocking a merge on a basis change was considered and rejected: the
  store is machine-local so CI cannot see it, and the change is often
  legitimate.
- **Pre-existing rows can never be compared.** Rows authored before Part B have
  no reference point and none can be manufactured. They are counted forever and
  itemized never.
- **A remote `gh pr merge` triggers no local reindex.** The flag appears at the
  next index in the local checkout — the first moment it matters, but not
  immediately.
- **One verdict per decision.** A verdict computed on branch X still overwrites
  one computed on `main`.
- **Switching branches produces a burst.** The changed-file scope is a
  two-endpoint diff (`<previous indexed commit>..HEAD`), not a "since" walk. If
  a checkout is indexed on a long-lived branch and then reindexed on `main`,
  the scope is the whole cross-branch delta and every decision governing those
  files is itemized at once. Not wrong — those rows' bases genuinely differ
  from the tree they are being compared against — but it is a burst of
  low-value questions in the channel this design most wants to keep credible.
- **Directory refs are not cheap on the read path.** `hashGovernedSource` walks
  a directory ref's whole subtree with no gitignore awareness, and the briefing
  now does this on gated reads. Most governed refs in practice are directories.
  A decision governing a directory that contains build output makes every gated
  read walk it, and a stray untracked file there flips the row to "moved" with
  no matching entry in the changed-file set. Hashes are memoized per ref-set
  within a single briefing, which bounds it across several governing decisions
  but not across calls.

## Gates

`CORTEX_STALENESS=0` disables the sweep and every surface it feeds.
`CORTEX_BRIEF=0` independently silences the briefing line.

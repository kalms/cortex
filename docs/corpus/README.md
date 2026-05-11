# Corpus survey

Phase 1 calibration data for frame extraction (see
[`docs/specs/cortex-v0.3/frame-extraction.md`](../specs/cortex-v0.3/frame-extraction.md)).

For each repo in the survey:

- `entity_count` — code entities (nodes excluding `decision`, `pr`, `todo` kinds)
- `edge_count` — total edges in the project's slice of the graph
- `edge_density` — `edges / entities`
- `file_count` — distinct file paths the indexer touched
- `directory_depth_max` / `_p50` — depth of nested paths
- `language_mix` — file-extension ratio (heuristic; missing-extension files
  show as `<none>`)
- `kind_mix` — raw counts per node `kind`

## Running

```bash
npx tsx scripts/corpus/run-survey.ts
```

The runner is idempotent — re-running replaces entries for the same slug.
Clones land in `~/.cache/cortex-corpus/` and are deleted after each repo's
stats are extracted; the content-hash cache at `~/.cache/cortex/<key>.db`
preserves the index for cheap re-runs.

## Adding repos

Edit the `BATCH` constant in `scripts/corpus/run-survey.ts`. Each entry takes:

- `slug` — `owner/name`
- `url` — `https://github.com/owner/name`
- `archetype` — short label for the archetype (e.g. `ts-tooling`,
  `research-notebook`, `rails-app`, `monorepo-js-turbo`, …)
- `notes` — free-form context (size, why this archetype, what's notable)

## Output

`results.json` — machine-readable, committed to the repo. It's the
calibration dataset frame-extraction tunes against; small enough to track
in git.

## Open issues

- `path.extname` over-grabs single-character extensions on multi-dot
  filenames like `appendix-1.5.md`. Fix when broadening the stats surface
  (the spec's `(entity_count, edge_density, directory_depth, language_mix)`
  is the bare minimum — co-change matrix and other Phase-2 inputs land in
  later batches).

---
name: seed-decisions
description: Bootstrap an empty decision store on cold start. Use when a repo is freshly indexed and has zero decisions (the check-index hook prompts this), to propose decisions framed from git history and documentation for human ratification.
---

# Seed Decisions (cold start)

Bootstrap `decisions.db` from existing git history and docs. Every decision you
create is `proposed` and carries machine-derived provenance — **nothing becomes
`active` without the user approving it.**

## Step 1: Frame candidates (deterministic, read-only)

Call the MCP tool — it parses git + docs and returns a compact manifest. Do NOT
read raw `git log` yourself; the manifest already carries source SHAs/doc paths.

```
decision({ action: "candidates", max_candidates: 20 })
```

Each candidate has `kind` (adr | prose | commit_cluster), `confidence`,
`title_hint`, `provenance` (doc_path / commit_shas / files_touched), and a
`raw_excerpt`.

## Step 2: Dedupe

For each candidate, before proposing, check for an existing decision:

```
decision({ action: "search", query: "<keywords from title_hint / excerpt>" })
```

Skip candidates already covered. On a re-run, only net-new candidates should be
proposed.

## Step 3: Author proposed decisions

The candidate `kind` maps to `provenance.source` as: `adr` → `"adr"`, `prose` → `"prose"`, `commit_cluster` → `"commits"`. The MCP tool's Zod schema accepts only those three source values.

Use judgment: a candidate may be one decision or several; merge or split as the
evidence warrants. Be conservative — do not invent alternatives the source
doesn't support.

- **adr (high confidence):** lift problem / rationale / alternatives close to
  verbatim from the doc.
- **prose / commit_cluster (medium/low):** summarize; keep claims tied to the excerpt.

Create each via `decision({action:"propose"})`, forwarding provenance and the seed marker:

```
decision({
  action: "propose",
  title, problem, resolution, rationale,
  alternatives: [...],                // only if evidenced
  governs: [<files_touched, resolved to qualified names where precise>],
  references: [<provenance.doc_path>], // for adr/prose
  author: "cortex:seed",
  provenance: { source, doc_path?, commit_shas?, confidence }
})
```

Resolve `files_touched` to qualified names with `search_graph` / `search_code`
when a precise symbol is warranted; otherwise link the file path.

## Step 4: Present the batch for ratification

List what you proposed as a numbered table: `title · confidence · provenance`.
Ask the user which to keep. Then:

- **Approved →** `decision({ action: "update", id, status: "active" })`
- **Unapproved →** `decision({ action: "delete", id })` by default (a graveyard of stale
  `proposed` records erodes trust). Keep as `proposed` only if the user asks.

Never promote to `active` without explicit approval.
